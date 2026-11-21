// Engine: runs inside a Web Worker (off the screen thread). Owns the connections, the order book and the candle/footprint
// aggregation, and sends the screen one small "frame" every 100 ms. Also importable in Node for tests (createEngine).
//
// Spot markets (XAUUSD, XAGUSD): the flow comes from the Binance perpetual; every price is shown as
//   spot price = perp price - offset,   offset = live (perp mid - spot mid), smoothed over ~20 s and rounded to one heatmap
// row ($0.05 for gold). The offset only changes when the smoothed gap moves by more than 3/4 of a row, and then every stored
// trade, book level and candle is moved by the same whole number of ticks, so nothing is ever mixed between two offsets.
import { MARKETS, Book, Trades, Candles, toTick, idNum } from './core.js';
import { connect, binanceKlines, binanceMid, binancePerpAt, spotQuote } from './feeds.js';

export const FRAME_MS = 100, COL_BINS = 320;
let KEEP_MS = 13 * 3600e3;                                       // trades kept in memory (recorder passes 26 h)
// minutes of trade history to load for each candle size (footprint cells need trades); candle OHLC/delta further back come
// from exchange candles (Binance klines carry taker-buy volume, so their delta is exact)
export const HIST_MIN = { 15000: 60, 60000: 60, 300000: 120, 900000: 240, 3600000: 360, 14400000: 720 };

export function createEngine(post) {
  let mk = null, conn = null, book = null, tr = null, cand = null, timer = null, spotTimer = null, gen = 0;
  let tf = 60000, bucketTicks = 1, binTicks = 1, proxy = null;
  let seen = new Set(), ring = [], ringAt = 0;
  let newT = [], dirty = new Set(), liqNew = [];
  let stat = null, delays = [], msgs = 0, lastPrune = 0;
  let klines = new Map(), klF = 0, keys = null;                 // exchange candles, when they were fetched, sorted key cache
  let off = 0, ema = null, spot = null, closedTs = null, closedPerp = null;

  async function open(key, o = {}) {
    close();
    const g = gen;
    mk = MARKETS[key]; if (!mk) return post({ type: 'error', msg: 'unknown market ' + key });
    tf = o.tf || 60000; proxy = o.proxy || null; if (o.keepMs) KEEP_MS = o.keepMs;
    bucketTicks = Math.max(1, Math.round((o.bucket || mk.bucket) / mk.tick));
    binTicks = Math.max(1, Math.round(mk.bin / mk.tick));
    book = new Book(mk.tick); tr = new Trades(); cand = new Candles(tf, bucketTicks);
    seen = new Set(); ring = new Array(60000); ringAt = 0; newT = []; dirty = new Set(); liqNew = [];
    klines = new Map(); klF = 0; keys = null; off = 0; ema = null; spot = null; closedTs = null;
    stat = { conn: 'connecting', book: 'waiting', note: '', gaps: 0, lastGap: '', crossed: 0, delay: null, msgs: 0, synced: false, spot: null };
    delays = []; msgs = 0;
    post({ type: 'reset', key, tf, bucketTicks, binTicks, trades: new Float64Array(0), candles: [] });
    if (mk.spot) {                                               // first spot reading before any data, so the start is already in spot prices
      try { const [q, pm] = await Promise.all([spotQuote(mk.spot, proxy), binanceMid(mk.sym)]); if (g !== gen) return; await readSpot(q, pm); off = Math.round(ema / mk.bin) * binTicks; book.off = off; stat.spot = { ...spot, off: off * mk.tick }; }
      catch (e) { stat.spot = { err: e.message }; }
      if (g !== gen) return;
      spotTimer = setInterval(pollSpot, 1000);
    }
    // trades the laptop recorder already holds (it runs all the time): much faster than the exchange and covers screen-off time
    const want = o.backfillMin ?? HIST_MIN[tf] ?? 60;
    let pre = o.preload || null;
    if (!pre && proxy) { pre = await recTrades(key, Date.now() - want * 60000); if (g !== gen) return; }
    if (pre) pre.sort((a, b) => a[0] - b[0] || idNum(a[4]) - idNum(b[4]));   // the phone recorder returns rows in file order
    let oldest = null;
    if (pre && pre.length) {
      handlers.trades(pre, true); oldest = { id: idNum(pre[0][4]), t: pre[0][0], newestId: idNum(pre[pre.length - 1][4]), holes: [] }; recLast = pre[pre.length - 1][0]; stat.rec = true;
      if (mk.ex === 'binance') {                                 // Binance trade ids are consecutive: any jump inside the saved trades is a hole to fill
        const ids = pre.map(x => idNum(x[4])).filter(Boolean).sort((a, b) => a - b);
        for (let i = 1; i < ids.length && oldest.holes.length < 100; i++) if (ids[i] > ids[i - 1] + 1) oldest.holes.push([ids[i - 1] + 1, ids[i] - 1]);
      }
    }
    // every connection gets its own generation number: late messages from a closed connection (the previous market) are dropped
    const guarded = {};
    for (const [k, f] of Object.entries(handlers)) guarded[k] = (...a) => { if (g === gen) f(...a); };
    conn = connect(mk, guarded, { backfillMin: want, oldest });
    timer = setInterval(frame, FRAME_MS);
    loadKlines(g);
    if (oldest && proxy) setTimeout(async () => {                 // fill the moment between the recorder's last trade and our live start
      const seam = await recTrades(key, recLast - 2000); if (g === gen && seam && seam.length) handlers.trades(seam, true);
    }, 4000);
  }
  let recLast = 0;
  async function recTrades(key, from, to = 0) {
    try {
      const r = await fetch(`${proxy}rec/trades?key=${encodeURIComponent(key)}&from=${Math.floor(from)}${to ? '&to=' + Math.floor(to) : ''}`);
      if (!r.ok) return null;
      const a = new Float64Array(await r.arrayBuffer()), out = [];
      for (let i = 0; i + 4 < a.length; i += 5) out.push([a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4]]);
      return out;
    } catch { return null; }
  }
  function close() { gen++; if (conn) conn.close(); conn = null; clearInterval(timer); clearInterval(spotTimer); timer = spotTimer = null; }

  // ------------------------------------------------------------------ spot price and offset
  async function readSpot(q, perpNow) {
    if (!q || !(q.bid > 0)) throw new Error('no spot quote');
    const mid = (q.bid + q.ask) / 2, open = Date.now() - q.ts < 90000;   // no new quote for 90 s = market shut (weekend, daily break)
    let perp = perpNow;
    if (!open) { if (closedTs !== q.ts) { closedTs = q.ts; closedPerp = await binancePerpAt(mk.sym, q.ts); } perp = closedPerp; }
    if (perp == null) return;
    const gap = perp - mid;
    ema = (ema === null || !open) ? gap : ema + (gap - ema) * 0.05;     // ~20 s smoothing while open; frozen at the last quote when shut
    spot = { open, mid, bid: q.bid, ask: q.ask, ts: q.ts, gap: ema, raw: gap };
  }
  let polling = false;
  async function pollSpot() {
    if (polling || !stat.synced) return; polling = true; const g = gen;
    try {
      const q = await spotQuote(mk.spot, proxy); if (g !== gen) return;
      const [bb, ba] = book.best(); if (!(bb > -Infinity && ba < Infinity)) return;
      await readSpot(q, ((bb + ba) / 2 + off) * mk.tick); if (g !== gen) return;
      const want = Math.round(ema / mk.bin) * binTicks;
      if (want !== off && Math.abs(ema / mk.tick - off) > 0.75 * binTicks) shift(want - off);
      stat.spot = { ...spot, off: off * mk.tick };
    } catch (e) { stat.spot = { ...(spot || {}), err: e.message, off: off * mk.tick }; }
    finally { polling = false; }
  }
  function shift(d) {                                            // move everything by -d ticks
    off += d; book.shift(d);
    for (let i = 0; i < tr.n; i++) tr.p[i] -= d;
    for (let i = 1; i < newT.length; i += 4) newT[i] -= d;
    for (let i = 1; i < liqNew.length; i += 4) liqNew[i] -= d;
    post({ type: 'shift', d });
    rebuild();
  }

  // ------------------------------------------------------------------ feed handlers
  const handlers = {
    trades(list, history) {
      const fresh = [];
      for (const x of list) {
        const id = idNum(x[4]);
        if (id) { if (seen.has(id)) continue; seen.add(id); const old = ring[ringAt]; if (old !== undefined) seen.delete(old); ring[ringAt] = id; ringAt = (ringAt + 1) % ring.length; }
        fresh.push([x[0], x[1], x[2], x[3], id]);
      }
      if (!fresh.length) return;
      fresh.sort((a, b) => a[0] - b[0]);
      const lastT = tr.n ? tr.t[tr.n - 1] : -Infinity;
      if (fresh[0][0] >= lastT) for (const x of fresh) add(x[0], toTick(x[1], mk.tick) - off, x[2], x[3], x[4]);
      else merge(fresh);                                       // older trades (history): merge and rebuild once
    },
    book(kind, bids, asks, ts) {
      if (kind === 'reset') book.clear();
      for (const [p, q] of bids) book.set(0, +p, +q);
      for (const [p, q] of asks) book.set(1, +p, +q);
      msgs++;
      if (book.crossed()) stat.crossed++;
    },
    liq(x) { liqNew.push(x[0], toTick(x[1], mk.tick) - off, x[2], x[3]); },
    status(s) { Object.assign(stat, s); if (s.book) stat.synced = s.book === 'synced'; },
    recv(ts) { if (ts) { delays.push(Date.now() - ts); if (delays.length > 400) delays.splice(0, 200); } msgs++; },
    gap(why) { stat.gaps++; stat.lastGap = why; },
  };

  function add(t, p, q, s, id = 0) {
    tr.push(t, p, q, s, id);
    const before = cand.list.length, c = cand.add(t, p, q, s); dirty.add(c.k);
    if (cand.list.length !== before) keys = null;
    newT.push(t, p, q, s);
  }
  function merge(fresh) {
    if (tr.n && fresh[fresh.length - 1][0] <= tr.t[0]) {       // all older than what we hold (history paging backwards): put in front
      const old = tr; tr = new Trades(Math.max(1 << 16, (old.n + fresh.length) * 2));
      const a = new Float64Array(fresh.length * 4);
      fresh.forEach((x, j) => { const p = toTick(x[1], mk.tick) - off; tr.push(x[0], p, x[2], x[3], x[4]); a[4 * j] = x[0]; a[4 * j + 1] = p; a[4 * j + 2] = x[2]; a[4 * j + 3] = x[3]; });
      for (let i = 0; i < old.n; i++) tr.push(old.t[i], old.p[i], old.q[i], old.s[i], old.id[i]);
      post({ type: 'prepend', trades: a }, [a.buffer]);
      return rebuild();
    }
    const n = tr.n, all = new Array(n + fresh.length);
    for (let i = 0; i < n; i++) all[i] = [tr.t[i], tr.p[i], tr.q[i], tr.s[i], tr.id[i]];
    for (let j = 0; j < fresh.length; j++) { const x = fresh[j]; all[n + j] = [x[0], toTick(x[1], mk.tick) - off, x[2], x[3], x[4]]; }
    all.sort((a, b) => a[0] - b[0] || a[4] - b[4]);             // time, then exchange id (ids rise with time on every exchange used)
    tr = new Trades(Math.max(1 << 16, all.length * 2));
    for (const x of all) tr.push(x[0], x[1], x[2], x[3], x[4]);
    newT = [];
    const a = packTrades();
    post({ type: 'reset', keep: true, tf, bucketTicks, binTicks, trades: a, candles: [] }, [a.buffer]);
    rebuild();
  }
  function rebuild() {                                           // candles from stored trades (after merge, shift, new tf/bucket)
    cand = new Candles(tf, bucketTicks);
    for (let i = 0; i < tr.n; i++) cand.add(tr.t[i], tr.p[i], tr.q[i], tr.s[i]);
    dirty.clear(); keys = null;
    post({ type: 'candles', tf, bucketTicks, candles: viewAll() });
  }
  function packTrades() { const a = new Float64Array(tr.n * 4); for (let i = 0; i < tr.n; i++) { a[4 * i] = tr.t[i]; a[4 * i + 1] = tr.p[i]; a[4 * i + 2] = tr.q[i]; a[4 * i + 3] = tr.s[i]; } return a; }

  // ------------------------------------------------------------------ exchange candles merged with trade candles
  async function loadKlines(g) {
    if (mk.ex !== 'binance') return;
    try { const list = await binanceKlines(mk.sym, tf, 500); if (g !== gen) return; klines = new Map(list.map(x => [x.k, x])); klF = Date.now(); keys = null; post({ type: 'candles', tf, bucketTicks, candles: viewAll() }); }
    catch (e) { stat.note = 'candle history failed: ' + e.message; }
  }
  const allKeys = () => { if (!keys) keys = [...new Set([...cand.byKey.keys(), ...klines.keys()])].sort((a, b) => a - b); return keys; };
  const lbT = x => { let lo = 0, hi = tr.n; while (lo < hi) { const m = (lo + hi) >> 1; if (tr.t[m] < x) lo = m + 1; else hi = m; } return lo; };
  // one candle as the screen sees it. Fully covered by loaded trades -> exact from trades, with footprint cells.
  // Otherwise -> OHLC/volume/delta from the exchange candle (plus trades that came after it was fetched), cells only for
  // the part that trades cover (partial = true, cellsFrom = where the cells start).
  function view(k) {
    const c = cand.byKey.get(k), kl = klines.get(k), start = k * tf, cov = tr.n ? tr.t[0] : Infinity;
    if (c && (start >= cov || !kl)) { const p = Candles.pack(c); p.partial = start < cov; p.cellsFrom = p.partial ? cov : null; return p; }
    const K = x => toTick(x, mk.tick) - off;
    const v = { k, o: K(kl.o), h: K(kl.h), l: K(kl.l), c: K(kl.c), v: kl.v, d: kl.d, dmin: null, dmax: null, n: kl.n, cells: [], partial: true, cellsFrom: null };
    if (c) {
      const cp = Candles.pack(c); v.cells = cp.cells; v.cellsFrom = Math.max(cov, start);
      if (klF < (k + 1) * tf) {                                  // candle still running when the exchange candle was fetched
        for (let i = lbT(klF + 1); i < tr.n && tr.t[i] < (k + 1) * tf; i++) { const p = tr.p[i]; v.v += tr.q[i]; v.d += tr.s[i] * tr.q[i]; v.n++; if (p > v.h) v.h = p; if (p < v.l) v.l = p; v.c = p; }
      }
    }
    return v;
  }
  function viewAll(only) {                                       // with CVD summed across all candles in order
    let cum = 0; const out = [];
    for (const k of allKeys()) { const v = view(k); cum += v.d; v.cvd = cum; if (!only || only.has(k)) out.push(v); }
    return out;
  }

  function config(o) {                                          // new timeframe or bucket
    const tfChanged = o.tf && o.tf !== tf;
    if (o.tf) tf = o.tf;
    if (o.bucket) bucketTicks = Math.max(1, Math.round(o.bucket / mk.tick));
    if (tfChanged) { klines = new Map(); extendHistory(HIST_MIN[tf] || 60); loadKlines(gen); }
    rebuild();
  }
  async function extendHistory(min) {                            // bigger timeframe: older trades from the recorder first, then the exchange
    const g = gen, from = Date.now() - min * 60000;
    if (proxy && tr.n && tr.t[0] > from) {
      const older = await recTrades(Object.keys(MARKETS).find(k => MARKETS[k] === mk), from, tr.t[0]); if (g !== gen) return;
      if (older && older.length) { handlers.trades(older, true); if (conn && conn.setOldest) conn.setOldest(idNum(older[0][4]), older[0][0]); }
    }
    if (conn && conn.extend) conn.extend(min);
  }

  function frame() {
    if (!mk) return;
    const now = Date.now();
    const dl = delays.length ? [...delays].sort((a, b) => a - b)[delays.length >> 1] : 0;
    let col = null;
    const [bb, ba] = book.best();
    if (stat.synced && bb > -Infinity && ba < Infinity) {
      const midBin = Math.floor((bb + ba) / 2 / binTicks), lo = midBin - COL_BINS / 2;
      const data = book.column(lo, COL_BINS, binTicks, new Float32Array(COL_BINS));
      col = { t: now - dl, lo, data, bb, ba, last: tr.n ? tr.p[tr.n - 1] : null };   // time on the exchange clock (local minus median delay)
      if (now - lastPrune > 10000) { lastPrune = now; book.prune((bb + ba) / 2, Math.max(2000, Math.round((bb + ba) / 2 * 0.03))); }
    }
    const trades = Float64Array.from(newT); newT = [];
    let candles = [];
    if (dirty.size) { candles = viewAll(dirty); dirty.clear(); }
    const liqs = Float64Array.from(liqNew); liqNew = [];
    stat.delay = dl; stat.msgs = msgs * (1000 / FRAME_MS); msgs = 0; stat.histFrom = tr.n ? tr.t[0] : null;
    if (tr.n && tr.t[0] < now - KEEP_MS - 600000) { let i = 0; while (i < tr.n && tr.t[i] < now - KEEP_MS) i++; tr.dropBefore(i); cand.trim(3000); keys = null; }
    const msg = { type: 'frame', col, trades, candles, liqs, stat: { ...stat } };
    const transfer = [trades.buffer, liqs.buffer]; if (col) transfer.push(col.data.buffer);
    post(msg, transfer);
  }

  return {
    on(m) { if (m.type === 'open') open(m.key, m); else if (m.type === 'config') config(m); else if (m.type === 'close') close(); },
    debug: () => ({ mk, book, tr, cand, stat, off, spot, klines, view, viewAll }),
    // for the recorder: trades from..to as [time, exchange price, size, side, id] (exchange price = shown price + offset)
    tradesBetween(from, to = Infinity) {
      if (!tr) return new Float64Array(0);
      let i = lbT(from); const out = [];
      for (; i < tr.n && tr.t[i] <= to; i++) out.push(tr.t[i], (tr.p[i] + off) * mk.tick, tr.q[i], tr.s[i], tr.id[i]);
      return Float64Array.from(out);
    },
  };
}

// Worker entry
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  const e = createEngine((m, t) => self.postMessage(m, t || []));
  const proxy = new URL('./', self.location.href).href;          // the local server (serve.mjs) answers /spot
  self.onmessage = ev => e.on(ev.data.type === 'open' ? { ...ev.data, proxy } : ev.data);
}
