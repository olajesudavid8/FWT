const https = require("https");
const http  = require("http");

// ── CONFIG ──────────────────────────────────────────────
const BOT_TOKEN      = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID        = "5092755750";
const MIN_MC         = 50000;
const MAX_MC         = 1000000;
const MIN_AGE_DAYS   = 10;
const MIN_PUMP_6H    = 25;
const INTERVAL_MS    = 60_000;
// ────────────────────────────────────────────────────────

const alerted = new Map();
let lastUpdateId = 0;
let MIN_MC_CURRENT   = MIN_MC;
let MAX_MC_CURRENT   = MAX_MC;
let MIN_PUMP_CURRENT = MIN_PUMP_6H;
let MIN_AGE_CURRENT  = MIN_AGE_DAYS;

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    https.get({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      headers: { "User-Agent": "Mozilla/5.0", ...headers },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function sendTelegram(text, chatId = CHAT_ID) {
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.telegram.org",
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function pollCommands() {
  try {
    const res = await get(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const updates = res?.result || [];
    for (const update of updates) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text) continue;
      const chatId = msg.chat.id.toString();
      const text = msg.text.trim();
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === "/settings") {
        await sendTelegram(
          `⚙️ <b>Current Settings</b>\n\n` +
          `• MC range: <b>$${MIN_MC_CURRENT.toLocaleString()} – $${MAX_MC_CURRENT.toLocaleString()}</b>\n` +
          `• Min age: <b>${MIN_AGE_CURRENT} days</b>\n` +
          `• Min 6h pump: <b>${MIN_PUMP_CURRENT}%</b>\n` +
          `• Chain: <b>Solana only</b>`, chatId);
      } else if (cmd === "/setmc") {
        if (parts.length < 3) {
          await sendTelegram(`ℹ️ <b>Usage:</b> <code>/setmc &lt;min&gt; &lt;max&gt;</code>\n<b>Example:</b> <code>/setmc 50000 1000000</code>`, chatId);
        } else {
          MIN_MC_CURRENT = parseInt(parts[1]);
          MAX_MC_CURRENT = parseInt(parts[2]);
          await sendTelegram(`✅ MC range updated to <b>$${MIN_MC_CURRENT.toLocaleString()} – $${MAX_MC_CURRENT.toLocaleString()}</b>`, chatId);
        }
      } else if (cmd === "/setpump") {
        if (parts.length < 2) {
          await sendTelegram(`ℹ️ <b>Usage:</b> <code>/setpump &lt;percent&gt;</code>\n<b>Example:</b> <code>/setpump 25</code>`, chatId);
        } else {
          MIN_PUMP_CURRENT = parseInt(parts[1]);
          await sendTelegram(`✅ Min 6h pump updated to <b>${MIN_PUMP_CURRENT}%</b>`, chatId);
        }
      } else if (cmd === "/setage") {
        if (parts.length < 2) {
          await sendTelegram(`ℹ️ <b>Usage:</b> <code>/setage &lt;days&gt;</code>\n<b>Example:</b> <code>/setage 10</code>`, chatId);
        } else {
          MIN_AGE_CURRENT = parseInt(parts[1]);
          await sendTelegram(`✅ Min token age updated to <b>${MIN_AGE_CURRENT} days</b>`, chatId);
        }
      } else if (cmd === "/help") {
        await sendTelegram(
          `🤖 <b>Gradual Mover Detector Commands</b>\n\n` +
          `/setmc &lt;min&gt; &lt;max&gt; — Set MC range\n` +
          `/setpump &lt;percent&gt; — Set min 6h pump %\n` +
          `/setage &lt;days&gt; — Set min token age\n` +
          `/settings — Show current settings\n` +
          `/help — Show this message`, chatId);
      }
    }
  } catch (e) {
    console.error("[CMD ERROR]", e.message);
  }
}

async function scan() {
  try {
    console.log(`[${new Date().toLocaleTimeString()}] Scanning...`);

    // Fetch top boosted tokens from DexScreener (no API key needed)
    const [top, latest] = await Promise.all([
      get("https://api.dexscreener.com/token-boosts/top/v1"),
      get("https://api.dexscreener.com/token-boosts/latest/v1"),
    ]);

    const boosted = [];
    if (Array.isArray(top)) boosted.push(...top);
    if (Array.isArray(latest)) boosted.push(...latest);

    // Dedupe by token address
    const seen = new Map();
    for (const t of boosted) {
      if (t.tokenAddress) seen.set(t.tokenAddress, t);
    }

    // Filter Solana only
    const solTokens = Array.from(seen.values()).filter(
      t => (t.chainId || "").toLowerCase() === "solana"
    );

    console.log(`[DEBUG] ${solTokens.length} Solana boosted tokens found`);

    let matchCount = 0;

    for (const token of solTokens) {
      const addr = token.tokenAddress;
      if (!addr) continue;

      // Look up pair data on DexScreener
      let pair = null;
      try {
        const res = await get(`https://api.dexscreener.com/latest/dex/tokens/${addr}`);
        const pairs = (res?.pairs || []).filter(p => (p.chainId || "").toLowerCase() === "solana");
        if (pairs.length === 0) continue;
        pairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));
        pair = pairs[0];
      } catch (e) { continue; }

      const mcapRaw  = parseFloat(pair.marketCap || 0);
      const change6h = parseFloat(pair.priceChange?.h6 || 0);
      const ageDays  = (Date.now() - (pair.pairCreatedAt || 0)) / (1000 * 60 * 60 * 24);
      console.log(`[TOKEN] ${pair.baseToken?.symbol} MC: $${mcapRaw.toLocaleString()} | 6h: ${change6h}% | Age: ${Math.floor(ageDays)}d`);

      // Apply filters
      if (mcapRaw < MIN_MC_CURRENT || mcapRaw > MAX_MC_CURRENT) continue;
      if (change6h < MIN_PUMP_CURRENT) continue;
      if (ageDays < MIN_AGE_CURRENT) continue;

      // Cooldown — 4 hours
      const lastAlert = alerted.get(addr) || 0;
      if (Date.now() - lastAlert < 14400000) continue;
      alerted.set(addr, Date.now());

      matchCount++;

      const name      = pair.baseToken?.name || "Unknown";
      const symbol    = pair.baseToken?.symbol || "?";
      const priceUsd  = parseFloat(pair.priceUsd || 0);
      const mcap      = `$${Number(mcapRaw).toLocaleString()}`;
      const liq       = `$${Number(pair.liquidity?.usd || 0).toLocaleString()}`;
      const change1h  = pair.priceChange?.h1 != null ? `${pair.priceChange.h1 > 0 ? "+" : ""}${parseFloat(pair.priceChange.h1).toFixed(1)}%` : "N/A";
      const change24h = pair.priceChange?.h24 != null ? `${pair.priceChange.h24 > 0 ? "+" : ""}${parseFloat(pair.priceChange.h24).toFixed(1)}%` : "N/A";
      const ageStr    = `${Math.floor(ageDays)}d`;
      const dexUrl    = `https://dexscreener.com/solana/${pair.pairAddress}`;

      const msg =
`📈 <b>GRADUAL MOVER — SOLANA</b>

🪙 <b>${name}</b> (<b>$${symbol}</b>)
💰 Market Cap: <b>${mcap}</b>
💵 Price: <b>$${priceUsd.toFixed(8)}</b>
💧 Liquidity: <b>${liq}</b>
🕐 Token Age: <b>${ageStr}</b>

📈 6h Change: <b>+${change6h.toFixed(1)}%</b>
📈 1h Change: <b>${change1h}</b>
📈 24h Change: <b>${change24h}</b>

📋 CA: <code>${addr}</code>

🔗 <a href="${dexUrl}">DexScreener</a>

⚠️ DYOR — not financial advice.`;

      await sendTelegram(msg);
      console.log(`[MOVER] ${symbol} +${change6h.toFixed(1)}% 6h | MC: ${mcap} | Age: ${ageStr}`);
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[${new Date().toLocaleTimeString()}] Done — ${matchCount} alerts fired`);
  } catch (err) {
    console.error("Scan error:", err.message);
  }
}

// Keep-alive
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("gradual mover detector alive");
}).listen(process.env.PORT || 3000, () => console.log(`Ping server on port ${process.env.PORT || 3000}`));

(async () => {
  console.log("📈 Gradual Mover Detector started");
  console.log(`   MC range   : $${MIN_MC_CURRENT.toLocaleString()} – $${MAX_MC_CURRENT.toLocaleString()}`);
  console.log(`   Min age    : ${MIN_AGE_CURRENT} days`);
  console.log(`   Min 6h pump: ${MIN_PUMP_CURRENT}%`);
  console.log(`   Interval   : ${INTERVAL_MS / 1000}s\n`);
  await sendTelegram(
    `✅ <b>Gradual Mover Detector is live!</b>\n\n` +
    `Watching Solana for older tokens grinding up steadily.\n\n` +
    `Filters:\n• MC range: $50k – $1M\n• Min age: 10 days\n• Min 6h pump: 25%\n• Chain: Solana only\n\n` +
    `Commands: /setmc /setpump /setage /settings /help`
  );
  await scan();
  setInterval(scan, INTERVAL_MS);
  setInterval(pollCommands, 3000);
})();
