// Engine: runs inside a Web Worker (off the screen thread). Owns the connections, the order book and the candle/footprint
// aggregation, and sends the screen one small "frame" every 100 ms. Also importable in Node for tests (createEngine).
//
// Spot markets (XAUUSD, XAGUSD): the flow comes from the Binance perpetual; every price is shown as
//   spot price = perp price - offset,   offset = live (perp mid - spot mid), smoothed over ~20 s and rounded to one heatmap
// row ($0.05 for gold). The offset only changes when the smoothed gap moves by more than 3/4 of a row, and then every stored
// trade, book level and candle is moved by the same whole number of ticks, so nothing is ever mixed between two offsets.
//
// Candle times follow TradingView (core.js candleClock: 1m-1h on whole UTC minutes/hours, 4h on the chosen symbol's
// New York session). Footprints of 1h and 4h candles: past days from Binance's complete daily trade files (kept per hour
// as volume per $0.05 row, cached on the device), today from live / recorded / downloaded trades.
import { MARKETS, Book, Trades, Candles, toTick, idNum, candleClock, makeOffAt } from './core.js';
import { connect, binanceKlines, binanceMid, binancePerpAt, spotQuote, binanceDayHours, spotMinutes, binancePerpMinutes } from './feeds.js';

export const FRAME_MS = 100, COL_BINS = 320;
let KEEP_MS = 26 * 3600e3;                                       // trades kept in memory
// minutes of trade history to load for each candle size (footprint cells need trades)
export const HIST_MIN = { 60000: 60, 300000: 180, 900000: 360, 3600000: 360, 14400000: 720 };
export const FILE_DAYS = { 3600000: 2, 14400000: 6 };            // days of daily files behind 1h / 4h footprints
const BIG = tf => tf >= 3600000;
const gcd = (a, b) => b ? gcd(b, a % b) : a;

export function createEngine(post) {
  let mk = null, conn = null, book = null, tr = null, cand = null, timer = null, spotTimer = null, gen = 0, key = null;
  let tf = 300000, session = 'oanda', clock = null, bucketTicks = 1, binTicks = 1, rowTicks = 1, proxy = null;
  let seen = new Set(), ring = [], ringAt = 0;
  let newT = [], dirty = new Set(), liqNew = [];
  let stat = null, delays = [], msgs = 0, lastPrune = 0;
  let klines = new Map(), kl1h = new Map(), klF = 0, keys = null;  // exchange candles (tf < 1h by candle key; 1h by UTC hour)
  let fileHours = new Map(), fileDays = new Set(), fileUntil = 0;  // daily-file hours (exchange ticks, rows of rowTicks)
  let off = 0, ema = null, spot = null, closedTs = null, closedPerp = null;
  // trades are stored in EXCHANGE ticks; shown (spot) price = exchange ticks - offAt(time of the trade)
  let offHist = new Map(), offDays = new Set(), segs = [], offAt = () => 0;
  const sp = (t, p) => p - offAt(t);
  const setOffAt = () => { offAt = mk && mk.spot ? makeOffAt(offHist, segs) : () => 0; };

  const want = () => {
    let m = HIST_MIN[tf] || 60;
    if (BIG(tf) && mk.ex === 'binance') m = Math.max(m, (Date.now() % 864e5) / 60000 + 10);   // today since 00:00 UTC (files cover before)
    return m;
  };

  async function open(k, o = {}) {
    close();
    const g = gen; key = k;
    mk = MARKETS[k]; if (!mk) return post({ type: 'error', msg: 'unknown market ' + k });
    tf = o.tf || 300000; session = o.session || 'oanda'; proxy = o.proxy || null; if (o.keepMs) KEEP_MS = o.keepMs;
    clock = candleClock(tf, session);
    bucketTicks = Math.max(1, Math.round((o.bucket || mk.bucket) / mk.tick));
    binTicks = Math.max(1, Math.round(mk.bin / mk.tick));
    rowTicks = mk.buckets.map(b => Math.round(b / mk.tick)).reduce(gcd, binTicks);
    book = new Book(mk.tick); tr = new Trades(); cand = new Candles(tf, bucketTicks, clock);
    seen = new Set(); ring = new Array(60000); ringAt = 0; newT = []; dirty = new Set(); liqNew = [];
    klines = new Map(); kl1h = new Map(); klF = 0; keys = null; fileHours = new Map(); fileDays = new Set(); fileUntil = 0;
    off = 0; ema = null; spot = null; closedTs = null; offHist = new Map(); offDays = new Set(); segs = []; setOffAt();
    stat = { conn: 'connecting', book: 'waiting', note: '', gaps: 0, lastGap: '', crossed: 0, delay: null, msgs: 0, synced: false, spot: null };
    delays = []; msgs = 0;
    post({ type: 'reset', key: k, tf, bucketTicks, binTicks, trades: new Float64Array(0), candles: [] });
    if (mk.spot) {                                               // first spot reading before any data, so the start is already in spot prices
      try { const [q, pm] = await Promise.all([spotQuote(mk.spot, proxy), binanceMid(mk.sym)]); if (g !== gen) return; await readSpot(q, pm); off = Math.round(ema / mk.bin) * binTicks; book.off = off; stat.spot = { ...spot, off: off * mk.tick }; segs = [{ t: Date.now(), off }]; setOffAt(); postOffs(true); }
      catch (e) { stat.spot = { err: e.message }; }
      if (g !== gen) return;
      spotTimer = setInterval(pollSpot, 1000);
    }
    // trades the recorder (laptop or phone) already holds: much faster than the exchange and covers screen-off time
    const w = o.backfillMin ?? want();
    let pre = o.preload || null;
    if (!pre && proxy) { pre = await recTrades(k, Date.now() - w * 60000); if (g !== gen) return; }
    if (pre) pre.sort((a, b) => a[0] - b[0] || idNum(a[4]) - idNum(b[4]));
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
    for (const [n, f] of Object.entries(handlers)) guarded[n] = (...a) => { if (g === gen) f(...a); };
    conn = connect(mk, guarded, { backfillMin: w, oldest });
    timer = setInterval(frame, FRAME_MS);
    loadKlines(g); loadFiles(g); loadOffsets(g);
    if (oldest && proxy) setTimeout(async () => {                 // fill the moment between the recorder's last trade and our live start
      const seam = await recTrades(k, recLast - 2000); if (g === gen && seam && seam.length) handlers.trades(seam, true);
    }, 4000);
  }
  let recLast = 0;
  async function recTrades(k, from, to = 0) {
    try {
      const r = await fetch(`${proxy}rec/trades?key=${encodeURIComponent(k)}&from=${Math.floor(from)}${to ? '&to=' + Math.floor(to) : ''}`);
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
    const mid = (q.bid + q.ask) / 2, isOpen = Date.now() - q.ts < 90000;   // no new quote for 90 s = market shut (weekend, daily break)
    let perp = perpNow;
    if (!isOpen) { if (closedTs !== q.ts) { closedTs = q.ts; closedPerp = await binancePerpAt(mk.sym, q.ts); } perp = closedPerp; }
    if (perp == null) return;
    const gap = perp - mid;
    ema = (ema === null || !isOpen) ? gap : ema + (gap - ema) * 0.05;     // ~20 s smoothing while open; frozen at the last quote when shut
    spot = { open: isOpen, mid, bid: q.bid, ask: q.ask, ts: q.ts, gap: ema, raw: gap };
  }
  let polling = false;
  async function pollSpot() {
    if (polling || !stat.synced) return; polling = true; const g = gen;
    try {
      const q = await spotQuote(mk.spot, proxy); if (g !== gen) return;
      const [bb, ba] = book.best(); if (!(bb > -Infinity && ba < Infinity)) return;
      await readSpot(q, ((bb + ba) / 2 + off) * mk.tick); if (g !== gen) return;
      const w = Math.round(ema / mk.bin) * binTicks;
      if (w !== off && Math.abs(ema / mk.tick - off) > 0.75 * binTicks) shift(w - off);
      stat.spot = { ...spot, off: off * mk.tick };
    } catch (e) { stat.spot = { ...(spot || {}), err: e.message, off: off * mk.tick }; }
    finally { polling = false; }
  }
  function shift(d) {                                            // live gap moved: new trades and the live book use the new offset;
    off += d; book.shift(d);                                     // stored trades keep the offset of their own time
    segs.push({ t: Date.now(), off }); setOffAt(); postOffs(false);
  }
  function postOffs(withHist) { post({ type: 'offs', segs: segs.map(x => [x.t, x.off]), hist: withHist ? [...offHist] : null }); }
  // spot history for the stored trades: perp 1m close - Dukascopy spot mid, 15-minute median, rounded to a heatmap row
  async function loadOffsets(g) {
    if (!mk.spot) return;
    const days = (BIG(tf) ? FILE_DAYS[tf] || 2 : 1) + 1, today = Math.floor(Date.now() / 864e5) * 864e5;
    stat.spotHist = { need: days, have: 0 };
    for (let i = 0; i < days; i++) {                             // newest day first: recent candles are right soonest
      const day = today - i * 864e5; if (offDays.has(day)) { stat.spotHist.have++; continue; }
      let s = null, p = null;
      try { s = await spotMinutes(mk.spot, day, proxy); if (g !== gen) return; if (s && s.size) p = await binancePerpMinutes(mk.sym, day); }
      catch (e) { stat.note = 'spot history: ' + e.message; }
      if (g !== gen) return;
      if (!s || !p) continue;                                    // weekend day / not reachable: the nearest measured value is used
      const mins = [...s.keys()].filter(m => p.has(m)).sort((a, b) => a - b), gaps = mins.map(m => p.get(m) - s.get(m));
      for (let j = 0; j < mins.length; j++) { const w = gaps.slice(Math.max(0, j - 7), j + 8).sort((a, b) => a - b); offHist.set(mins[j], Math.round(w[w.length >> 1] / mk.bin) * binTicks); }
      if (i > 0) offDays.add(day);                               // today is fetched again next time (it is still growing)
      stat.spotHist.have++;
      setOffAt(); postOffs(true);                                // re-price stored trades with the measured offsets
      const a = packTrades(); post({ type: 'reset', keep: true, tf, bucketTicks, binTicks, trades: a, candles: [] }, [a.buffer]);
      rebuild();
    }
    if (g === gen) stat.spotHist.done = true;
  }

  // ------------------------------------------------------------------ feed handlers
  const handlers = {
    trades(list) {
      const fresh = [];
      for (const x of list) {
        const id = idNum(x[4]);
        if (id) { if (seen.has(id)) continue; seen.add(id); const old = ring[ringAt]; if (old !== undefined) seen.delete(old); ring[ringAt] = id; ringAt = (ringAt + 1) % ring.length; }
        fresh.push([x[0], x[1], x[2], x[3], id]);
      }
      if (!fresh.length) return;
      fresh.sort((a, b) => a[0] - b[0]);
      const lastT = tr.n ? tr.t[tr.n - 1] : -Infinity;
      if (fresh[0][0] >= lastT) for (const x of fresh) add(x[0], toTick(x[1], mk.tick), x[2], x[3], x[4]);
      else merge(fresh);                                       // older trades (history): merge and rebuild once
    },
    book(kind, bids, asks) {
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

  // trades before fileUntil are already inside the daily-file hours of 1h/4h candles, so they are not added twice
  const counts = t => !BIG(tf) || t >= fileUntil;
  function add(t, p, q, s, id = 0) {
    tr.push(t, p, q, s, id);
    const ps = sp(t, p);
    if (counts(t)) { const before = cand.list.length, c = cand.add(t, ps, q, s); dirty.add(c.k); if (cand.list.length !== before) keys = null; }
    newT.push(t, ps, q, s);
  }
  function merge(fresh) {
    if (tr.n && fresh[fresh.length - 1][0] <= tr.t[0]) {       // all older than what we hold (history paging backwards): put in front
      const old = tr; tr = new Trades(Math.max(1 << 16, (old.n + fresh.length) * 2));
      const a = new Float64Array(fresh.length * 4);
      fresh.forEach((x, j) => { const p = toTick(x[1], mk.tick); tr.push(x[0], p, x[2], x[3], x[4]); a[4 * j] = x[0]; a[4 * j + 1] = sp(x[0], p); a[4 * j + 2] = x[2]; a[4 * j + 3] = x[3]; });
      for (let i = 0; i < old.n; i++) tr.push(old.t[i], old.p[i], old.q[i], old.s[i], old.id[i]);
      post({ type: 'prepend', trades: a }, [a.buffer]);
      return rebuild();
    }
    const n = tr.n, all = new Array(n + fresh.length);
    for (let i = 0; i < n; i++) all[i] = [tr.t[i], tr.p[i], tr.q[i], tr.s[i], tr.id[i]];
    for (let j = 0; j < fresh.length; j++) { const x = fresh[j]; all[n + j] = [x[0], toTick(x[1], mk.tick), x[2], x[3], x[4]]; }
    all.sort((a, b) => a[0] - b[0] || a[4] - b[4]);             // time, then exchange id (ids rise with time on every exchange used)
    tr = new Trades(Math.max(1 << 16, all.length * 2));
    for (const x of all) tr.push(x[0], x[1], x[2], x[3], x[4]);
    newT = [];
    const a = packTrades();
    post({ type: 'reset', keep: true, tf, bucketTicks, binTicks, trades: a, candles: [] }, [a.buffer]);
    rebuild();
  }
  function rebuild() {                                           // candles from stored trades (after merge, shift, new tf/bucket/files)
    cand = new Candles(tf, bucketTicks, clock);
    for (let i = 0; i < tr.n; i++) if (counts(tr.t[i])) cand.add(tr.t[i], sp(tr.t[i], tr.p[i]), tr.q[i], tr.s[i]);
    dirty.clear(); keys = null;
    post({ type: 'candles', tf, bucketTicks, candles: viewAll() });
  }
  function packTrades() { const a = new Float64Array(tr.n * 4); for (let i = 0; i < tr.n; i++) { a[4 * i] = tr.t[i]; a[4 * i + 1] = sp(tr.t[i], tr.p[i]); a[4 * i + 2] = tr.q[i]; a[4 * i + 3] = tr.s[i]; } return a; }

  // ------------------------------------------------------------------ exchange candles and daily files
  async function loadKlines(g) {
    if (mk.ex !== 'binance') return;
    try {
      if (BIG(tf)) { const list = await binanceKlines(mk.sym, 3600000, 1000); if (g !== gen) return; kl1h = new Map(list.map(x => [Math.floor(x.t / 3600e3), x])); }
      else { const list = await binanceKlines(mk.sym, tf, 500); if (g !== gen) return; klines = new Map(list.map(x => [clock.keyOf(x.t), x])); }
      klF = Date.now(); keys = null; post({ type: 'candles', tf, bucketTicks, candles: viewAll() });
    } catch (e) { stat.note = 'candle history failed: ' + e.message; }
  }
  async function loadFiles(g) {
    if (mk.ex !== 'binance' || !BIG(tf)) return;
    const days = FILE_DAYS[tf] || 2, today = Math.floor(Date.now() / 864e5) * 864e5;
    for (let i = days; i >= 1; i--) {
      const day = today - i * 864e5, name = new Date(day).toISOString().slice(0, 10);
      if (fileDays.has(day)) continue;
      let hrs = await cacheGet(mk.sym, day, rowTicks); if (g !== gen) return;
      if (!hrs) {
        stat.note = `downloading ${name} trade file`;
        try { hrs = await binanceDayHours(mk.sym, day, mk.tick, rowTicks, n => { if (g === gen) stat.note = `reading ${name}: ${(n / 1e6).toFixed(1)} M trades`; }); }
        catch (e) { stat.note = `daily file ${name}: ${e.message}`; hrs = null; }
        if (g !== gen) return;
        if (hrs) cachePut(mk.sym, day, rowTicks, hrs);
      }
      if (!hrs) continue;                                        // not published yet (yesterday's appears during the morning UTC)
      for (const x of hrs) fileHours.set(x.h, x);
      fileDays.add(day); fileUntil = Math.max(fileUntil, day + 864e5);
      rebuild();
    }
    if (g === gen) stat.note = `footprint history: ${fileDays.size} day file(s) + live trades`;
  }

  const allKeys = () => {
    if (keys) return keys;
    const s = new Set(cand.byKey.keys());
    if (BIG(tf)) {
      let first = Infinity; for (const h of fileHours.keys()) { s.add(clock.keyOf(h * 3600e3)); first = Math.min(first, h); }
      const from = Math.min(first, tr.n ? Math.floor(tr.t[0] / 3600e3) : Infinity);
      for (const h of kl1h.keys()) if (h >= from) s.add(clock.keyOf(h * 3600e3));
    } else for (const k of klines.keys()) s.add(k);
    return keys = [...s].sort((a, b) => a - b);
  };
  const lbT = x => { let lo = 0, hi = tr.n; while (lo < hi) { const m = (lo + hi) >> 1; if (tr.t[m] < x) lo = m + 1; else hi = m; } return lo; };

  // one candle (tf < 1h) as the screen sees it. Fully covered by loaded trades -> exact from trades, with footprint cells.
  // Otherwise -> OHLC/volume/delta from the exchange candle, cells only for the part the trades cover (partial, cellsFrom).
  function view(k) {
    const c = cand.byKey.get(k), kl = klines.get(k), start = clock.startOf(k), end = clock.startOf(k + 1), cov = tr.n ? tr.t[0] : Infinity;
    if (c && (start >= cov || !kl)) { const p = Candles.pack(c); p.partial = start < cov; p.cellsFrom = p.partial ? cov : null; return p; }
    if (!kl) return null;
    const ko = offAt(start), K = x => toTick(x, mk.tick) - ko;
    const v = { k, t0: start, o: K(kl.o), h: K(kl.h), l: K(kl.l), c: K(kl.c), v: kl.v, d: kl.d, dmin: null, dmax: null, n: kl.n, cells: [], partial: true, cellsFrom: null };
    if (c) {
      const cp = Candles.pack(c); v.cells = cp.cells; v.cellsFrom = Math.max(cov, start);
      if (klF < end) for (let i = lbT(klF + 1); i < tr.n && tr.t[i] < end; i++) { const p = sp(tr.t[i], tr.p[i]); v.v += tr.q[i]; v.d += tr.s[i] * tr.q[i]; v.n++; if (p > v.h) v.h = p; if (p < v.l) v.l = p; v.c = p; }
    }
    return v;
  }
  // one 1h / 4h candle: daily-file hours (before fileUntil), then exchange 1h candles for any hour between the files and the
  // loaded trades (price/volume/delta only), then trades. Cells come from files + trades.
  function viewBig(k) {
    const start = clock.startOf(k), end = clock.startOf(k + 1), now = Date.now(), cov = tr.n ? Math.max(tr.t[0], fileUntil) : Infinity;
    const v = { k, t0: start, o: null, h: -Infinity, l: Infinity, c: null, v: 0, d: 0, dmin: null, dmax: null, n: 0, cells: [], partial: false, cellsFrom: null };
    const cells = new Map(); let cellsFrom = null, parts = 0;
    const push = (o, h, l, c, vol, d, n) => { if (v.o === null) v.o = o; if (h > v.h) v.h = h; if (l < v.l) v.l = l; v.c = c; v.v += vol; v.d += d; v.n += n; parts++; };
    const cell = (b, s, bu) => { let e = cells.get(b); if (!e) { e = [0, 0]; cells.set(b, e); } e[0] += s; e[1] += bu; };
    for (let h = Math.floor(start / 3600e3); h * 3600e3 < end && h * 3600e3 < now; h++) {
      const hs = h * 3600e3, he = hs + 3600e3, x = hs < fileUntil ? fileHours.get(h) : null, oh = offAt(hs + 1800e3), K = z => toTick(z, mk.tick) - oh;
      if (x) {
        push(x.o - oh, x.hi - oh, x.lo - oh, x.c - oh, x.v, x.d, x.n); if (cellsFrom === null) cellsFrom = hs;
        for (let i = 0; i < x.cells.length; i += 3) cell(Math.floor((x.cells[i] * rowTicks - oh) / bucketTicks), x.cells[i + 1], x.cells[i + 2]);
        continue;
      }
      if (hs >= fileUntil && he > cov) continue;                 // covered by trades (below)
      const kl = kl1h.get(h);                                    // no file and no trades for this hour: exchange 1h candle, no cells
      if (kl) push(K(kl.o), K(kl.h), K(kl.l), K(kl.c), kl.v, kl.d, kl.n);
      v.partial = true;
    }
    const c = cand.byKey.get(k);
    if (c) {
      if (start < cov && Math.floor(cov / 3600e3) * 3600e3 !== cov && cov > start && cov < end && cov > fileUntil) v.partial = true;   // trades start inside an hour
      const solo = parts === 0;
      push(c.o, c.h, c.l, c.c, c.v, c.d, c.n);
      for (const [b, e] of c.cells) cell(b, e[0], e[1]);
      if (cellsFrom === null) cellsFrom = Math.max(start, cov);
      if (solo && start >= cov) { v.dmin = c.dmin; v.dmax = c.dmax; }
    }
    if (v.o === null) return null;
    for (const [b, e] of cells) v.cells.push(b, e[0], e[1]);
    v.cellsFrom = v.partial ? cellsFrom : null;
    return v;
  }
  function viewAll(only) {                                       // with CVD summed across all candles in order
    let cum = 0; const out = [];
    for (const k of allKeys()) { const v = BIG(tf) ? viewBig(k) : view(k); if (!v) continue; cum += v.d; v.cvd = cum; if (!only || only.has(k)) out.push(v); }
    return out;
  }

  function config(o) {                                          // new timeframe, bucket or TradingView session
    const tfChanged = o.tf && o.tf !== tf, sessChanged = o.session && o.session !== session;
    if (o.tf) tf = o.tf;
    if (o.session) session = o.session;
    if (o.bucket) bucketTicks = Math.max(1, Math.round(o.bucket / mk.tick));
    if (tfChanged || sessChanged) { clock = candleClock(tf, session); klines = new Map(); keys = null; loadKlines(gen); }
    if (tfChanged) { extendHistory(want()); loadFiles(gen); }
    rebuild();
  }
  async function extendHistory(min) {                            // bigger timeframe: older trades from the recorder first, then the exchange
    const g = gen, from = Date.now() - min * 60000;
    if (proxy && tr.n && tr.t[0] > from) {
      const older = await recTrades(key, from, tr.t[0]); if (g !== gen) return;
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
      col = { t: now - dl, lo, data, bb, ba, last: tr.n ? sp(tr.t[tr.n - 1], tr.p[tr.n - 1]) : null };   // time on the exchange clock (local minus median delay)
      if (now - lastPrune > 10000) { lastPrune = now; book.prune((bb + ba) / 2, Math.max(2000, Math.round((bb + ba) / 2 * 0.03))); }
    }
    const trades = Float64Array.from(newT); newT = [];
    let candles = [];
    if (dirty.size) { candles = viewAll(dirty); dirty.clear(); }
    const liqs = Float64Array.from(liqNew); liqNew = [];
    stat.delay = dl; stat.msgs = msgs * (1000 / FRAME_MS); msgs = 0; stat.histFrom = tr.n ? tr.t[0] : null; stat.fileDays = fileDays.size;
    if (tr.n && tr.t[0] < now - KEEP_MS - 600000) { let i = 0; while (i < tr.n && tr.t[i] < now - KEEP_MS) i++; tr.dropBefore(i); cand.trim(3000); keys = null; }
    const msg = { type: 'frame', col, trades, candles, liqs, stat: { ...stat } };
    const transfer = [trades.buffer, liqs.buffer]; if (col) transfer.push(col.data.buffer);
    post(msg, transfer);
  }

  return {
    on(m) { if (m.type === 'open') open(m.key, m); else if (m.type === 'config') config(m); else if (m.type === 'close') close(); },
    debug: () => ({ mk, book, tr, cand, stat, off, spot, klines, kl1h, fileHours, fileUntil, clock, rowTicks, view, viewBig, viewAll, offAt, offHist, segs }),
    // for the recorder: trades from..to as [time, exchange price, size, side, id] (exchange price = shown price + offset)
    tradesBetween(from, to = Infinity) {
      if (!tr) return new Float64Array(0);
      let i = lbT(from); const out = [];
      for (; i < tr.n && tr.t[i] <= to; i++) out.push(tr.t[i], tr.p[i] * mk.tick, tr.q[i], tr.s[i], tr.id[i]);
      return Float64Array.from(out);
    },
  };
}

// ------------------------------------------------------------------ cache of daily-file hours on the device (IndexedDB)
function idb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(res => { const r = indexedDB.open('orderflow', 1); r.onupgradeneeded = () => r.result.createObjectStore('days'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
}
async function cacheGet(sym, day, rowTicks) {
  const db = await idb(); if (!db) return null;
  return new Promise(res => { try { const q = db.transaction('days').objectStore('days').get(`${sym}:${day}:${rowTicks}`); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); } });
}
async function cachePut(sym, day, rowTicks, hrs) {
  const db = await idb(); if (!db) return;
  try {
    const st = db.transaction('days', 'readwrite').objectStore('days');
    st.put(hrs, `${sym}:${day}:${rowTicks}`);
    const keysReq = st.getAllKeys(); keysReq.onsuccess = () => { for (const k of keysReq.result) if (+String(k).split(':')[1] < day - 10 * 864e5) st.delete(k); };
  } catch { }
}

// Worker entry
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  const e = createEngine((m, t) => self.postMessage(m, t || []));
  const proxy = new URL('./', self.location.href).href;          // the local server (serve.mjs / the phone app) answers /spot, /rec
  self.onmessage = ev => e.on(ev.data.type === 'open' ? { ...ev.data, proxy } : ev.data);
}
