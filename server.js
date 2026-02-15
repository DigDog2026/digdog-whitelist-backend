require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");
const cors = require("cors");

const nacl = require("tweetnacl");
const { PublicKey } = require("@solana/web3.js");

const app = express();
app.use(express.json());

// ✅ hCaptcha secret (set this in Render env vars)
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET;

// NOTE: For launch, open CORS is fine. Later, restrict to your Netlify + GoDaddy domains.
const allowed = new Set([
  "https://chic-meringue-a766a3.netlify.app",
  "https://majestic-wisp-c71f3f.netlify.app",
  "https://digdog.ca",
  "https://www.digdog.ca",
]);

app.use(
  cors({
    origin: (origin, cb) => {
      // allow no-origin requests (curl, server-to-server)
      if (!origin) return cb(null, true);
      return allowed.has(origin)
        ? cb(null, true)
        : cb(new Error("CORS blocked"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_SPOTS = parseInt(process.env.MAX_SPOTS || "500", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in environment variables.");
  process.exit(1);
}

if (!HCAPTCHA_SECRET) {
  console.warn("WARNING: HCAPTCHA_SECRET is not set. /join will reject until you add it in Render.");
}

const db = new Database("whitelist.sqlite");
db.exec(`
  CREATE TABLE IF NOT EXISTS whitelist (
    wallet TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
`);

function getCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM whitelist").get().c;
}

function exists(wallet) {
  return !!db.prepare("SELECT wallet FROM whitelist WHERE wallet=?").get(wallet);
}

function insertWallet(wallet) {
  db.prepare("INSERT INTO whitelist(wallet, created_at) VALUES(?, ?)").run(wallet, Date.now());
}

function deleteWallet(wallet) {
  db.prepare("DELETE FROM whitelist WHERE wallet=?").run(wallet);
}

function verifySignatureBase64({ wallet, message, signatureBase64 }) {
  const pubkey = new PublicKey(wallet);
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = Buffer.from(signatureBase64, "base64");
  return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
}

// ✅ Server-side hCaptcha verification
async function verifyHCaptcha(token, remoteip) {
  if (!HCAPTCHA_SECRET) return false;
  if (!token) return false;

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
  // Helpful for debugging on Render if needed:
  console.log("hCaptcha verify:", { ok: data.success, errors: data["error-codes"] });

  return !!data.success;
}

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/spots", (req, res) => {
  const count = getCount();
  res.json({ max: MAX_SPOTS, used: count, remaining: Math.max(0, MAX_SPOTS - count) });
});

// Main endpoint: verify wallet ownership + issue single-use TG invite
app.post("/join", async (req, res) => {
  try {
    const { wallet, signatureBase64, signatureBase58, captchaToken } = req.body || {};

    // ✅ Require captcha
    if (!captchaToken) {
      return res.status(400).json({ error: "Missing human verification (captcha)." });
    }

    const humanOk = await verifyHCaptcha(captchaToken, req.ip);
    if (!humanOk) {
      return res.status(403).json({ error: "Human verification failed (captcha)." });
    }

    // We accept either field name, but we treat the value as BASE64 (from the browser).
    const signature = signatureBase64 || signatureBase58;

    const message = "DIGDOG Early Access: verify wallet ownership";

    if (!wallet || !signature) {
      return res.status(400).json({ error: "Missing wallet or signature" });
    }

    // Validate wallet format
    try {
      new PublicKey(wallet);
    } catch {
      return res.status(400).json({ error: "Invalid wallet address" });
    }

    // Verify signature (base64)
    const ok = verifySignatureBase64({ wallet, message, signatureBase64: signature });
    if (!ok) {
      return res.status(401).json({ error: "Signature verification failed" });
    }

    // Duplicate + cap checks
    if (exists(wallet)) {
      return res.status(409).json({ error: "This wallet is already registered." });
    }

    const current = getCount();
    if (current >= MAX_SPOTS) {
      return res.status(403).json({ error: "Whitelist is full." });
    }

    // Insert first (then rollback if Telegram fails)
    insertWallet(wallet);

    // Create single-use Telegram invite link
    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        member_limit: 1,
      }),
    });

    const tgData = await tgResp.json();

    // Helpful logs for Render
    console.log("Telegram status:", tgResp.status);
    console.log("Telegram response:", tgData);

    if (!tgData.ok || !tgData.result?.invite_link) {
      // rollback insert if TG fails
      deleteWallet(wallet);

      const msg = tgData?.description || "Unknown Telegram error";
      return res.status(500).json({
        error: "Telegram invite creation failed",
        telegram_error: msg,
        telegram: tgData,
      });
    }

    return res.json({
      invite_link: tgData.result.invite_link,
      spots_remaining: MAX_SPOTS - (current + 1),
    });
  } catch (e) {
    console.error("JOIN ERROR:", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.post("/telegram-webhook", async (req, res) => {
  try {
    const update = req.body;

    // Always ack fast so Telegram doesn't retry
    res.sendStatus(200);

    // Helpful debug: see what Telegram is actually sending
    console.log("TG UPDATE:", JSON.stringify(update));

    // Case A: message with new members
    const newMembers =
      update?.message?.new_chat_members ||
      update?.message?.new_chat_participant ||
      [];

    // Case B: chat_member updates (common for join/leave)
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
            text: `🐶 Welcome to DIGDOG Early Access, ${first}!

You are officially part of the first 500.

📌 Stay tuned for launch details.
📌 Do not share invite links.
📌 More announcements coming soon.

We dig together. 🚀`,
          }),
        }
      );

      const data = await resp.json();
      console.log("sendMessage status:", resp.status, "resp:", data);
    }
  } catch (e) {
    console.error("Telegram webhook error:", e);
    // If we already responded 200 above, don't try to send again
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});







