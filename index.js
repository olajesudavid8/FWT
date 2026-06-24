const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "947b9439-fd89-44a2-a5c6-844487a27892";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID = "5092755750";
const PORT = process.env.PORT || 3000;

const MIN_TOKEN_AGE_DAYS = 29;
const MIN_GAP_HOURS = 47;
const MIN_MC = 1000;
const MAX_MC = 10000;
const SCAN_INTERVAL_MS = 2 * 60 * 1000;

// ── Keep-alive HTTP server (required by Railway) ──────────────────────────────
http.createServer((req, res) => res.end("OK")).listen(PORT, () => {
  log("BOOT", `Health check server listening on port ${PORT}`);
});

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

// ── Raydium: fetch pools page by page, filter by low MC ──────────────────────
async function fetchCandidates() {
  const results = new Map();
  let page = 1;
  const pageSize = 100;
  let totalFetched = 0;

  // Raydium sorts by liquidity asc — so low liquidity (our targets) come first
  // We stop once MC starts going above our range consistently
  while (true) {
    try {
      const url = `https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=liquidity&sortType=asc&pageSize=${pageSize}&page=${page}`;
      log("FETCH", `Raydium page ${page} → ${url}`);

      const res = await fetch(url);
      if (!res.ok) {
        logError("FETCH", `Raydium bad response: ${res.status}`);
        break;
      }

      const json = await res.json();
      const pools = json?.data?.data || [];
      if (!pools.length) {
        log("FETCH", `Raydium page ${page} empty — stopping`);
        break;
      }

      totalFetched += pools.length;
      let inRangeCount = 0;

      for (const pool of pools) {
        const mc = pool.marketCap || pool.tvl || 0;
        if (mc > MAX_MC * 5) {
          // We've gone well past our range, stop paginating
          log("FETCH", `MC ceiling reached at page ${page}, stopping`);
          return [...results.values()];
        }
        if (mc < MIN_MC || mc > MAX_MC) continue;

        const address = pool.mintA?.address;
        const symbol = pool.mintA?.symbol;
        const pairCreatedAt = pool.openTime ? pool.openTime * 1000 : null; // openTime is unix sec

        if (!address || results.has(address)) continue;
        inRangeCount++;
        results.set(address, { address, symbol, mc, pairCreatedAt });
      }

      log("FETCH", `Page ${page}: ${pools.length} pools, ${inRangeCount} in MC range`);

      // Stop after 10 pages to avoid rate limits
      if (page >= 10) break;
      page++;

      await new Promise((r) => setTimeout(r, 300)); // be gentle with Raydium
    } catch (e) {
      logError("FETCH", `Exception on page ${page}:`, e);
      break;
    }
  }

  log("FETCH", `Total fetched: ${totalFetched} pools, ${results.size} in MC range`);
  return [...results.values()];
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

  log("SCAN", `${candidates.length} candidates to evaluate`);

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedAlerted = 0, skippedAge = 0, skippedDormancy = 0, passed = 0;

  for (const token of candidates) {
    const { address } = token;
    if (alerted.has(address)) { skippedAlerted++; continue; }

    // Age check
    if (!token.pairCreatedAt) { skippedAge++; continue; }
    const ageDays = Math.floor((Date.now() - token.pairCreatedAt) / 86_400_000);
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
    sendAlert({ address, symbol: token.symbol, ageDays, gapHours, mc: token.mc });

    await new Promise((r) => setTimeout(r, 500));
  }

  log("SCAN", `Done — passed: ${passed} | skipped: alerted=${skippedAlerted} age=${skippedAge} dormancy=${skippedDormancy}`);
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
