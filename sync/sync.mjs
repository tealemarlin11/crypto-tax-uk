// Read-only Kraken + Binance history -> exchange-import.csv (for the tax app)
// Run:  node sync.mjs        (Node 18 or newer, no installs needed)
// Keys: put them in sync/.env  (see .env.example). NEVER commit .env.
import crypto from "node:crypto";
import fs from "node:fs";

/* ---------- signing (pure functions, tested with --selftest) ---------- */
export function krakenSign(path, nonce, body, secretB64) {
  const h = crypto.createHash("sha256").update(String(nonce) + body).digest();
  return crypto.createHmac("sha512", Buffer.from(secretB64, "base64"))
    .update(Buffer.concat([Buffer.from(path), h])).digest("base64");
}
if (process.argv[2] === "--selftest") {
  const s = krakenSign("/0/private/AddOrder", "1616492376594",
    "nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25",
    "kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==");
  console.log(s === "4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==" ? "Kraken signing OK" : "Kraken signing FAILED");
  process.exit(0);
}

/* ---------- setup ---------- */
if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { KRAKEN_KEY, KRAKEN_SECRET, BINANCE_KEY, BINANCE_SECRET } = process.env;
const START = new Date(process.env.START_DATE || "2020-01-01").getTime();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ukDate = ms => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(ms)); // UK day, matters for same-day rule
const FIAT = new Set(["GBP", "USD", "EUR", "CAD", "AUD", "CHF", "JPY"]);
const STABLE = new Set(["USDT", "USDC", "FDUSD", "DAI", "TUSD", "BUSD"]);
const rows = [], warns = [], warned = new Set();
const warn = m => { if (!warned.has(m)) { warned.add(m); warns.push(m); console.log("⚠️ ", m); } };
const R = (date, type, asset, qty, gbp, fee, note) => rows.push({ date, type, asset, qty, gbp, fee, note });

/* ---------- GBP prices (3 sources, with fallbacks) ---------- */
const pc = {}, fxc = {};
let binanceDown = false, binFails = 0;
async function kline(symbol, ms) {
  if (binanceDown) return null;
  const t = Math.floor(ms / 6e4) * 6e4;
  try {
    const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${t}&limit=1`);
    if (r.status === 400) return null;                       // symbol does not exist: normal
    if (!r.ok) { if (++binFails >= 3) { binanceDown = true; warn(`Binance price service is not reachable (HTTP ${r.status}). Using Kraken and Frankfurter prices instead.`); } return null; }
    const j = await r.json(); return Array.isArray(j) && j[0] ? +j[0][4] : null;
  } catch { if (++binFails >= 3) { binanceDown = true; warn("Binance price service is not reachable. Using Kraken and Frankfurter prices instead."); } return null; }
}
// fiat or stablecoin -> GBP, using daily ECB rates from Frankfurter
async function fxToGbp(cur, ms) {
  const c = STABLE.has(cur) ? "USD" : cur, d = ukDate(ms), k = c + d; if (k in fxc) return fxc[k];
  let rate = null;
  for (const base of ["https://api.frankfurter.dev/v1/", "https://api.frankfurter.app/"]) {
    try { const r = await fetch(`${base}${d}?base=${c}&symbols=GBP`); if (r.ok) { rate = (await r.json()).rates?.GBP ?? null; if (rate) break; } } catch {}
  }
  fxc[k] = rate; await sleep(100); return rate;
}
// crypto -> GBP using Kraken public candles (hourly if recent, daily if older)
const toKraken = a => ({ BTC: "XBT", DOGE: "XDG" }[a] || a);
async function krakenCandle(pair, ms) {
  const ageDays = (Date.now() - ms) / 864e5; if (ageDays > 650) return null;
  const iv = ageDays < 25 ? 60 : 1440, since = Math.floor(ms / 1000) - iv * 120;
  try {
    const r = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${iv}&since=${since}`); const j = await r.json();
    if (j.error?.length) return null; const key = Object.keys(j.result).find(x => x !== "last"); const c = j.result[key]; if (!c?.length) return null;
    const t = ms / 1000; let pick = c[0]; for (const x of c) if (x[0] <= t) pick = x; return +pick[4];
  } catch { return null; }
}
async function gbpPrice(asset, ms) {
  if (asset === "GBP") return 1;
  if (FIAT.has(asset) || STABLE.has(asset)) return fxToGbp(asset, ms);
  const k = asset + "|" + Math.floor(ms / 6e4); if (k in pc) return pc[k];
  let p = await kline(asset + "GBP", ms);
  if (p == null) { const u = await kline(asset + "USDT", ms), g = u != null ? await kline("GBPUSDT", ms) : null; if (u != null && g) p = u / g; }
  if (p == null) p = await krakenCandle(toKraken(asset) + "GBP", ms);
  if (p == null) { const u = await krakenCandle(toKraken(asset) + "USD", ms); if (u != null) { const fx = await fxToGbp("USD", ms); if (fx) p = u * fx; } }
  pc[k] = p; await sleep(80); return p;
}

/* ---------- turn one trade into app rows ---------- */
async function emitTrade(t) {
  const date = ukDate(t.ms); let V = null;
  if (t.quote === "GBP") V = t.quoteQty;
  else { const p = await gbpPrice(t.quote, t.ms); if (p != null) V = t.quoteQty * p;
         else { const pb = await gbpPrice(t.base, t.ms); if (pb != null) V = t.baseQty * pb; } }
  if (V == null) { warn(`No GBP price for ${t.base}/${t.quote} on ${date} (${t.src}:${t.id}). Value set to 0. Fix by hand.`); V = 0; }
  let fee = 0, baseQty = t.baseQty;
  if (t.feeQty) {
    if (t.feeAsset === t.base && t.side === "buy") baseQty -= t.feeQty;   // fee taken from coins received
    else { const p = await gbpPrice(t.feeAsset, t.ms);
      if (p != null) fee = t.feeQty * p; else warn(`No GBP price for fee asset ${t.feeAsset}. Some fees on ${t.src} are set to 0.`);
      if (!FIAT.has(t.feeAsset) && t.feeAsset !== t.base && t.feeAsset !== t.quote)
        warn(`Fees paid in ${t.feeAsset} are treated as extra cost only. Strictly, spending ${t.feeAsset} is also a small disposal.`); }
  }
  const id = `${t.src}:${t.id}`;
  if (t.side === "buy") { R(date, "buy", t.base, baseQty, V, fee, id + ":buy"); if (!FIAT.has(t.quote)) R(date, "sell", t.quote, t.quoteQty, V, 0, id + ":sell"); }
  else { R(date, "sell", t.base, baseQty, V, fee, id + ":sell"); if (!FIAT.has(t.quote)) R(date, "buy", t.quote, t.quoteQty, V, 0, id + ":buy"); }
}

/* ---------- KRAKEN ---------- */
const KMAP = { XXBT:"BTC", XBT:"BTC", XETH:"ETH", ETH2:"ETH", XLTC:"LTC", XXRP:"XRP", XXLM:"XLM", XXMR:"XMR", XETC:"ETC", XZEC:"ZEC", XXDG:"DOGE", XDG:"DOGE", XREP:"REP", XMLN:"MLN", ZGBP:"GBP", ZUSD:"USD", ZEUR:"EUR", ZCAD:"CAD", ZJPY:"JPY", ZAUD:"AUD", ZCHF:"CHF" };
const kAsset = a => { a = a.replace(/\.(S|M|F|B|P)$/, ""); return KMAP[a] || a; };
let kn = 0;
async function kraken(path, params = {}) {
  for (let tries = 0; tries < 5; tries++) {
    const nonce = Date.now() * 1000 + (++kn);
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const r = await fetch("https://api.kraken.com" + path, { method: "POST",
      headers: { "API-Key": KRAKEN_KEY, "API-Sign": krakenSign(path, nonce, body, KRAKEN_SECRET), "Content-Type": "application/x-www-form-urlencoded" }, body });
    const j = await r.json();
    if (j.error?.length) {
      if (j.error.some(e => /rate limit|Throttled/i.test(e))) { console.log("Kraken says slow down. Waiting 30s..."); await sleep(30000); continue; }
      throw new Error("Kraken " + path + ": " + j.error.join(", "));
    }
    await sleep(5000); return j.result;
  }
  throw new Error("Kraken kept rate limiting. Try again later.");
}
async function runKraken() {
  console.log("Kraken: loading pairs...");
  const pairs = (await (await fetch("https://api.kraken.com/0/public/AssetPairs")).json()).result;
  const pmap = {}; for (const [k, v] of Object.entries(pairs)) { pmap[k] = v; pmap[v.altname] = v; }
  let ofs = 0, total = Infinity, n = 0;
  while (ofs < total) {
    const res = await kraken("/0/private/TradesHistory", { ofs });
    total = res.count; const ids = Object.keys(res.trades); if (!ids.length) break;
    for (const id of ids) { const t = res.trades[id], p = pmap[t.pair];
      let pp = p;
      if (!pp) { // old or renamed pair: split the name using a known quote asset
        const q = ["USDT", "USDC", "XBT", "ETH", "GBP", "USD", "EUR"].find(x => t.pair.endsWith(x) && t.pair.length > x.length + 1);
        if (q) { pp = { base: t.pair.slice(0, -q.length), quote: q }; warn(`Kraken pair ${t.pair} guessed as ${pp.base}/${pp.quote}. Check these rows.`); }
        else { warn(`Kraken pair ${t.pair} not recognised (${id}). Add it by hand.`); continue; } }
      await emitTrade({ src: "kraken", id, ms: t.time * 1000, base: kAsset(pp.base), quote: kAsset(pp.quote), side: t.type,
        baseQty: +t.vol, quoteQty: +t.cost, feeAsset: kAsset(pp.quote), feeQty: +t.fee }); n++; }
    ofs += ids.length; console.log(`Kraken trades: ${Math.min(ofs, total)}/${total}`);
  }
  ofs = 0; total = Infinity; let inc = 0;
  while (ofs < total) {
    const res = await kraken("/0/private/Ledgers", { ofs, start: Math.floor(START / 1000) });
    total = res.count; const ids = Object.keys(res.ledger); if (!ids.length) break;
    for (const id of ids) { const l = res.ledger[id], amt = +l.amount - +l.fee, ms = l.time * 1000, a = kAsset(l.asset);
      const reward = (l.type === "staking" && amt > 0) || (l.type === "earn" && l.subtype === "reward");
      if (reward) { const p = await gbpPrice(a, ms); if (p == null) warn(`No GBP price for staking reward ${a} (${id}).`);
        R(ukDate(ms), "income", a, amt, (p ?? 0) * amt, 0, `kraken:${id}:income`); inc++; }
      else if (["transfer", "receive", "credit", "adjustment"].includes(l.type) && amt > 0 && !/staking|earn|spot/i.test(l.subtype || ""))
        warn(`Kraken ${l.type}${l.subtype ? "/" + l.subtype : ""}: +${amt} ${a} on ${ukDate(ms)} (${id}). Check if this is taxable (airdrop? gift?).`); }
    ofs += ids.length; console.log(`Kraken ledger: ${Math.min(ofs, total)}/${total}`);
  }
  console.log(`Kraken done: ${n} trades, ${inc} rewards.`);
}

/* ---------- BINANCE ---------- */
async function binance(path, params = {}) {
  for (let tries = 0; tries < 4; tries++) {
    const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 60000 }).toString();
    const sig = crypto.createHmac("sha256", BINANCE_SECRET).update(q).digest("hex");
    const r = await fetch(`https://api.binance.com${path}?${q}&signature=${sig}`, { headers: { "X-MBX-APIKEY": BINANCE_KEY } });
    const j = await r.json();
    if (!r.ok) {
      if (r.status === 429 || r.status === 418 || j.code === -1003) { console.log("Binance says slow down. Waiting 90s..."); await sleep(90000); continue; }
      throw new Error(`Binance ${path}: ${JSON.stringify(j)}`);
    }
    await sleep(300); return j;
  }
  throw new Error(`Binance ${path}: still rate limited after waiting. Try again in an hour.`);
}
// run one stage; if it fails, note it and carry on with the rest
async function safe(label, fn) { try { await fn(); } catch (e) { warn(`Binance step "${label}" failed and was skipped: ${e.message.slice(0, 200)}`); } }
async function windows(days, fn) {
  const step = days * 864e5; for (let s = START; s < Date.now(); s += step) await fn(s, Math.min(s + step - 1, Date.now()));
}
async function runBinance() {
  console.log("Binance: discovering assets...");
  const assets = new Set((process.env.BINANCE_EXTRA_ASSETS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
  const acct = await binance("/api/v3/account"); acct.balances.forEach(b => { if (+b.free + +b.locked > 0) assets.add(b.asset); });
  await safe("deposit and withdrawal history", () => windows(90, async (s, e) => {
    for (const l of await binance("/sapi/v1/capital/deposit/hisrec", { startTime: s, endTime: e, limit: 1000 })) assets.add(l.coin);
    for (const l of await binance("/sapi/v1/capital/withdraw/history", { startTime: s, endTime: e, limit: 1000 })) assets.add(l.coin);
  }));
  // rewards, airdrops, staking, savings interest
  let inc = 0;
  await safe("rewards and airdrops", () => windows(90, async (s, e) => {
    const r = await binance("/sapi/v1/asset/assetDividend", { startTime: s, endTime: e, limit: 500 });
    for (const d of r.rows || []) { assets.add(d.asset); const p = await gbpPrice(d.asset, d.divTime);
      if (p == null) warn(`No GBP price for ${d.asset} reward (${d.id}).`);
      R(ukDate(d.divTime), "income", d.asset, +d.amount, (p ?? 0) * +d.amount, 0, `binance:div${d.id || d.tranId}:income`); inc++;
      if (!/staking|interest|reward|airdrop|distribution|dividend/i.test(d.enInfo || "")) warn(`Binance payout "${d.enInfo}" ${d.amount} ${d.asset}. Check it is income.`); }
  }));
  // Binance Convert
  if (process.env.BINANCE_CONVERT !== "yes") warn("Binance Convert swaps were skipped. If you used Convert, set BINANCE_CONVERT=yes in .env and set START_DATE to when you started on Binance.");
  else await safe("Convert swaps", () => windows(30, async (s, e) => {
    await sleep(15000);
    const r = await binance("/sapi/v1/convert/tradeFlow", { startTime: s, endTime: e, limit: 1000 });
    for (const c of r.list || []) { if (c.orderStatus !== "SUCCESS") continue; assets.add(c.fromAsset); assets.add(c.toAsset);
      await emitTrade({ src: "binance", id: "convert" + c.orderId, ms: c.createTime, base: c.toAsset, quote: c.fromAsset, side: "buy",
        baseQty: +c.toAmount, quoteQty: +c.fromAmount, feeAsset: "", feeQty: 0 }); }
  }));
  // spot trades: find symbols for every asset I ever touched
  const info = (await (await fetch("https://api.binance.com/api/v3/exchangeInfo")).json()).symbols;
  const bySym = Object.fromEntries(info.map(s => [s.symbol, s]));
  const quotes = ["GBP", "USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB", "EUR", "TUSD", "BUSD"];
  const syms = new Set((process.env.BINANCE_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean));
  for (const a of assets) for (const q of quotes) { if (bySym[a + q]) syms.add(a + q); if (bySym[q + a]) syms.add(q + a); }
  console.log(`Binance: checking ${syms.size} trading pairs...`); let n = 0;
  for (const sym of syms) {
    const s = bySym[sym]; if (!s) { warn(`Unknown Binance symbol ${sym}.`); continue; }
    let from = 0;
    while (true) {
      const list = await binance("/api/v3/myTrades", { symbol: sym, fromId: from, limit: 1000 });
      for (const t of list) { await emitTrade({ src: "binance", id: `${sym}-${t.id}`, ms: t.time, base: s.baseAsset, quote: s.quoteAsset,
        side: t.isBuyer ? "buy" : "sell", baseQty: +t.qty, quoteQty: +t.quoteQty, feeAsset: t.commissionAsset, feeQty: +t.commission }); n++; }
      if (list.length < 1000) break; from = list.at(-1).id + 1;
    }
  }
  console.log(`Binance done: ${n} trades, ${inc} rewards.`);
  warn("Binance card purchases, P2P, margin and futures are NOT included. Add those by hand or CSV.");
}

/* ---------- run ---------- */
(async () => {
  if (!(KRAKEN_KEY && KRAKEN_SECRET) && !(BINANCE_KEY && BINANCE_SECRET)) { console.log("No keys found. Copy .env.example to .env and fill it in."); return; }
  if (KRAKEN_KEY && KRAKEN_SECRET) await runKraken().catch(e => console.log("❌", e.message));
  if (BINANCE_KEY && BINANCE_SECRET) await runBinance().catch(e => console.log("❌", e.message));
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const csv = "date,type,asset,quantity,gbp,fee,notes\n" + rows.map(r =>
    [r.date, r.type, r.asset, +r.qty.toFixed(10), r.gbp.toFixed(2), r.fee.toFixed(2), r.note].join(",")).join("\n") + "\n";
  fs.writeFileSync("exchange-import.csv", csv);
  if (warns.length) fs.writeFileSync("exchange-warnings.txt", warns.join("\n") + "\n");
  console.log(`\n✅ Wrote exchange-import.csv (${rows.length} rows).` + (warns.length ? ` ⚠️ ${warns.length} things to check in exchange-warnings.txt` : ""));
})();
