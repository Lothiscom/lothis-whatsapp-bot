import express from "express";
import Database from "better-sqlite3";
import fetch from "node-fetch";

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID || !WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error("Missing env vars. Need OPENAI_API_KEY, OPENAI_ASSISTANT_ID, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---------- DB (wa_id -> thread_id + language) ----------
const db = new Database("lothis.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    chat_id    TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL,
    language   TEXT,
    updated_at INTEGER NOT NULL
  );
`);

const getThread = db.prepare("SELECT thread_id, language FROM threads WHERE chat_id = ?");
const upsertThread = db.prepare(`
  INSERT INTO threads (chat_id, thread_id, language, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    thread_id  = excluded.thread_id,
    language   = COALESCE(excluded.language, threads.language),
    updated_at = excluded.updated_at
`);
const setLanguage = db.prepare(`UPDATE threads SET language = ? WHERE chat_id = ?`);
const getLanguage = db.prepare(`SELECT language FROM threads WHERE chat_id = ?`);

// ---------- WhatsApp send helper ----------
async function waSendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    })
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("WhatsApp send failed:", res.status, t);
  }
}

// ---------- OpenAI Assistants v2 helpers (zelfde als Telegram) ----------
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2"
};

async function openaiCreateThread() {
  const res = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({})
  });
  if (!res.ok) throw new Error(`Create thread failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiAddUserMessage(threadId, content) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({ role: "user", content })
  });
  if (!res.ok) throw new Error(`Add message failed: ${res.status} ${await res.text()}`);
}

async function openaiRun(threadId, lang) {
  const body = lang
    ? { assistant_id: OPENAI_ASSISTANT_ID, instructions: `Respond in language: ${lang}` }
    : { assistant_id: OPENAI_ASSISTANT_ID };

  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Run failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiPollRun(threadId, runId, maxMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
      method: "GET",
      headers: OPENAI_HEADERS
    });
    if (!res.ok) throw new Error(`Poll failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    const status = json.status;
    if (status === "completed") return "completed";
    if (status === "failed" || status === "cancelled" || status === "expired") return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
}

async function openaiGetLastAssistantText(threadId) {
  const res = await fetch(
    `https://api.openai.com/v1/threads/${threadId}/messages?limit=10&order=desc`,
    { method: "GET", headers: OPENAI_HEADERS }
  );
  if (!res.ok) throw new Error(`Get messages failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  const msg = (json.data || []).find((m) => m.role === "assistant");
  if (!msg || !Array.isArray(msg.content)) return "";
  let out = "";
  for (const block of msg.content) {
    if (block?.type === "text" && block?.text?.value) out += block.text.value;
  }
  return out.trim();
}

async function lothisReply(chatId, userText) {
  let row = getThread.get(String(chatId));
  let threadId = row?.thread_id;
  const existingLang = row?.language || null;

  if (!threadId) {
    threadId = await openaiCreateThread();
    upsertThread.run(String(chatId), threadId, existingLang, Date.now());
  }

  const lang = existingLang || getLanguage.get(String(chatId))?.language || null;
  const content = lang ? `[LANG:${lang}] ${userText}` : userText;

  await openaiAddUserMessage(threadId, content);
  const runId = await openaiRun(threadId, lang);
  const status = await openaiPollRun(threadId, runId);

  if (status !== "completed") {
    return "I’m having a brief hiccup. Please try again in a moment.";
  }

  const text = await openaiGetLastAssistantText(threadId);
  return text || "I heard you, but didn’t get a good reply back. Can you try again?";
}

// ---------- WhatsApp Webhook VERIFY (GET) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- WhatsApp Webhook (POST) ----------
app.post("/webhook", async (req, res) => {
  // WhatsApp expects fast 200
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const waId = msg.from;
    const text = msg.text?.body?.trim();
    if (!waId || !text) return;

    // (optioneel later) taal-set commando’s
    // if (text === "/nl") { setLanguage.run("nl", String(waId)); return waSendText(waId, "✅ Nederlands ingesteld."); }

    const reply = await lothisReply(waId, text);
    await waSendText(waId, reply);
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
  }
});

// ---------- Health & root ----------
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("Lothis WhatsApp Bot is running ✨"));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis WhatsApp Bot running on :${PORT}`);
});
