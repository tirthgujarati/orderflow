// Exchange connectors. Each one turns an exchange's public feed into the same small set of calls:
//   h.trades([[timeMs, price, size, side(+1 buy aggressor / -1 sell aggressor), id], ...])   live or history, any order
//   h.book('reset' | 'delta', bids[[price,size]], asks[[price,size]], exchTimeMs)          sizes are absolute; 0 = remove
//   h.liq([timeMs, price, size, side])          side -1 = forced selling (longs liquidated), +1 = forced buying
//   h.status({ conn, book, note })   h.recv(exchTimeMs)   h.gap(reason)
// Runs in a Web Worker and in Node 22+ (both have WebSocket and fetch).

const BYBIT_REST = 'https://api.bytick.com';        // api.bybit.com does not answer on some Indian networks; bytick is Bybit's alternate host
const num = x => +x;

export function connect(mk, h, opt = {}) {
  if (mk.ex === 'binance') return binance(mk, h, opt);
  if (mk.ex === 'bybit') return bybit(mk, h, opt);
  if (mk.ex === 'hl') return hyperliquid(mk, h, opt);
  throw new Error('unknown exchange ' + mk.ex);
}

// ------------------------------------------------------------------------------------------------ Binance USD-M futures
// Book: diff stream + REST snapshot, synced by update ids (U <= lastUpdateId <= u for the first event, then pu == previous u).
// Trades: aggTrade (m = buyer is maker, so the aggressor sold). Since 2026 trades live on /market, book data on /public.
function binance(mk, h, { backfillMin = 60, oldest = null } = {}) {
  const s = mk.sym.toLowerCase(); let closed = false, wsB = null, wsT = null, buf = [], state = 'wait', L = 0, lastU = 0, gen = 0, retryB = 0, retryT = 0;
  const base = 'https://fapi.binance.com/fapi/v1';
  function openBook() {
    if (closed) return;
    wsB = new WebSocket(`wss://fstream.binance.com/public/stream?streams=${s}@depth@100ms`);
    wsB.onopen = () => { retryB = 0; h.status({ conn: 'book open' }); resync('start'); };
    wsB.onmessage = m => {
      const d = JSON.parse(m.data).data; if (!d || d.e !== 'depthUpdate') return;
      h.recv(d.E);
      if (state !== 'live' && state !== 'first') { buf.push(d); return; }
      apply(d);
    };
    wsB.onclose = () => { if (closed) return; state = 'wait'; h.status({ conn: 'book closed', book: 'down' }); setTimeout(openBook, backoff(retryB++)); };
    wsB.onerror = () => {};
  }
  function apply(d) {
    if (state === 'first') {
      if (d.u < L) return;                                   // older than the snapshot
      if (d.U > L) return resync('first event after snapshot is too new');
      state = 'live';
    } else if (d.pu !== lastU) return resync(`update chain broken (pu ${d.pu} != ${lastU})`);
    lastU = d.u;
    h.book('delta', d.b, d.a, d.E);
  }
  async function resync(why) {
    const my = ++gen; state = 'snap'; buf = [];
    if (why !== 'start') h.gap(why);
    h.status({ book: 'syncing' });
    try {
      const j = await (await fetch(`${base}/depth?symbol=${mk.sym}&limit=1000`)).json();
      if (my !== gen || closed) return;
      L = j.lastUpdateId; h.book('reset', j.bids, j.asks, j.E || Date.now());
      state = 'first'; const pend = buf; buf = [];
      for (const d of pend) { if (state === 'snap') break; apply(d); }
      h.status({ book: 'synced' });
    } catch (e) { if (my === gen && !closed) setTimeout(() => resync('snapshot failed: ' + e.message), 2000); }
  }
  function openTrades() {
    if (closed) return;
    wsT = new WebSocket(`wss://fstream.binance.com/market/stream?streams=${s}@aggTrade/${s}@forceOrder`);
    wsT.onopen = () => { retryT = 0; h.status({ conn: 'live' }); };
    wsT.onmessage = m => {
      const j = JSON.parse(m.data), d = j.data; if (!d) return;
      if (d.e === 'aggTrade') {
        h.recv(d.E); h.trades([[d.T, num(d.p), num(d.q), d.m ? -1 : 1, d.a]]);
        // aggTrade ids are consecutive: a jump means trades were missed (reconnect, laptop asleep, recorder was off) -> fetch them
        if (lastId !== null && d.a > lastId + 1) fillGap(lastId + 1, d.a - 1);
        if (lastId === null || d.a > lastId) lastId = d.a;
        if (firstLive === null) { firstLive = d.a; backfill(); }   // history must reach this id, so nothing falls between the two
      }
      else if (d.e === 'forceOrder') { const o = d.o; h.liq([o.T, num(o.ap) || num(o.p), num(o.z) || num(o.q), o.S === 'SELL' ? -1 : 1]); }
    };
    wsT.onclose = () => { if (closed) return; h.status({ conn: 'trades closed' }); setTimeout(openTrades, backoff(retryT++)); };
    wsT.onerror = () => {};
  }
  // History: walk BACKWARDS from the first live trade id (aggTrade ids are consecutive), 1000 trades per request, until
  // the wanted start time. Newest history arrives first, so the screen fills from now backwards. aggTrades costs 20 of
  // Binance's 2400 weight per minute (shared by everything on this IP), so requests are paced to ~0.8 per second after a burst of 10.
  let firstLive = null, oldestId = null, oldestT = Infinity, loading = false, wantMin = backfillMin;
  let lastId = oldest && oldest.newestId ? oldest.newestId : null;   // newest trade we already hold (from the recorder / disk)
  const gaps = [];                                                   // id ranges still to fetch, filled one after another
  function fillGap(a, b) { gaps.push([a, b]); if (gaps.length === 1) runGaps(); }
  async function runGaps() {
    while (gaps.length && !closed) {
      const [a, b] = gaps[0]; let from = a, pages = 0;
      h.status({ note: `filling ${(b - a + 1).toLocaleString()} missed trades` });
      try {
        while (from <= b && !closed) {
          const n = Math.min(1000, b - from + 1);
          const page = await getJSON(`${base}/aggTrades?symbol=${mk.sym}&fromId=${from}&limit=${n}`);
          if (!Array.isArray(page) || !page.length) break;
          h.trades(page.filter(d => d.a <= b).map(d => [d.T, num(d.p), num(d.q), d.m ? -1 : 1, d.a]), true);
          from = page[page.length - 1].a + 1;
          if (++pages >= 10) await sleep(1200);
        }
        h.status({ note: `filled ${(b - a + 1).toLocaleString()} missed trades` });
      } catch (e) { h.status({ note: 'gap fill paused: ' + e.message }); await sleep(30000); continue; }
      gaps.shift();
    }
  }
  async function backfill() {
    if (!wantMin || loading || firstLive === null) return;
    loading = true;
    try {
      if (oldestId === null && oldest && oldest.id) { oldestId = oldest.id; oldestT = oldest.t; }   // the laptop recorder already gave us trades back to here
      if (oldestId === null) {
        if (firstLive === Infinity) { const j = await getJSON(`${base}/aggTrades?symbol=${mk.sym}&limit=1`); firstLive = j.length ? j[0].a + 1 : 0; }
        oldestId = firstLive;
      }
      let chunk = [], pages = 0; const t0 = Date.now() - wantMin * 60000, tStart = oldestT === Infinity ? Date.now() : oldestT;
      while (!closed && oldestT > t0 && oldestId > 0) {
        const from = Math.max(0, oldestId - 1000);
        const page = await getJSON(`${base}/aggTrades?symbol=${mk.sym}&fromId=${from}&limit=${oldestId - from}`);
        if (!Array.isArray(page) || !page.length) break;
        for (const d of page) chunk.push([d.T, num(d.p), num(d.q), d.m ? -1 : 1, d.a]);
        oldestId = page[0].a; oldestT = page[0].T; pages++;
        if (pages % 8 === 0 || pages === 2) { h.trades(chunk, true); chunk = []; }
        h.status({ note: `loading history ${Math.min(99, Math.round((tStart - oldestT) / (tStart - t0) * 100))}%`, histFrom: oldestT });
        if (pages >= 10) await sleep(1200);                      // ~1,000 of Binance's 2,400 weight per minute: room for the app and the recorder
      }
      if (chunk.length && !closed) h.trades(chunk, true);
      if (!closed) h.status({ note: `history from ${new Date(oldestT).toISOString().slice(11, 16)} UTC`, histFrom: oldestT });
    } catch (e) { h.status({ note: 'history paused: ' + e.message }); }
    loading = false;
  }
  openBook(); openTrades();
  if (oldest && oldest.holes) for (const [a, b] of oldest.holes) fillGap(a, b);   // holes inside what the recorder / disk already had
  const quiet = setTimeout(() => { if (firstLive === null) { firstLive = Infinity; backfill(); } }, 8000);   // no trade for 8 s: load history anyway
  return {
    close() { closed = true; gen++; clearTimeout(quiet); wsB && wsB.close(); wsT && wsT.close(); },
    extend(min) { if (min > wantMin) { wantMin = min; backfill(); } },          // more history for a bigger timeframe
    setOldest(id, t) { if (!loading && id && t < oldestT) { oldestId = id; oldestT = t; } },   // recorder delivered older trades
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// reconnect wait: 1.5 s, 3 s, 6 s ... up to 30 s (so a dropped network does not cause a flood of attempts)
const backoff = n => Math.min(30000, 1500 * 2 ** Math.min(n, 5));
// fetch JSON; on Binance's rate-limit answers (429/418) wait as told, then retry
async function getJSON(url, tries = 4) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if ((r.status === 429 || r.status === 418) && i < tries) { await sleep((+r.headers.get('retry-after') || 30) * 1000); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
}

// Binance candles with taker-buy volume, so delta per candle is exact: delta = 2 * taker buy volume - volume
const KL = { 60000: '1m', 300000: '5m', 900000: '15m', 3600000: '1h', 14400000: '4h' };
export async function binanceKlines(sym, tfMs, limit = 500) {
  if (!KL[tfMs]) return [];
  const j = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${KL[tfMs]}&limit=${limit}`);
  return j.map(x => ({ k: Math.floor(x[0] / tfMs), o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5], d: 2 * +x[9] - +x[5], n: x[8] }));
}
export async function binancePerpAt(sym, tsMs) {                // close of the 1-minute candle holding tsMs
  const j = await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${Math.floor(tsMs / 60000) * 60000}&limit=1`);
  return j.length ? +j[0][4] : null;
}
export async function binanceMid(sym) { const j = await getJSON(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${sym}`); return (+j.bidPrice + +j.askPrice) / 2; }

// ------------------------------------------------------------------------------------------------ Spot XAUUSD / XAGUSD
// Swissquote (a Swiss bank) publishes its live spot bid/ask. Its server does not allow web pages to read it, so the app
// asks the local server (serve.mjs /spot) which fetches it; Node tests fetch it directly. Mid = (bid + ask) / 2 of the
// "prime" profile (the mark-up is symmetric, so the mid is the market mid).
export const SPOT_OK = new Set(['XAU/USD', 'XAG/USD']);
export const swissquoteUrl = inst => `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${inst}`;
export function parseSwissquote(j) {
  let best = null;
  for (const pl of j || []) for (const sp of pl.spreadProfilePrices || []) {
    const q = { bid: +sp.bid, ask: +sp.ask, ts: +pl.ts };
    if (sp.spreadProfile === 'prime' && (!best || q.ts > best.ts)) best = q;
  }
  return best;
}
export async function spotQuote(inst, proxy) {
  if (proxy) return getJSON(`${proxy}spot?i=${encodeURIComponent(inst)}`);
  return parseSwissquote(await getJSON(swissquoteUrl(inst)));
}

// ------------------------------------------------------------------------------------------------ Bybit V5 linear
// Book: orderbook.200 (100 ms): snapshot then deltas, update id u must rise by exactly 1 (u = 1 or a snapshot = reset).
function bybit(mk, h, { backfillMin = 60, oldest = null } = {}) {
  if (oldest) backfillMin = 0;                                   // the laptop recorder has more history than Bybit's last 1,000 trades
  let closed = false, ws = null, ping = null, lastU = 0, bookOk = false, retry = 0;
  const bookTopic = `orderbook.200.${mk.sym}`;
  const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  function open() {
    if (closed) return;
    ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.onopen = () => {
      retry = 0; h.status({ conn: 'live', book: 'syncing' });
      send({ op: 'subscribe', args: [bookTopic, `publicTrade.${mk.sym}`, `allLiquidation.${mk.sym}`] });
      clearInterval(ping); ping = setInterval(() => send({ op: 'ping' }), 20000);
    };
    ws.onmessage = m => {
      const j = JSON.parse(m.data); const tp = j.topic; if (!tp) return;
      if (tp === bookTopic) {
        const d = j.data; h.recv(j.ts);
        if (j.type === 'snapshot' || d.u === 1) { lastU = d.u; bookOk = true; h.book('reset', d.b, d.a, j.ts); h.status({ book: 'synced' }); return; }
        if (!bookOk) return;
        if (d.u !== lastU + 1) {                               // missed an update: ask for a fresh snapshot
          bookOk = false; h.gap(`update id jump ${lastU} -> ${d.u}`); h.status({ book: 'syncing' });
          send({ op: 'unsubscribe', args: [bookTopic] }); send({ op: 'subscribe', args: [bookTopic] }); return;
        }
        lastU = d.u; h.book('delta', d.b, d.a, j.ts);
      } else if (tp.startsWith('publicTrade.')) {
        h.recv(j.ts);
        h.trades(j.data.map(x => [x.T, num(x.p), num(x.v), x.S === 'Buy' ? 1 : -1, x.i]));
        if (!started) { started = true; backfill(); }            // REST history fetched after the stream runs, so they overlap
      } else if (tp.startsWith('allLiquidation.')) {
        for (const x of j.data) h.liq([x.T, num(x.p), num(x.v), x.S === 'Buy' ? -1 : 1]);   // "Buy" = a long position was liquidated
      }
    };
    ws.onclose = () => { clearInterval(ping); bookOk = false; if (closed) return; h.status({ conn: 'closed', book: 'down' }); setTimeout(open, backoff(retry++)); };
    ws.onerror = () => {};
  }
  // history: Bybit's public REST gives only the latest 1000 trades
  async function backfill() {
    if (!backfillMin) return;
    try {
      const j = await (await fetch(`${BYBIT_REST}/v5/market/recent-trade?category=linear&symbol=${mk.sym}&limit=1000`)).json();
      const out = (j.result && j.result.list || []).map(x => [+x.time, num(x.price), num(x.size), x.side === 'Buy' ? 1 : -1, x.execId]);
      if (!closed) { h.trades(out, true); h.status({ note: `history ${out.length} trades (Bybit gives the last 1000)` }); }
    } catch (e) { h.status({ note: 'history failed: ' + e.message }); }
  }
  let started = false;
  open();
  const quiet = setTimeout(() => { if (!started) { started = true; backfill(); } }, 8000);
  return { close() { closed = true; clearTimeout(quiet); clearInterval(ping); ws && ws.close(); } };
}

// ------------------------------------------------------------------------------------------------ Hyperliquid (HIP-3 "xyz" markets)
// Book: l2Book sends the full top-20 book every time, so each message is a reset. Trades: side "B" = buyer was the aggressor.
// The first trades message after subscribing is a snapshot of recent trades (used as history).
// Measured 21 Nov 2026: for xyz markets the stream pushes l2Book only every ~10 s while the REST book changes every ~2 s,
// so the book is also polled from REST once a second; whichever copy is newer wins.
function hyperliquid(mk, h) {
  let closed = false, ws = null, ping = null, bookT = 0, retry = 0;
  const useBook = (d, src) => { if (d.time <= bookT) return; bookT = d.time; h.recv(d.time); h.book('reset', d.levels[0].map(x => [x.px, x.sz]), d.levels[1].map(x => [x.px, x.sz]), d.time); h.status({ book: 'synced' }); };
  const poll = setInterval(async () => {
    if (closed) return;
    try { const j = await (await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: mk.sym }) })).json(); if (j && j.levels) useBook(j, 'rest'); } catch {}
  }, 1000);
  const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
  function open() {
    if (closed) return;
    ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
    ws.onopen = () => {
      retry = 0; h.status({ conn: 'live', book: 'syncing' });
      for (const type of ['l2Book', 'trades']) send({ method: 'subscribe', subscription: { type, coin: mk.sym } });
      clearInterval(ping); ping = setInterval(() => send({ method: 'ping' }), 30000);
    };
    ws.onmessage = m => {
      const j = JSON.parse(m.data);
      if (j.channel === 'l2Book') useBook(j.data, 'ws');
      else if (j.channel === 'trades') {
        const list = j.data.map(x => [x.time, num(x.px), num(x.sz), x.side === 'B' ? 1 : -1, x.tid]);
        if (list.length) h.recv(list[list.length - 1][0]);
        h.trades(list);
      }
    };
    ws.onclose = () => { clearInterval(ping); if (closed) return; h.status({ conn: 'closed', book: 'down' }); setTimeout(open, backoff(retry++)); };
    ws.onerror = () => {};
  }
  open();
  return { close() { closed = true; clearInterval(ping); clearInterval(poll); ws && ws.close(); } };
}
