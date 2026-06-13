const https = require("https");
const http  = require("http");

// ── CONFIG ──────────────────────────────────────────────
const BOT_TOKEN    = "8769953136:AAHFrooUVd1yx8BxPbJVTJPhthyhW-ptTqY";
const CHAT_ID      = "5092755750";
const HELIUS_KEY   = "947b9439-fd89-44a2-a5c6-844487a27892";
const INTERVAL_MS  = 30_000;

const WALLETS = {
  "5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c": "Logjam",
};

const CHAINS = ["solana"];
// ────────────────────────────────────────────────────────

const lastSeen = {};
let lastUpdateId = 0;
const alerted = new Map(); // cooldown tracker

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
      const cmd = text.split(/\s+/)[0].toLowerCase();

      if (cmd === "/help") {
        await sendTelegram(
          `🤖 <b>Logjam Wallet Tracker</b>\n\n` +
          `Monitoring: <b>Logjam</b>\n` +
          `Wallet: <code>5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c</code>\n\n` +
          `Alerts fire on any buy or receive across Solana, Ethereum and BSC.\n` +
          `No MC filter — everything gets alerted.`,
          chatId
        );
      }
    }
  } catch (e) {
    console.error("[CMD ERROR]", e.message);
  }
}

async function getTokenData(mint) {
  try {
    const res = await get(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = res?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    const valid = pairs.filter(p => CHAINS.includes((p.chainId || "").toLowerCase()));
    if (valid.length === 0) return null;
    valid.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));
    return valid[0];
  } catch (e) {
    return null;
  }
}

async function initLastSeen() {
  try {
    const txs = await get(
      `https://api.helius.xyz/v0/addresses/5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c/transactions?api-key=${HELIUS_KEY}&limit=1`
    );
    if (Array.isArray(txs) && txs.length > 0) {
      lastSeen["5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c"] = txs[0].signature;
      console.log(`[INIT] Last seen tx set — only new transactions will alert`);
    }
  } catch (e) {
    console.error("[INIT ERROR]", e.message);
  }
}
  try {
    const txs = await get(
      `https://api.helius.xyz/v0/addresses/${walletAddr}/transactions?api-key=${HELIUS_KEY}&limit=10`
    );
    if (!Array.isArray(txs) || txs.length === 0) return;

    const latestSig = txs[0]?.signature;
    if (lastSeen[walletAddr] === latestSig) return;
    lastSeen[walletAddr] = latestSig;

    for (const tx of txs) {
      const transfers = tx?.tokenTransfers || [];
      const type = tx?.type || "";

      for (const transfer of transfers) {
        const mint = transfer?.mint;
        if (!mint) continue;

        // Skip SOL, USDC, USDT
        if (mint === "So11111111111111111111111111111111111111112") continue;
        if (mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") continue;
        if (mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") continue;

        const isReceived = transfer?.toUserAccount === walletAddr;
        const isBuy = type === "SWAP" && transfer?.toUserAccount === walletAddr;
        if (!isReceived && !isBuy) continue;

        // 1 hour cooldown per token
        const lastAlert = alerted.get(mint) || 0;
        if (Date.now() - lastAlert < 3600_000) continue;
        alerted.set(mint, Date.now());

        const pair = await getTokenData(mint);
        if (!pair) continue;

        const chain      = pair.chainId || "unknown";
        const name       = pair.baseToken?.name || "Unknown";
        const symbol     = pair.baseToken?.symbol || "?";
        const priceUsd   = parseFloat(pair.priceUsd || 0);
        const mcapRaw    = parseFloat(pair.marketCap || 0);
        const mcap       = mcapRaw ? `$${Number(mcapRaw).toLocaleString()}` : "N/A";
        const liq        = `$${Number(pair.liquidity?.usd || 0).toLocaleString()}`;
        const change1h   = pair.priceChange?.h1 != null ? `${pair.priceChange.h1 > 0 ? "+" : ""}${parseFloat(pair.priceChange.h1).toFixed(1)}%` : "N/A";
        const change24h  = pair.priceChange?.h24 != null ? `${pair.priceChange.h24 > 0 ? "+" : ""}${parseFloat(pair.priceChange.h24).toFixed(1)}%` : "N/A";
        const action     = isReceived && type !== "SWAP" ? "🎁 Airdropped" : "💸 Bought";
        const chainLabel = chain === "bsc" ? "BSC" : chain.charAt(0).toUpperCase() + chain.slice(1);
        const dexUrl     = `https://dexscreener.com/${chain}/${pair.pairAddress}`;
        const fomoUrl    = `https://fomo.family/tokens/${chain}/${mint}`;

        const msg =
`👀 <b>LOGJAM ALERT</b>

👤 <b>Logjam</b> — ${action}
🔗 Chain: <b>${chainLabel}</b>
🪙 <b>${name}</b> (<b>$${symbol}</b>)
💰 Market Cap: <b>${mcap}</b>
💵 Price: <b>$${priceUsd.toFixed(8)}</b>
💧 Liquidity: <b>${liq}</b>
📈 1h Change: <b>${change1h}</b>
📈 24h Change: <b>${change24h}</b>

📋 CA: <code>${mint}</code>

🔗 <a href="${dexUrl}">DexScreener</a> | <a href="${fomoUrl}">FOMO</a>

⚠️ DYOR — not financial advice.`;

        await sendTelegram(msg);
        console.log(`[ALERT] Logjam ${action} ${symbol} | MC: ${mcap} | Chain: ${chainLabel}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } catch (e) {
    console.error(`[ERROR] Logjam:`, e.message);
  }
}

async function scan() {
  console.log(`[${new Date().toLocaleTimeString()}] Scanning Logjam...`);
  await checkWallet("5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c", "Logjam");
  console.log(`[${new Date().toLocaleTimeString()}] Scan complete`);
}

// Keep-alive
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("logjam tracker alive");
}).listen(process.env.PORT || 3000, () => console.log(`Ping server on port ${process.env.PORT || 3000}`));

(async () => {
  console.log("👀 Logjam Wallet Tracker started");
  console.log(`   Wallet   : 5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c`);
  console.log(`   Chains   : Solana, Ethereum, BSC`);
  console.log(`   MC filter: None`);
  console.log(`   Interval : ${INTERVAL_MS / 1000}s\n`);
  await sendTelegram(
    `✅ <b>Logjam Wallet Tracker is live!</b>\n\n` +
    `👤 Monitoring: <b>Logjam</b>\n` +
    `🔗 Chains: Solana only\n` +
    `💰 MC filter: None — all tokens alerted\n` +
    `⏱ Scan: every 30 seconds\n\n` +
    `The moment Logjam touches anything, you'll know. 👀`
  );
  await initLastSeen();
  await scan();
  setInterval(scan, INTERVAL_MS);
  setInterval(pollCommands, 3000);
})();
