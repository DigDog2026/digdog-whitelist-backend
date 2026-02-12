require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const Database = require("better-sqlite3");
const cors = require("cors");

const nacl = require("tweetnacl");
const bs58 = require("bs58");
const { PublicKey } = require("@solana/web3.js");

const app = express();
app.use(express.json());
app.use(cors());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MAX_SPOTS = parseInt(process.env.MAX_SPOTS || "500", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env");
  process.exit(1);
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
function verifySignature({ wallet, message, signatureBase64 }) {
  const pubkey = new PublicKey(wallet);
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = Buffer.from(signatureBase64, "base64");
  return nacl.sign.detached.verify(msgBytes, sigBytes, pubkey.toBytes());
}

app.get("/", (req, res) => res.json({ ok: true }));

app.get("/spots", (req, res) => {
  const count = getCount();
  res.json({ max: MAX_SPOTS, used: count, remaining: MAX_SPOTS - count });
});

// Main endpoint: verify wallet ownership + issue single-use TG invite
app.post("/join", async (req, res) => {
  console.log("=== /join HIT ===");
  console.log("Body:", req.body);

  try {
  const { wallet, signatureBase64, signatureBase58 } = req.body || {};
  const signature = signatureBase64 || signatureBase58;

  if (!wallet || !signature) {
  return res.status(400).json({ error: "Missing wallet or signature" });
}

    // Validate wallet format
    try { new PublicKey(wallet); }
    catch { return res.status(400).json({ error: "Invalid wallet address" }); }

    // Verify signature
    const ok = verifySignature({ wallet, message, signatureBase64: signature });
    if (!ok) return res.status(401).json({ error: "Signature verification failed" });

    // Enforce one-time per wallet
    if (exists(wallet)) return res.status(409).json({ error: "This wallet is already registered." });

    // Enforce cap
    const current = getCount();
    if (current >= MAX_SPOTS) return res.status(403).json({ error: "Whitelist is full." });

    // Insert wallet
    insertWallet(wallet);

    // Create single-use Telegram invite link
    const tgResp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        member_limit: 1
      }),
    });

    const tgData = await tgResp.json();
    console.log("Telegram status:", tgResp.status);
    console.log("Telegram response:", tgData);

    if (!tgData.ok || !tgData.result?.invite_link) {
  // rollback insert if TG fails
  db.prepare("DELETE FROM whitelist WHERE wallet=?").run(wallet);

  const msg = tgData?.description || "Unknown Telegram error";
  return res.status(500).json({
    error: "Telegram invite creation failed",
    telegram_error: msg,
    telegram: tgData
  });
}

    return res.json({
      invite_link: tgData.result.invite_link,
      spots_remaining: MAX_SPOTS - (current + 1)
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
