const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "947b9439-fd89-44a2-a5c6-844487a27892";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID = "5092755750";

const MIN_TOKEN_AGE_DAYS = 30;
const MIN_GAP_HOURS = 48;
const MIN_MC = 1000;
const MAX_MC = 10000;
const SCAN_INTERVAL_MS = 2 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}

function logError(tag, msg, err) {
  console.error(`[${new Date().toISOString()}] [${tag}] ${msg}`, err?.message || err || "");
}

// ── Persistent alerted set ────────────────────────────────────────────────────
const ALERTED_FILE = path.join(__dirname, "alerted.json");

function loadAlerted() {
  try {
    if (fs.existsSync(ALERTED_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALERTED_FILE, "utf8"));
      log("BOOT", `Loaded ${data.length} previously alerted tokens from disk`);
      return new Set(data);
    } else {
      log("BOOT", "No alerted.json found — starting fresh");
    }
  } catch (e) {
    logError("BOOT", "Failed to load alerted.json, starting fresh:", e);
  }
  return new Set();
}

function saveAlerted(set) {
  try {
    fs.writeFileSync(ALERTED_FILE, JSON.stringify([...set]), "utf8");
  } catch (e) {
    logError("SAVE", "Failed to save alerted.json:", e);
  }
}

const alerted = loadAlerted();

// ── Telegram ──────────────────────────────────────────────────────────────────
let bot;
try {
  bot = new Telegraf(TELEGRAM_TOKEN);
  log("BOOT", "Telegraf bot initialised");
} catch (e) {
  logError("BOOT", "Failed to initialise Telegraf:", e);
  process.exit(1);
}

async function sendTelegram(msg) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    logError("TELEGRAM", "Failed to send message:", e);
  }
}

function sendAlert(token) {
  const dexUrl = `https://dexscreener.com/solana/${token.address}`;
  const msg =
    `🚨 *DORMANT TOKEN WOKE UP*\n\n` +
    `*${token.symbol || "UNKNOWN"}*\n` +
    `📅 Age: ${token.ageDays} days old\n` +
    `💤 Was dormant: ${token.gapHours}h\n` +
    `💰 MC: $${Math.round(token.mc).toLocaleString()}\n` +
    `🔗 [View on DexScreener](${dexUrl})`;

  sendTelegram(msg);
  log("ALERT", `${token.symbol} | MC $${Math.round(token.mc)} | Gap ${token.gapHours}h | Age ${token.ageDays}d`);
}

// ── DexScreener: fetch low MC solana pairs ────────────────────────────────────
async function fetchCandidates() {
  const results = new Map();

  const endpoints = [
    "https://api.dexscreener.com/latest/dex/pairs/solana",
    "https://api.dexscreener.com/token-boosts/latest/v1",
  ];

  for (const url of endpoints) {
    try {
      log("FETCH", `Calling ${url}`);
      const res = await fetch(url);
      if (!res.ok) {
        logError("FETCH", `Bad response from ${url}: ${res.status} ${res.statusText}`);
        continue;
      }
      const json = await res.json();
      const pairs = json?.pairs || json?.data?.pairs || [];
      const tokens = json?.tokens || [];

      log("FETCH", `${url} → ${pairs.length} pairs, ${tokens.length} tokens`);

      for (const p of pairs) {
        if (p.chainId !== "solana") continue;
        const mc = p.marketCap || p.fdv || 0;
        if (mc < MIN_MC || mc > MAX_MC) continue;
        const address = p.baseToken?.address;
        if (!address || results.has(address)) continue;
        results.set(address, {
          address,
          symbol: p.baseToken?.symbol || "?",
          mc,
          pairCreatedAt: p.pairCreatedAt || null,
        });
      }

      for (const t of tokens) {
        if (t.chainId !== "solana") continue;
        const address = t.tokenAddress;
        if (!address || results.has(address)) continue;
        results.set(address, {
          address,
          symbol: t.description || "?",
          mc: 0,
          pairCreatedAt: null,
        });
      }
    } catch (e) {
      logError("FETCH", `Exception fetching ${url}:`, e);
    }
  }

  log("FETCH", `Total unique candidates after MC filter: ${results.size}`);
  return [...results.values()];
}

// ── DexScreener: get pair detail for a specific token ─────────────────────────
async function getPairDetail(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!res.ok) {
      logError("DETAIL", `Bad response for ${address}: ${res.status}`);
      return null;
    }
    const json = await res.json();
    const pairs = json?.pairs || [];
    const solanaPairs = pairs.filter((p) => p.chainId === "solana");
    if (!solanaPairs.length) return null;
    solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return solanaPairs[0];
  } catch (e) {
    logError("DETAIL", `Exception for ${address}:`, e);
    return null;
  }
}

// ── Helius: get last transaction timestamp ────────────────────────────────────
async function getLastTradeSec(mintAddress) {
  try {
    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [mintAddress, { limit: 5, commitment: "confirmed" }],
      }),
    });
    if (!res.ok) {
      logError("HELIUS", `Bad response for ${mintAddress}: ${res.status}`);
      return null;
    }
    const json = await res.json();
    if (json?.error) {
      logError("HELIUS", `RPC error for ${mintAddress}: ${json.error.message}`);
      return null;
    }
    const sigs = json?.result;
    if (!sigs || !sigs.length) return null;
    return sigs[0]?.blockTime || null;
  } catch (e) {
    logError("HELIUS", `Exception for ${mintAddress}:`, e);
    return null;
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  log("SCAN", "Starting scan...");

  let candidates;
  try {
    candidates = await fetchCandidates();
  } catch (e) {
    logError("SCAN", "fetchCandidates threw:", e);
    await sendTelegram(`⚠️ *Scan error*: fetchCandidates failed — ${e.message}`);
    return;
  }

  log("SCAN", `${candidates.length} candidates to check`);

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedAlerted = 0, skippedAge = 0, skippedMC = 0, skippedDormancy = 0, passed = 0;

  for (const token of candidates) {
    const { address } = token;

    if (alerted.has(address)) { skippedAlerted++; continue; }

    // Age check
    let ageDays = null;
    if (token.pairCreatedAt) {
      ageDays = Math.floor((Date.now() - token.pairCreatedAt) / 86_400_000);
      if (ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }
    }

    // MC check
    let mc = token.mc;
    if (!mc || mc < MIN_MC || mc > MAX_MC) {
      const detail = await getPairDetail(address);
      if (!detail) { skippedMC++; continue; }
      mc = detail.marketCap || detail.fdv || 0;
      if (mc < MIN_MC || mc > MAX_MC) { skippedMC++; continue; }
      if (!ageDays && detail.pairCreatedAt) {
        ageDays = Math.floor((Date.now() - detail.pairCreatedAt) / 86_400_000);
        if (ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }
      }
    }

    if (!ageDays || ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }

    // Dormancy check
    const lastTrade = await getLastTradeSec(address);
    if (!lastTrade) { skippedDormancy++; continue; }

    const gapHours = Math.floor((nowSec - lastTrade) / 3600);
    if (gapHours < MIN_GAP_HOURS) { skippedDormancy++; continue; }

    // Passed
    passed++;
    alerted.add(address);
    saveAlerted(alerted);
    sendAlert({ address, symbol: token.symbol, ageDays, gapHours, mc });

    await new Promise((r) => setTimeout(r, 500));
  }

  log("SCAN", `Done — passed: ${passed} | skipped: alerted=${skippedAlerted} age=${skippedAge} mc=${skippedMC} dormancy=${skippedDormancy}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("BOOT", "SOL Dormant Token Scanner starting");
log("BOOT", `MC range: $${MIN_MC} – $${MAX_MC}`);
log("BOOT", `Min age: ${MIN_TOKEN_AGE_DAYS} days | Min gap: ${MIN_GAP_HOURS}h | Interval: ${SCAN_INTERVAL_MS / 1000}s`);

// Telegram boot message
sendTelegram(
  `✅ *Scanner Online*\n\n` +
  `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
  `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
  `Min gap: ${MIN_GAP_HOURS}h dormant\n` +
  `Scan every: ${SCAN_INTERVAL_MS / 1000}s\n` +
  `Previously seen: ${alerted.size} tokens`
);

// Catch unhandled errors so Railway doesn't silently die
process.on("uncaughtException", (e) => {
  logError("CRASH", "Uncaught exception:", e);
  sendTelegram(`🔴 *Scanner crashed*: ${e.message}`).finally(() => process.exit(1));
});

process.on("unhandledRejection", (e) => {
  logError("CRASH", "Unhandled rejection:", e);
});

scan();
setInterval(scan, SCAN_INTERVAL_MS);
