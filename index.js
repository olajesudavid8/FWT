const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_API_KEY = "2268f624-e6e3-4342-8ece-f6b1ff13a1e8";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_TX  = `https://api-mainnet.helius-rpc.com/v0`;
const TELEGRAM_TOKEN = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID = "5092755750";
const PORT = process.env.PORT || 3000;

const MIN_TOKEN_AGE_DAYS = 29;
const MIN_GAP_HOURS = 46;
const MIN_MC = 1000;
const MAX_MC = 10000;
const SCAN_INTERVAL_MS = 60 * 1000;

// Raydium CPMM + AMM v4 program IDs — all recent swaps go through these
const RAYDIUM_PROGRAMS = [
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // CPMM (newest)
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ35MKDzgCcn7", // PumpFun AMM (post-bond filtered by MC)
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EkAW7vAo", // Meteora Dynamic AMM
];

// ── HTTP server ───────────────────────────────────────────────────────────────
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
const STATE_FILE = path.join(__dirname, "state.json");

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      log("BOOT", `Loaded state: ${Object.keys(data.lastSeen || {}).length} tokens tracked, ${(data.alerted || []).length} alerted`);
      return { lastSeen: data.lastSeen || {}, alerted: new Set(data.alerted || []) };
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

// ── Helius: get recent txs for a program, extract token mints ─────────────────
async function getRecentMintsFromProgram(programId) {
  const mints = new Map(); // mint → blockTime
  try {
    // Get recent signatures for this program
    const sigRes = await fetch(HELIUS_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getSignaturesForAddress",
        params: [programId, { limit: 100, commitment: "confirmed" }],
      }),
    });
    if (!sigRes.ok) {
      const text = await sigRes.text().catch(() => "");
      await handleHeliusError(sigRes.status, text);
      return mints;
    }
    const sigJson = await sigRes.json();
    const sigs = sigJson?.result || [];
    if (!sigs.length) return mints;

    log("FETCH", `${programId.slice(0, 8)}... → ${sigs.length} recent txs`);

    // Parse transactions in batch via Helius enhanced API
    const signatures = sigs.map((s) => s.signature);
    const txRes = await fetch(
      `${HELIUS_TX}/transactions?api-key=${HELIUS_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transactions: signatures }),
      }
    );
    if (!txRes.ok) {
      logError("FETCH", `Enhanced tx parse failed: ${txRes.status}`);
      return mints;
    }
    const txs = await txRes.json();
    if (!Array.isArray(txs)) return mints;

    for (const tx of txs) {
      if (tx.type !== "SWAP") continue;
      const blockTime = tx.timestamp;
      for (const transfer of tx.tokenTransfers || []) {
        const mint = transfer.mint;
        if (!mint) continue;
        // Keep earliest blockTime seen for this mint in this batch
        if (!mints.has(mint) || blockTime < mints.get(mint)) {
          mints.set(mint, blockTime);
        }
      }
    }

    log("FETCH", `${programId.slice(0, 8)}... → ${mints.size} unique swap mints`);
  } catch (e) {
    logError("FETCH", `Exception for ${programId.slice(0, 8)}:`, e);
  }
  return mints;
}

// ── Credit exhaustion tracker ─────────────────────────────────────────────────
let creditAlertSent = false;

async function handleHeliusError(status, body) {
  if ((status === 402 || status === 429 || (body && body.includes("credit"))) && !creditAlertSent) {
    creditAlertSent = true;
    logError("HELIUS", `Credits exhausted or rate limited (${status})`);
    await sendTelegram(`🪫 *Helius credits exhausted*\n\nThe scanner has run out of API credits and is no longer fetching data.\n\nTop up at helius.dev to resume.`);
  }
}

// ── Helius: get last trade timestamp for a token ─────────────────────────────
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      await handleHeliusError(res.status, text);
      return null;
    }
    const json = await res.json();
    if (json?.error) {
      await handleHeliusError(200, json.error.message || "");
      return null;
    }
    creditAlertSent = false; // reset on success
    const sigs = json?.result;
    if (!sigs?.length) return null;
    return sigs[0]?.blockTime || null;
  } catch (e) {
    return null;
  }
}

// ── DexScreener: get MC + age + symbol for a token ───────────────────────────
async function getDexData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${address}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = Array.isArray(json) ? json : (json?.pairs || []);
    if (!pairs.length) return null;

    // Must have at least one non-PumpFun pair to be considered graduated
    const hasGraduated = pairs.some((p) => {
      const dexId = (p.dexId || "").toLowerCase();
      return !dexId.includes("pump");
    });

    if (!hasGraduated) {
      log("SCAN", `Skipping pre-bond ${address.slice(0, 8)}... — PumpFun only`);
      return null;
    }

    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = pairs[0];
    return {
      mc: best.marketCap || best.fdv || 0,
      pairCreatedAt: best.pairCreatedAt || null,
      symbol: best.baseToken?.symbol || null,
    };
  } catch (e) {
    return null;
  }
}

// ── Helius: token age fallback via oldest signature ───────────────────────────
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

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  log("SCAN", "Starting scan...");

  // Collect mints from all Raydium programs
  const allMints = new Map();
  for (const program of RAYDIUM_PROGRAMS) {
    const mints = await getRecentMintsFromProgram(program);
    for (const [mint, blockTime] of mints) {
      if (!allMints.has(mint)) allMints.set(mint, blockTime);
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  log("SCAN", `Total unique mints from recent swaps: ${allMints.size}`);

  const nowSec = Math.floor(Date.now() / 1000);
  let skippedAlerted = 0, skippedGap = 0, skippedMC = 0, skippedAge = 0, passed = 0;

  for (const [mint, currentTxTime] of allMints) {
    if (state.alerted.has(mint)) { skippedAlerted++; continue; }

    const prevLastSeen = state.lastSeen[mint];
    state.lastSeen[mint] = currentTxTime;

    // First time seeing this token — look up actual last trade via Helius
    // so we don't have to wait to observe the gap ourselves
    let effectivePrev = prevLastSeen;
    if (!effectivePrev) {
      const actualLast = await getLastTradeSec(mint);
      if (actualLast && actualLast < currentTxTime) {
        effectivePrev = actualLast;
        log("SCAN", `New token ${mint.slice(0, 8)}... — fetched actual last trade`);
      } else {
        continue; // can't determine gap, skip
      }
    }

    // Check gap
    const gapHours = Math.floor((currentTxTime - effectivePrev) / 3600);
    if (gapHours < MIN_GAP_HOURS) { skippedGap++; continue; }

    log("SCAN", `Gap hit: ${mint.slice(0, 8)}... | ${gapHours}h gap — checking MC + age`);

    // MC + age via DexScreener
    const dex = await getDexData(mint);
    if (!dex) { log("SCAN", `No DexScreener data for ${mint.slice(0,8)}...`); skippedMC++; continue; }
    if (dex.mc < MIN_MC || dex.mc > MAX_MC) {
      log("SCAN", `MC rejected: ${dex.symbol || mint.slice(0,8)} $${Math.round(dex.mc).toLocaleString()} (range $${MIN_MC}-$${MAX_MC})`);
      skippedMC++; continue;
    }

    // Age check
    let ageDays = dex.pairCreatedAt
      ? Math.floor((Date.now() - dex.pairCreatedAt) / 86_400_000)
      : await getTokenAgeDays(mint);

    if (!ageDays || ageDays < MIN_TOKEN_AGE_DAYS) { skippedAge++; continue; }

    // Passed
    passed++;
    state.alerted.add(mint);
    saveState(state);
    sendAlert({ address: mint, symbol: dex.symbol, ageDays, gapHours, mc: dex.mc });
    await new Promise((r) => setTimeout(r, 500));
  }

  saveState(state);
  log("SCAN", `Done — passed: ${passed} | skipped: alerted=${skippedAlerted} gap=${skippedGap} mc=${skippedMC} age=${skippedAge}`);
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
