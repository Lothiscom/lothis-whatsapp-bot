import express from "express";
import Database from "better-sqlite3";
import fetch from "node-fetch";

/* =========================
   ENV
========================= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// optional (handig tegen dubbele retries)
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// (optioneel) basis website link
const WEBSITE_URL = process.env.WEBSITE_URL || "https://lothis.com";

if (
  !OPENAI_API_KEY ||
  !OPENAI_ASSISTANT_ID ||
  !WHATSAPP_TOKEN ||
  !WHATSAPP_PHONE_NUMBER_ID ||
  !VERIFY_TOKEN
) {
  console.error(
    "Missing env vars. Need OPENAI_API_KEY, OPENAI_ASSISTANT_ID, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, VERIFY_TOKEN"
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
   DB (wa_id -> thread_id + language)
========================= */
const db = new Database("lothis.sqlite");

db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    chat_id    TEXT PRIMARY KEY,
    thread_id  TEXT NOT NULL,
    language   TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seen_messages (
    msg_id     TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
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

const seenMsg = db.prepare("SELECT 1 FROM seen_messages WHERE msg_id = ?");
const markSeen = db.prepare("INSERT INTO seen_messages (msg_id, created_at) VALUES (?, ?)");

/* =========================
   WhatsApp helpers
========================= */
async function waSendText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("WhatsApp send failed:", res.status, t);
  }
}

function helpText(lang) {
  if (lang === "nl") {
    return [
      "Welkom bij Lothis 👋",
      "",
      "Commands:",
      "• /start  — intro",
      "• /lang   — kies taal (nl/en/de)",
      "• /nl /en /de — zet taal direct",
      "",
      `Meer info: ${WEBSITE_URL}`,
    ].join("\n");
  }
  if (lang === "de") {
    return [
      "Willkommen bei Lothis 👋",
      "",
      "Commands:",
      "• /start — intro",
      "• /lang  — Sprache wählen (nl/en/de)",
      "• /nl /en /de — Sprache direkt setzen",
      "",
      `Mehr Info: ${WEBSITE_URL}`,
    ].join("\n");
  }
  return [
    "Welcome to Lothis 👋",
    "",
    "Commands:",
    "• /start — intro",
    "• /lang  — choose language (nl/en/de)",
    "• /nl /en /de — set language directly",
    "",
    `More info: ${WEBSITE_URL}`,
  ].join("\n");
}

/* =========================
   OpenAI Assistants v2 helpers (zelfde stijl als Telegram)
========================= */
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

async function openaiCreateThread() {
  const res = await fetch("https://api.openai.com/v1/threads", {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Create thread failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.id;
}

async function openaiAddUserMessage(threadId, content) {
  const res = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: "POST",
    headers: OPENAI_HEADERS,
    body: JSON.stringify({ role: "user", content }),
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
    body: JSON.stringify(body),
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
      headers: OPENAI_HEADERS,
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
    return lang === "nl"
      ? "Ik ben er heel even niet lekker doorheen. Probeer het zo nog een keer."
      : "I’m having a brief hiccup. Please try again in a moment.";
  }

  const text = await openaiGetLastAssistantText(threadId);
  return text || (lang === "nl" ? "Wil je dat nog een keer zeggen?" : "Can you try again?");
}

/* =========================
   WhatsApp Webhook VERIFY (GET)
========================= */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* =========================
   WhatsApp Webhook (POST)
========================= */
app.post("/webhook", async (req, res) => {
  // WhatsApp verwacht snelle 200 OK
  res.sendStatus(200);

  try {
    // optioneel: simpele shared secret check (niet verplicht)
    if (WEBHOOK_SECRET && req.query?.secret !== WEBHOOK_SECRET) {
      // niet loggen, gewoon stil droppen
      return;
    }

    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    // dedupe
    if (msg.id && seenMsg.get(String(msg.id))) return;
    if (msg.id) markSeen.run(String(msg.id), Date.now());

    const waId = msg.from;
    const text = msg.text?.body?.trim();

    if (!waId) return;

    const lang = getLanguage.get(String(waId))?.language || null;

    // Commands (WhatsApp heeft geen Telegram buttons, dus doen we commands)
    if (!text) {
      await waSendText(waId, lang === "nl" ? "Stuur me even tekst 🙂" : "Please send text 🙂");
      return;
    }

    if (text === "/start" || text.toLowerCase() === "start") {
      await waSendText(waId, helpText(lang));
      return;
    }

    if (text === "/lang") {
      const t =
        lang === "nl"
          ? "Kies taal door te sturen: /nl, /en, of /de"
          : lang === "de"
          ? "Wähle Sprache: /nl, /en, oder /de"
          : "Choose language: /nl, /en, or /de";
      await waSendText(waId, t);
      return;
    }

    const langCmds = { "/nl": "nl", "/en": "en", "/de": "de" };
    if (langCmds[text.toLowerCase()]) {
      const code = langCmds[text.toLowerCase()];
      let row = getThread.get(String(waId));
      if (!row?.thread_id) {
        const threadId = await openaiCreateThread();
        upsertThread.run(String(waId), threadId, code, Date.now());
      } else {
        setLanguage.run(code, String(waId));
      }

      const confirm =
        code === "nl"
          ? "✅ Top, we praten Nederlands. Waar zit je hoofd nu het meeste mee?"
          : code === "de"
          ? "✅ Super, wir sprechen Deutsch. Woran denkst du gerade am meisten?"
          : "✅ Nice, we’ll talk in English. What’s on your mind right now?";
      await waSendText(waId, confirm);
      return;
    }

    // Normale message → naar Lothis
    const reply = await lothisReply(waId, text);
    await waSendText(waId, reply);
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
  }
});

/* =========================
   Debug (handig om assistant/key mismatch te checken)
========================= */
app.get("/debug/assistant", async (req, res) => {
  const r = await fetch(
    `https://api.openai.com/v1/assistants/${process.env.OPENAI_ASSISTANT_ID}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "OpenAI-Beta": "assistants=v2",
      },
    }
  );
  const t = await r.text();
  res.status(r.status).send(t);
});

/* =========================
   Health & root
========================= */
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.send("Lothis WhatsApp Bot is running ✨"));

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Lothis WhatsApp Bot running on :${PORT}`);
  console.log("Health:", `http://localhost:${PORT}/health`);
});
