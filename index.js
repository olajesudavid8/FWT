const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "947b9439-fd89-44a2-a5c6-844487a27892";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID = "5092755750";

const MIN_TOKEN_AGE_DAYS = 29;
const MIN_GAP_HOURS = 47;
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

// ── DexScreener: get token addresses from latest profiles ─────────────────────
// This is the only free endpoint that returns a broad list of solana tokens
async function fetchTokenAddresses() {
  const addresses = new Map(); // address → symbol

  const endpoints = [
    "https://api.dexscreener.com/token-profiles/latest/v1",
    "https://api.dexscreener.com/token-profiles/recent-updates/v1",
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-boosts/top/v1",
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
      const items = Array.isArray(json) ? json : (json?.data || []);
      log("FETCH", `${url} → ${items.length} items`);

      for (const item of items) {
        if (item.chainId !== "solana") continue;
        const address = item.tokenAddress;
        if (!address || addresses.has(address)) continue;
        addresses.set(address, item.description || item.symbol || "?");
      }
    } catch (e) {
      logError("FETCH", `Exception fetching ${url}:`, e);
    }
  }

  log("FETCH", `Total unique solana token addresses: ${addresses.size}`);
  return addresses;
}

// ── DexScreener: get pair details for a token ─────────────────────────────────
async function getTokenPairs(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = Array.isArray(json) ? json : (json?.pairs || []);
    if (!pairs.length) return null;
    // Pick pair with highest liquidity
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs[0];
  } catch (e) {
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

  let tokenAddresses;
  try {
    tokenAddresses = await fetchTokenAddresses();
  } catch (e) {
    logError("SCAN", "fetchTokenAddresses threw:", e);
    await sendTelegram(`⚠️ *Scan error*: fetchTokenAddresses failed — ${e.message}`);
    return;
  }

  log("SCAN", `${tokenAddresses.size} solana tokens to evaluate`);

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedAlerted = 0, skippedAge = 0, skippedMC = 0, skippedDormancy = 0, passed = 0;

  for (const [address, symbol] of tokenAddresses) {
    if (alerted.has(address)) { skippedAlerted++; continue; }

    // Get pair details for MC + age
    const pair = await getTokenPairs(address);
    if (!pair) { skippedMC++; continue; }

    // MC check
    const mc = pair.marketCap || pair.fdv || 0;
    if (mc < MIN_MC || mc > MAX_MC) { skippedMC++; continue; }

    // Age check
    const pairCreatedAt = pair.pairCreatedAt; // ms
    if (!pairCreatedAt) { skippedAge++; continue; }
    const ageDays = Math.floor((Date.now() - pairCreatedAt) / 86_400_000);
    if (ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }

    // Dormancy check via Helius
    const lastTrade = await getLastTradeSec(address);
    if (!lastTrade) { skippedDormancy++; continue; }

    const gapHours = Math.floor((nowSec - lastTrade) / 3600);
    if (gapHours < MIN_GAP_HOURS) { skippedDormancy++; continue; }

    // Passed all filters
    passed++;
    alerted.add(address);
    saveAlerted(alerted);
    sendAlert({
      address,
      symbol: pair.baseToken?.symbol || symbol,
      ageDays,
      gapHours,
      mc,
    });

    await new Promise((r) => setTimeout(r, 500));
  }

  log("SCAN", `Done — passed: ${passed} | skipped: alerted=${skippedAlerted} mc=${skippedMC} age=${skippedAge} dormancy=${skippedDormancy}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("BOOT", "SOL Dormant Token Scanner starting");
log("BOOT", `MC range: $${MIN_MC} – $${MAX_MC}`);
log("BOOT", `Min age: ${MIN_TOKEN_AGE_DAYS} days | Min gap: ${MIN_GAP_HOURS}h | Interval: ${SCAN_INTERVAL_MS / 1000}s`);

sendTelegram(
  `✅ *Scanner Online*\n\n` +
  `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
  `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
  `Min gap: ${MIN_GAP_HOURS}h dormant\n` +
  `Scan every: ${SCAN_INTERVAL_MS / 1000}s\n` +
  `Previously seen: ${alerted.size} tokens`
);

process.on("uncaughtException", (e) => {
  logError("CRASH", "Uncaught exception:", e);
  sendTelegram(`🔴 *Scanner crashed*: ${e.message}`).finally(() => process.exit(1));
});

process.on("unhandledRejection", (e) => {
  logError("CRASH", "Unhandled rejection:", e);
});

scan();
setInterval(scan, SCAN_INTERVAL_MS);
