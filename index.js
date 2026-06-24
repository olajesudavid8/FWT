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

// ── Persistent alerted set ────────────────────────────────────────────────────
const ALERTED_FILE = path.join(__dirname, "alerted.json");

function loadAlerted() {
  try {
    if (fs.existsSync(ALERTED_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALERTED_FILE, "utf8"));
      return new Set(data);
    }
  } catch (e) {
    console.error("[loadAlerted] starting fresh:", e.message);
  }
  return new Set();
}

function saveAlerted(set) {
  try {
    fs.writeFileSync(ALERTED_FILE, JSON.stringify([...set]), "utf8");
  } catch (e) {
    console.error("[saveAlerted]", e.message);
  }
}

const alerted = loadAlerted();

// ── Telegram ──────────────────────────────────────────────────────────────────
const bot = new Telegraf(TELEGRAM_TOKEN);

function sendAlert(token) {
  const dexUrl = `https://dexscreener.com/solana/${token.address}`;
  const msg =
    `🚨 *DORMANT TOKEN WOKE UP*\n\n` +
    `*${token.symbol || "UNKNOWN"}*\n` +
    `📅 Age: ${token.ageDays} days old\n` +
    `💤 Was dormant: ${token.gapHours}h\n` +
    `💰 MC: $${Math.round(token.mc).toLocaleString()}\n` +
    `🔗 [View on DexScreener](${dexUrl})`;

  bot.telegram
    .sendMessage(CHAT_ID, msg, { parse_mode: "Markdown" })
    .catch(console.error);

  console.log(
    `[ALERT] ${token.symbol} | MC $${Math.round(token.mc)} | Gap ${token.gapHours}h | Age ${token.ageDays}d`
  );
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
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();

      const pairs = json?.pairs || json?.data?.pairs || [];
      const tokens = json?.tokens || [];

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
      console.error(`[fetchCandidates] ${url}:`, e.message);
    }
  }

  return [...results.values()];
}

// ── DexScreener: get pair detail for a specific token ─────────────────────────
async function getPairDetail(address) {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${address}`
    );
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = json?.pairs || [];
    const solanaPairs = pairs.filter((p) => p.chainId === "solana");
    if (!solanaPairs.length) return null;
    solanaPairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return solanaPairs[0];
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
    const json = await res.json();
    const sigs = json?.result;
    if (!sigs || !sigs.length) return null;
    return sigs[0]?.blockTime || null;
  } catch (e) {
    return null;
  }
}

// ── Main scan ─────────────────────────────────────────────────────────────────
async function scan() {
  console.log(`\n[SCAN] ${new Date().toISOString()}`);

  const candidates = await fetchCandidates();
  console.log(`[SCAN] ${candidates.length} candidates in MC range`);

  const nowSec = Math.floor(Date.now() / 1000);

  for (const token of candidates) {
    const { address } = token;
    if (alerted.has(address)) continue;

    // Age check
    let ageDays = null;
    if (token.pairCreatedAt) {
      ageDays = Math.floor((Date.now() - token.pairCreatedAt) / 86_400_000);
      if (ageDays < MIN_TOKEN_AGE_DAYS) continue;
    }

    // MC check — re-fetch if unknown
    let mc = token.mc;
    if (!mc || mc < MIN_MC || mc > MAX_MC) {
      const detail = await getPairDetail(address);
      if (!detail) continue;
      mc = detail.marketCap || detail.fdv || 0;
      if (mc < MIN_MC || mc > MAX_MC) continue;
      if (!ageDays && detail.pairCreatedAt) {
        ageDays = Math.floor((Date.now() - detail.pairCreatedAt) / 86_400_000);
        if (ageDays < MIN_TOKEN_AGE_DAYS) continue;
      }
    }

    if (!ageDays || ageDays < MIN_TOKEN_AGE_DAYS) continue;

    // Dormancy check via Helius
    const lastTrade = await getLastTradeSec(address);
    if (!lastTrade) continue;

    const gapHours = Math.floor((nowSec - lastTrade) / 3600);
    if (gapHours < MIN_GAP_HOURS) continue;

    // Passed all filters → alert and persist
    alerted.add(address);
    saveAlerted(alerted);
    sendAlert({ address, symbol: token.symbol, ageDays, gapHours, mc });

    await new Promise((r) => setTimeout(r, 500));
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
console.log("🤖 SOL Dormant Token Scanner");
console.log(`   MC range : $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}`);
console.log(`   Min age  : ${MIN_TOKEN_AGE_DAYS} days`);
console.log(`   Min gap  : ${MIN_GAP_HOURS}h dormant`);
console.log(`   Interval : ${SCAN_INTERVAL_MS / 1000}s`);
console.log(`   Alerted  : ${alerted.size} tokens already seen\n`);

scan();
setInterval(scan, SCAN_INTERVAL_MS);

// Send boot message to Telegram
bot.telegram.sendMessage(
  CHAT_ID,
  `✅ *Scanner Online*\n\n` +
  `MC range: $${MIN_MC.toLocaleString()} – $${MAX_MC.toLocaleString()}\n` +
  `Min age: ${MIN_TOKEN_AGE_DAYS} days\n` +
  `Min gap: ${MIN_GAP_HOURS}h dormant\n` +
  `Scan every: ${SCAN_INTERVAL_MS / 1000}s\n` +
  `Previously seen: ${alerted.size} tokens`,
  { parse_mode: "Markdown" }
).catch(console.error);
