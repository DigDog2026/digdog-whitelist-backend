require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");
const cors = require("cors");

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_SPOTS = parseInt(process.env.MAX_SPOTS || "500", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables.");
  process.exit(1);
}
if (!HCAPTCHA_SECRET) {
  console.error("Missing HCAPTCHA_SECRET in environment variables.");
  process.exit(1);
}

// CORS (keep your allowed list)
const allowed = new Set([
  "https://chic-meringue-a766a3.netlify.app",
  "https://digdog.ca",
  "https://www.digdog.ca",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      return allowed.has(origin) ? cb(null, true) : cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// --- DB: store “issued invites” only (no wallet) ---
const db = new Database("whitelist.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL
  );
`);

function getCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM invites").get().c;
}
function insertInvite() {
  db.prepare("INSERT INTO invites(created_at) VALUES(?)").run(Date.now());
}
function deleteLastInviteRow() {
  // best-effort rollback: delete the most recent row
  db.prepare("DELETE FROM invites WHERE id = (SELECT id FROM invites ORDER BY id DESC LIMIT 1)").run();
}

// --- hCaptcha verification ---
async function verifyHCaptcha(token, remoteip) {
  const params = new URLSearchParams();
  params.append("secret", HCAPTCHA_SECRET);
  params.append("response", token);
  if (remoteip) params.append("remoteip", remoteip);

  const resp = await fetch("https://hcaptcha.com/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  const data = await resp.json().catch(() => ({}));
  return data; // { success: true/false, ... }
}

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/spots", (req, res) => {
  const used = getCount();
  res.json({ max: MAX_SPOTS, used, remaining: Math.max(0, MAX_SPOTS - used) });
});

// Main endpoint: verify human + issue single-use TG invite
app.post("/join", async (req, res) => {
  try {
    const { captchaToken } = req.body || {};
    if (!captchaToken) {
      return res.status(400).json({ error: "Missing captcha token" });
    }

    // Check capacity first (fast fail)
    const current = getCount();
    if (current >= MAX_SPOTS) {
      return res.status(403).json({ error: "Whitelist is full." });
    }

    // Verify hCaptcha
    const ip =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;

    const hc = await verifyHCaptcha(captchaToken, ip);
    console.log("hCaptcha response:", hc);

    if (!hc.success) {
      return res.status(403).json({
        error: "Human verification failed",
        captcha: hc,
      });
    }

    // Reserve a spot (then rollback if TG fails)
    insertInvite();

    // Create Telegram single-use invite link
    const tgResp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          member_limit: 1,
        }),
      }
    );

    const tgData = await tgResp.json().catch(() => ({}));
    console.log("Telegram status:", tgResp.status);
    console.log("Telegram response:", tgData);

    if (!tgData.ok || !tgData.result?.invite_link) {
      deleteLastInviteRow();
      const msg = tgData?.description || "Unknown Telegram error";
      return res.status(500).json({
        error: "Telegram invite creation failed",
        telegram_error: msg,
        telegram: tgData,
      });
    }

    return res.json({
      invite_link: tgData.result.invite_link,
      spots_remaining: Math.max(0, MAX_SPOTS - (current + 1)),
    });
  } catch (e) {
    console.error("JOIN ERROR:", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// Optional: webhook welcome message (keep if you’re using it)
app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;
    res.sendStatus(200);
    console.log("TG UPDATE:", JSON.stringify(update));

    const newMembers =
      update?.message?.new_chat_members ||
      update?.message?.new_chat_participant ||
      [];

    const memberFromChatMember =
      update?.chat_member?.new_chat_member?.user ||
      update?.my_chat_member?.new_chat_member?.user ||
      null;

    const membersToWelcome = Array.isArray(newMembers) ? newMembers : [];
    if (memberFromChatMember) membersToWelcome.push(memberFromChatMember);
    if (membersToWelcome.length === 0) return;

    for (const member of membersToWelcome) {
      const first = member?.first_name || "friend";

      const resp = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: `🐶 Welcome to DIGDOG 500, ${first}!

You are officially part of the first 500.

📌 Stay tuned for launch details.
📌 Do not share invite links.
📌 More announcements coming soon.

We dig together. 🚀`,
          }),
        }
      );

      const data = await resp.json().catch(() => ({}));
      console.log("sendMessage status:", resp.status, "resp:", data);
    }
  } catch (e) {
    console.error("Telegram webhook error:", e);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

