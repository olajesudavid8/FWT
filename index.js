const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "947b9439-fd89-44a2-a5c6-844487a27892";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;
const TELEGRAM_TOKEN = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID = "5092755750";
const PORT = process.env.PORT || 3000;

const MIN_TOKEN_AGE_DAYS = 29;
const MIN_GAP_HOURS = 24;
const MIN_MC = 1000;
const MAX_MC = 10000;
const SCAN_INTERVAL_MS = 45 * 1000; // every 30 seconds

// ── HTTP server — keeps Railway alive ─────────────────────────────────────────
http.createServer((req, res) => res.end("OK")).listen(PORT, () => {
  log("BOOT", `Health check server on port ${PORT}`);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] [${tag}] ${msg}`);
}
function logError(tag, msg, err) {
  console.error(`[${new Date().toISOString()}] [${tag}] ${msg}`, err?.message || err || "");
}

// ── Persistent state ──────────────────────────────────────────────────────────
// lastSeen: token address → last trade unix timestamp (seconds)
// alerted: set of addresses already alerted this session
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      log("BOOT", `Loaded state: ${Object.keys(data.lastSeen || {}).length} tokens tracked, ${(data.alerted || []).length} alerted`);
      return {
        lastSeen: data.lastSeen || {},
        alerted: new Set(data.alerted || []),
      };
    }
  } catch (e) {
    logError("BOOT", "Failed to load state:", e);
  }
  log("BOOT", "No state file — starting fresh");
  return { lastSeen: {}, alerted: new Set() };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      lastSeen: state.lastSeen,
      alerted: [...state.alerted],
    }), "utf8");
  } catch (e) {
    logError("SAVE", "Failed to save state:", e);
  }
}

const state = loadState();

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new Telegraf(TELEGRAM_TOKEN);

async function sendTelegram(msg) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" });
  } catch (e) {
    logError("TELEGRAM", "Failed to send:", e);
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

// ── Helius: get recent swap transactions ──────────────────────────────────────
// Uses the enhanced transactions API to pull latest swaps on Solana
async function getRecentSwaps() {
  try {
    // Pull last 100 parsed transactions of type SWAP across all programs
    const res = await fetch(
      `${HELIUS_API}/transactions?api-key=${HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: {
            types: ["SWAP"],
          },
          options: {
            limit: 100, // max allowed by Helius
          },
        }),
      }
    );
    if (!res.ok) {
      logError("HELIUS", `getRecentSwaps bad response: ${res.status} ${res.statusText}`);
      return [];
    }
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  } catch (e) {
    logError("HELIUS", "getRecentSwaps exception:", e);
    return [];
  }
}

// ── Helius: get last trade time for a specific token ──────────────────────────
async function getLastTradeSec(mintAddress) {
  try {
    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [mintAddress, { limit: 5, commitment: "confirmed" }],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.error) return null;
    const sigs = json?.result;
    if (!sigs?.length) return null;
    return sigs[0]?.blockTime || null;
  } catch (e) {
    return null;
  }
}

// ── Helius: get token mint creation time ──────────────────────────────────────
async function getTokenAgeDays(mintAddress) {
  try {
    const res = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [mintAddress, { limit: 1000, commitment: "confirmed" }],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const sigs = json?.result;
    if (!sigs?.length) return null;
    const oldest = sigs[sigs.length - 1];
    if (!oldest?.blockTime) return null;
    return Math.floor((Date.now() / 1000 - oldest.blockTime) / 86400);
  } catch (e) {
    return null;
  }
}

// ── DexScreener: get MC for a token ──────────────────────────────────────────
async function getTokenMC(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = Array.isArray(json) ? json : (json?.pairs || []);
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const mc = pairs[0]?.marketCap || pairs[0]?.fdv || 0;
    const pairCreatedAt = pairs[0]?.pairCreatedAt || null;
    const symbol = pairs[0]?.baseToken?.symbol || null;
    return { mc, pairCreatedAt, symbol };
  } catch (e) {
    return null;
  }
}

// ── Extract token mints from a swap transaction ───────────────────────────────
function extractTokensFromSwap(tx) {
  const mints = new Set();
  // Helius enhanced txs have tokenTransfers array
  for (const transfer of tx.tokenTransfers || []) {
    if (transfer.mint) mints.add(transfer.mint);
  }
  return [...mints];
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  log("SCAN", "Fetching recent swaps from Helius...");

  const swaps = await getRecentSwaps();
  log("SCAN", `Got ${swaps.length} recent swap transactions`);

  if (!swaps.length) return;

  const nowSec = Math.floor(Date.now() / 1000);

  // Collect unique token mints from all swaps
  const seenThisScan = new Map(); // mint → blockTime

  for (const tx of swaps) {
    const blockTime = tx.timestamp || tx.blockTime;
    if (!blockTime) continue;
    const mints = extractTokensFromSwap(tx);
    for (const mint of mints) {
      if (!seenThisScan.has(mint)) {
        seenThisScan.set(mint, blockTime);
      }
    }
  }

  log("SCAN", `${seenThisScan.size} unique tokens active in recent swaps`);

  let checked = 0, skippedAlerted = 0, skippedGap = 0, skippedAge = 0, skippedMC = 0, passed = 0;

  for (const [mint, currentTxTime] of seenThisScan) {
    // Skip already alerted
    if (state.alerted.has(mint)) { skippedAlerted++; continue; }

    const prevLastSeen = state.lastSeen[mint];

    // Update lastSeen
    state.lastSeen[mint] = currentTxTime;

    // If we've never seen this token before, just record it and move on
    if (!prevLastSeen) continue;

    // Check gap: was previous trade 48h+ ago?
    const gapSeconds = currentTxTime - prevLastSeen;
    const gapHours = Math.floor(gapSeconds / 3600);

    if (gapHours < MIN_GAP_HOURS) { skippedGap++; continue; }

    checked++;
    log("SCAN", `Gap hit: ${mint} | gap ${gapHours}h — checking age + MC`);

    // Check MC via DexScreener
    const dexData = await getTokenMC(mint);
    if (!dexData) { skippedMC++; continue; }

    const { mc, pairCreatedAt, symbol } = dexData;
    if (mc < MIN_MC || mc > MAX_MC) { 
      log("SCAN", `MC out of range: ${symbol} $${Math.round(mc)}`);
      skippedMC++; 
      continue; 
    }

    // Check age
    let ageDays = null;
    if (pairCreatedAt) {
      ageDays = Math.floor((Date.now() - pairCreatedAt) / 86_400_000);
    } else {
      ageDays = await getTokenAgeDays(mint);
    }

    if (!ageDays || ageDays < MIN_TOKEN_AGE_DAYS) { 
      log("SCAN", `Too young: ${symbol} ${ageDays}d`);
      skippedAge++; 
      continue; 
    }

    // Passed all filters
    passed++;
    state.alerted.add(mint);
    saveState(state);
    sendAlert({ address: mint, symbol, ageDays, gapHours, mc });
    await new Promise((r) => setTimeout(r, 500));
  }

  // Save updated lastSeen state
  saveState(state);

  log("SCAN", `Done — checked gaps: ${checked} | passed: ${passed} | skipped: alerted=${skippedAlerted} gap=${skippedGap} age=${skippedAge} mc=${skippedMC}`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
log("BOOT", "SOL Dormant Token Scanner starting");
log("BOOT", `MC: $${MIN_MC}–$${MAX_MC} | Age: ${MIN_TOKEN_AGE_DAYS}d | Gap: ${MIN_GAP_HOURS}h | Interval: ${SCAN_INTERVAL_MS / 1000}s`);

sendTelegram(
  `✅ *Scanner Online*\n\n` +
  `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
  `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
  `Min gap: ${MIN_GAP_HOURS}h dormant\n` +
  `Scan every: ${SCAN_INTERVAL_MS / 1000}s\n` +
  `Tracking: ${Object.keys(state.lastSeen).length} tokens`
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
