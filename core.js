// Order-flow core: market presets, order book, trade aggregation. No DOM, no network: runs in the worker and in Node tests.
// Prices are kept as integer ticks (Math.round(price / tick)) so every bucket and level is exact.

export const MARKETS = {
  // Spot XAUUSD / XAGUSD prices (Swissquote live mid) with the order flow of the deepest gold/silver book (Binance futures):
  // every perp price is moved by the live perp-minus-spot gap (rounded to the heatmap row, see engine.js)
  'spot:XAUUSD':      { ex: 'binance', sym: 'XAUUSDT', spot: 'XAU/USD', label: 'XAUUSD (spot)', flow: 'Binance XAUUSDT', unit: 'oz', tick: 0.01, bin: 0.05, buckets: [0.1, 0.25, 0.5, 1, 2.5], bucket: 0.25, axis: 0.5 },
  'spot:XAGUSD':      { ex: 'binance', sym: 'XAGUSDT', spot: 'XAG/USD', label: 'XAGUSD (spot)', flow: 'Binance XAGUSDT', unit: 'oz', tick: 0.01, bin: 0.01, buckets: [0.01, 0.02, 0.05, 0.1, 0.2], bucket: 0.02, axis: 0.05 },
  'binance:XAUUSDT':  { ex: 'binance', sym: 'XAUUSDT', label: 'XAUUSDT · Binance', unit: 'oz',  tick: 0.01,    bin: 0.05,   buckets: [0.1, 0.25, 0.5, 1, 2.5], bucket: 0.25, axis: 0.5 },
  'binance:XAGUSDT':  { ex: 'binance', sym: 'XAGUSDT', label: 'XAGUSDT · Binance', unit: 'oz',  tick: 0.01,    bin: 0.01,   buckets: [0.01, 0.02, 0.05, 0.1], bucket: 0.02, axis: 0.05 },
  'binance:XPTUSDT':  { ex: 'binance', sym: 'XPTUSDT', label: 'XPTUSDT · Binance', unit: 'oz',  tick: 0.01,    bin: 0.05,   buckets: [0.1, 0.25, 0.5, 1], bucket: 0.25, axis: 0.5 },
  'bybit:XAUUSDT':    { ex: 'bybit',   sym: 'XAUUSDT', label: 'XAUUSDT · Bybit',   unit: 'oz',  tick: 0.01,    bin: 0.05,   buckets: [0.1, 0.25, 0.5, 1, 2.5], bucket: 0.25, axis: 0.5 },
  'bybit:XAGUSDT':    { ex: 'bybit',   sym: 'XAGUSDT', label: 'XAGUSDT · Bybit',   unit: 'oz',  tick: 0.01,    bin: 0.01,   buckets: [0.01, 0.02, 0.05, 0.1], bucket: 0.02, axis: 0.05 },
  'bybit:EURUSDUSDT': { ex: 'bybit',   sym: 'EURUSDUSDT', label: 'EURUSD · Bybit', unit: 'EUR', tick: 0.00001, bin: 0.00002, buckets: [0.00005, 0.0001, 0.0002], bucket: 0.0001, axis: 0.0005, thin: true },
  'bybit:GBPUSDUSDT': { ex: 'bybit',   sym: 'GBPUSDUSDT', label: 'GBPUSD · Bybit', unit: 'GBP', tick: 0.00001, bin: 0.00002, buckets: [0.00005, 0.0001, 0.0002], bucket: 0.0001, axis: 0.0005, thin: true },
  'bybit:USDJPYUSDT': { ex: 'bybit',   sym: 'USDJPYUSDT', label: 'USDJPY · Bybit', unit: 'USD', tick: 0.001,   bin: 0.002,  buckets: [0.005, 0.01, 0.02], bucket: 0.01, axis: 0.05, thin: true },
  'hl:xyz:GOLD':      { ex: 'hl',      sym: 'xyz:GOLD',   label: 'GOLD · Hyperliquid',   unit: 'oz',  tick: 0.1,    bin: 0.1,    buckets: [0.1, 0.5, 1], bucket: 0.5, axis: 1 },
  'hl:xyz:SILVER':    { ex: 'hl',      sym: 'xyz:SILVER', label: 'SILVER · Hyperliquid', unit: 'oz',  tick: 0.001,  bin: 0.005,  buckets: [0.005, 0.01, 0.02], bucket: 0.01, axis: 0.05 },
  'hl:xyz:EUR':       { ex: 'hl',      sym: 'xyz:EUR',    label: 'EUR · Hyperliquid',    unit: 'EUR', tick: 0.0001, bin: 0.0001, buckets: [0.0001, 0.0002, 0.0005], bucket: 0.0002, axis: 0.0005, thin: true },
  'hl:xyz:JPY':       { ex: 'hl',      sym: 'xyz:JPY',    label: 'JPY · Hyperliquid',    unit: 'USD', tick: 0.01,   bin: 0.01,   buckets: [0.01, 0.02, 0.05], bucket: 0.02, axis: 0.05, thin: true },
};
// number of decimals needed to print a step exactly (0.25 -> 2, 0.00001 -> 5, 1 -> 0)
export const decimals = step => { for (let d = 0; d < 10; d++) if (Math.abs(Math.round(step * 10 ** d) - step * 10 ** d) < 1e-9) return d; return 10; };
export const toTick = (p, tick) => Math.round(p / tick);
// trade ids as numbers: exchange numbers stay as they are, text ids (Bybit) become a 52-bit FNV-1a hash
export function idNum(id) {
  if (typeof id === 'number') return id;
  if (id === undefined || id === null) return 0;
  let h1 = 0x811c9dc5, h2 = 0x01000193; const s = String(id);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822519) >>> 0; }
  return (h2 & 0xfffff) * 4294967296 + h1;
}
// recorded book sizes are kept as 16-bit numbers on a log scale (0.07% steps): q = round(1024 * log2(1 + size))
export const qHeat = v => Math.min(65535, Math.round(1024 * Math.log2(1 + Math.abs(v))));
export const uqHeat = q => Math.pow(2, q / 1024) - 1;

// ---------------------------------------------------------------------------------------------------------------
// Order book: two Maps tick -> size. Sizes replace (exchange sends absolute size per level); size 0 removes.
export class Book {
  constructor(tick) { this.tick = tick; this.off = 0; this.bids = new Map(); this.asks = new Map(); this.bb = null; this.ba = null; }
  clear() { this.bids.clear(); this.asks.clear(); this.bb = this.ba = null; }
  // move every level by -d ticks (used when the displayed price = exchange price - offset changes)
  shift(d) { this.off += d; for (const k of ['bids', 'asks']) { const m = new Map(); for (const [t, v] of this[k]) m.set(t - d, v); this[k] = m; } this.bb = this.ba = null; }
  set(side, price, size) {                    // side 0 = bid, 1 = ask; price as number, size as number
    const m = side ? this.asks : this.bids, k = toTick(price, this.tick) - this.off;
    if (size > 0) m.set(k, size); else m.delete(k);
    this.bb = this.ba = null;                 // best prices recomputed lazily
  }
  best() {
    if (this.bb === null) { let b = -Infinity, a = Infinity; for (const k of this.bids.keys()) if (k > b) b = k; for (const k of this.asks.keys()) if (k < a) a = k; this.bb = b; this.ba = a; }
    return [this.bb, this.ba];
  }
  // a crossed book means a missed update somewhere: caller resyncs
  crossed() { const [b, a] = this.best(); return b !== -Infinity && a !== Infinity && b >= a; }
  // resting size summed per bin (binTicks ticks per bin) for bins lo..lo+n-1; bids below the best ask, asks above the best bid
  column(lo, n, binTicks, out) {
    out.fill(0);
    for (const [m, sign] of [[this.bids, -1], [this.asks, 1]]) {
      if (m.size > 4 * n * binTicks) {           // big map: look up only the ticks in range
        const t0 = lo * binTicks, t1 = (lo + n) * binTicks;
        for (let t = t0; t < t1; t++) { const v = m.get(t); if (v) out[Math.floor(t / binTicks) - lo] += sign * v; }
      } else for (const [t, v] of m) { const i = Math.floor(t / binTicks) - lo; if (i >= 0 && i < n) out[i] += sign * v; }
    }
    return out;                                  // negative = bid size, positive = ask size (a bin never holds both in a sane book)
  }
  prune(midTick, keep) { for (const m of [this.bids, this.asks]) for (const k of m.keys()) if (Math.abs(k - midTick) > keep) m.delete(k); }
}

// ---------------------------------------------------------------------------------------------------------------
// Trades are stored column-wise in growable typed arrays: time ms, price tick, size, side (+1 aggressive buy, -1 sell), id
export class Trades {
  constructor(cap = 1 << 16) { this.n = 0; this.t = new Float64Array(cap); this.p = new Int32Array(cap); this.q = new Float64Array(cap); this.s = new Int8Array(cap); this.id = new Float64Array(cap); }
  grow() { const c = this.t.length * 2; for (const k of ['t', 'p', 'q', 's', 'id']) { const a = new this[k].constructor(c); a.set(this[k]); this[k] = a; } }
  push(t, p, q, s, id) { if (this.n === this.t.length) this.grow(); const i = this.n++; this.t[i] = t; this.p[i] = p; this.q[i] = q; this.s[i] = s; this.id[i] = id; }
  lastId() { return this.n ? this.id[this.n - 1] : -Infinity; }
  // drop everything before index i (keeps memory bounded)
  dropBefore(i) { if (i <= 0) return; for (const k of ['t', 'p', 'q', 's', 'id']) this[k].copyWithin(0, i, this.n); this.n -= i; }
}

// ---------------------------------------------------------------------------------------------------------------
// Candle clock matching TradingView. Read from TradingView's own charts on 22 Nov 2026:
//   OANDA:XAUUSD / XAGUSD                         session 1700-1700 America/New_York -> 4h candles start 17,21,01,05,09,13 NY
//   FOREXCOM, PEPPERSTONE, CAPITALCOM, FX, TVC    session 1800-1700 America/New_York -> 4h candles start 18,22,02,06,10,14 NY
//   BINANCE:...                                   24x7 UTC                           -> 4h candles start 00,04,08,... UTC
// 1m-1h candles are the same everywhere (whole UTC minutes/hours). New York daylight saving is followed automatically.
export const SESSIONS = { oanda: { label: 'OANDA', hour: 17 }, fx: { label: 'FOREX.com / Pepperstone / TVC', hour: 18 }, utc: { label: 'Binance (UTC)', hour: 0, utc: true } };
const nyFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }) : null;
const nyCache = new Map();
export function nyOffset(t) {                                     // New York local time minus UTC, in ms (-5 h or -4 h)
  const h = Math.floor(t / 3600e3); let v = nyCache.get(h);
  if (v === undefined) {
    const p = {}; for (const x of nyFmt.formatToParts(new Date(h * 3600e3))) p[x.type] = +x.value;
    v = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - h * 3600e3; nyCache.set(h, v);
    if (nyCache.size > 20000) nyCache.clear();
  }
  return v;
}
export function candleClock(tf, session = 'oanda') {
  const s = SESSIONS[session] || SESSIONS.oanda;
  if (tf < 4 * 3600e3 || s.utc) return { keyOf: t => Math.floor(t / tf), startOf: k => k * tf };
  const A = s.hour * 3600e3;
  return {
    keyOf: t => Math.floor((t + nyOffset(t) - A) / tf),
    startOf: k => { const local = k * tf + A; let u = local + 5 * 3600e3; u = local - nyOffset(u); return local - nyOffset(u); },
  };
}

// Spot conversion offset (exchange ticks to subtract) at any moment, for XAUUSD/XAGUSD built on the Binance perpetual.
//   hist: Map minute -> offset, measured afterwards (perp 1m close - Dukascopy spot mid, 15-minute median, rounded to a row)
//   segs: [{t, off}] live measurements since the page opened (Swissquote spot), each valid until the next
// When spot was shut (weekend, daily break) the last known value is kept, as the live feed does.
export function makeOffAt(hist, segs) {
  const keys = [...hist.keys()].sort((a, b) => a - b);
  return t => {
    if (segs.length && t >= segs[0].t) { let lo = 0, hi = segs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (segs[m].t <= t) lo = m + 1; else hi = m; } return segs[lo - 1].off; }
    const m = Math.floor(t / 60000), v = hist.get(m); if (v !== undefined) return v;
    // nearest measured minute within 6 hours (spot shut for a while: keep its last value); further away it would be stale
    let lo = 0, hi = keys.length; while (lo < hi) { const x = (lo + hi) >> 1; if (keys[x] <= m) lo = x + 1; else hi = x; }
    const before = lo > 0 ? keys[lo - 1] : null, after = lo < keys.length ? keys[lo] : null;
    const near = before !== null && (after === null || m - before <= after - m) ? before : after;
    if (near !== null && Math.abs(m - near) <= 360) return hist.get(near);
    if (before !== null && after === null && segs.length === 0) return hist.get(before);
    return segs.length ? segs[0].off : (near !== null ? hist.get(near) : 0);
  };
}

// Candle + footprint aggregation. One candle per period of the clock; inside it, per price bucket: [sell volume, buy volume].
export class Candles {
  constructor(tfMs, bucketTicks, clock) { this.tf = tfMs; this.bk = bucketTicks; this.clock = clock || candleClock(tfMs, 'utc'); this.list = []; this.byKey = new Map(); this.cvd = 0; }
  add(t, p, q, s) {
    const key = this.clock.keyOf(t);
    let c = this.byKey.get(key);
    if (!c) {
      c = { k: key, t0: this.clock.startOf(key), o: p, h: p, l: p, c: p, v: 0, d: 0, dmin: 0, dmax: 0, n: 0, cvd0: this.cvd, cells: new Map() };
      this.byKey.set(key, c); this.list.push(c);
      if (this.list.length > 1 && this.list[this.list.length - 2].k > key) { this.list.sort((a, b) => a.k - b.k); }
    }
    if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p;
    c.v += q; c.d += s * q; c.n++; if (c.d < c.dmin) c.dmin = c.d; if (c.d > c.dmax) c.dmax = c.d;
    const b = Math.floor(p / this.bk); let e = c.cells.get(b); if (!e) { e = [0, 0]; c.cells.set(b, e); }
    e[s > 0 ? 1 : 0] += q;
    this.cvd += s * q;
    return c;
  }
  // a plain, transferable copy of one candle for the screen
  static pack(c) { const cells = []; for (const [b, e] of c.cells) cells.push(b, e[0], e[1]); return { k: c.k, t0: c.t0, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v, d: c.d, dmin: c.dmin, dmax: c.dmax, n: c.n, cvd: c.cvd0 + c.d, cells }; }
  trim(maxN) { while (this.list.length > maxN) this.byKey.delete(this.list.shift().k); }
}

// Footprint reading helpers (used by the screen and by the tests)
// diagonal imbalance: buy volume at bucket b vs sell volume one bucket lower; sell at b vs buy one bucket higher
export function imbalances(cellsFlat, ratio = 3, minVol = 0) {
  const m = new Map(); for (let i = 0; i < cellsFlat.length; i += 3) m.set(cellsFlat[i], [cellsFlat[i + 1], cellsFlat[i + 2]]);
  const out = new Map(); let kmin = Infinity, kmax = -Infinity; for (const b of m.keys()) { if (b < kmin) kmin = b; if (b > kmax) kmax = b; }
  for (const [b, [sv, bv]] of m) {
    // a bucket inside the candle with no trades counts as 0; the candle's own low/high have no neighbour to compare with
    const below = b > kmin ? (m.get(b - 1) || [0, 0])[0] : null, above = b < kmax ? (m.get(b + 1) || [0, 0])[1] : null;
    const buy = below !== null && bv >= minVol && bv > 0 && bv >= ratio * below;
    const sell = above !== null && sv >= minVol && sv > 0 && sv >= ratio * above;
    out.set(b, (buy ? 1 : 0) | (sell ? 2 : 0));
  }
  return out;
}
export function poc(cellsFlat) { let best = null, bv = -1; for (let i = 0; i < cellsFlat.length; i += 3) { const v = cellsFlat[i + 1] + cellsFlat[i + 2]; if (v > bv) { bv = v; best = cellsFlat[i]; } } return best; }
// value area: smallest set of buckets around the POC holding `share` of volume (standard Market Profile rule: grow toward the bigger neighbour)
export function valueArea(vol /* Map bucket->volume */, share = 0.7) {
  if (!vol.size) return null;
  let tot = 0, pk = null, pv = -1; for (const [b, v] of vol) { tot += v; if (v > pv) { pv = v; pk = b; } }
  let lo = pk, hi = pk, acc = pv;
  const keys = [...vol.keys()]; const kmin = Math.min(...keys), kmax = Math.max(...keys);
  while (acc < share * tot && (lo > kmin || hi < kmax)) {
    const up = hi < kmax ? (vol.get(hi + 1) || 0) : -1, dn = lo > kmin ? (vol.get(lo - 1) || 0) : -1;
    if (up >= dn) { hi++; acc += Math.max(up, 0); } else { lo--; acc += Math.max(dn, 0); }
  }
  return { poc: pk, lo, hi, share: acc / tot };
}

// Size thresholds from the data itself: quantiles of recent trade sizes
export function quantile(arr, q) { if (!arr.length) return 0; const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; }

// Price impact lambda: least-squares slope of price change on net aggressive volume, over fixed time bars
export function impact(t, p, q, s, n, tick, barMs = 10000) {
  if (n < 50) return null;
  const X = [], Y = []; let k0 = Math.floor(t[0] / barMs), d = 0, p0 = p[0], last = p[0];
  for (let i = 0; i < n; i++) {
    const k = Math.floor(t[i] / barMs);
    if (k !== k0) { X.push(d); Y.push((last - p0) * tick); p0 = last; d = 0; k0 = k; }
    d += s[i] * q[i]; last = p[i];
  }
  if (X.length < 10) return null;
  const mx = X.reduce((a, b) => a + b) / X.length, my = Y.reduce((a, b) => a + b) / Y.length;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < X.length; i++) { sxy += (X[i] - mx) * (Y[i] - my); sxx += (X[i] - mx) ** 2; syy += (Y[i] - my) ** 2; }
  return { lambda: sxy / sxx, r: sxy / Math.sqrt(sxx * syy), bars: X.length };
}
