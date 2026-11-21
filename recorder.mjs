// Always-on recorder, run by serve.mjs on the laptop. For each recorded market it runs the same engine as the app
// (in Node), keeps the order book and trades, and writes to disk (orderflow/data/rec/<market>/, kept 7 days):
//   heat-YYYYMMDD-HH.bin    one book column per second: 320 rows around the price, sizes on a 16-bit log scale
//   trades-YYYYMMDD-HH.bin  every trade: time, exchange price, size, side, id
// so the app can show the heatmap and footprint for the time the phone or browser was closed.
// Memory is kept small (this laptop has 4 GB): book history is read back from disk only when the app asks for it.
// Prices are exchange (perpetual) prices; the app converts to spot (XAUUSD) with its own offset.
import fs from 'node:fs';
import path from 'node:path';
import { createEngine, COL_BINS } from './engine.js';
import { MARKETS, qHeat } from './core.js';

const KEEP_MS = 24 * 3600e3, DISK_DAYS = 7, HEAT_REC = 8 + 16 + COL_BINS * 2, TRADE_REC = 40;
export const recKey = key => { const m = MARKETS[key]; return m && m.spot ? `binance:${m.sym}` : key; };
const hourName = (kind, t) => `${kind}-${new Date(t).toISOString().slice(0, 13).replace(/[-T]/g, '')}.bin`;
const FILE_RE = /^(heat|trades)-(\d{4})(\d{2})(\d{2})(\d{2})\.bin$/;
const fileHour = m => Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5]);

function appendRows(dir, kind, a) {                              // a: Float64Array of 5-number trade rows, grouped into hour files
  const byF = new Map();
  for (let i = 0; i < a.length; i += 5) { const f = hourName(kind, a[i]); if (!byF.has(f)) byF.set(f, []); byF.get(f).push(i); }
  for (const [f, idx] of byF) { const buf = new Float64Array(idx.length * 5); idx.forEach((i, j) => buf.set(a.subarray(i, i + 5), j * 5)); fs.appendFileSync(path.join(dir, f), Buffer.from(buf.buffer)); }
}

export function createRecorder(dir, log = console.log) {
  const recs = new Map();

  function start(key) {
    key = recKey(key);
    if (recs.has(key)) return recs.get(key);
    if (!MARKETS[key] || recs.size >= 6) return null;
    const r = { key, pending: null, lastWT: 0, idsAtLastWT: new Set(), histSaved: false, dir: path.join(dir, key.replace(/[^A-Za-z0-9]+/g, '_')) };
    fs.mkdirSync(r.dir, { recursive: true });
    const pre = loadTrades(r);
    r.e = createEngine(m => { if (m.type === 'frame' && m.col) onCol(r, m.col); });
    r.e.on({ type: 'open', key, tf: 60000, backfillMin: 720, preload: pre, keepMs: 26 * 3600e3 });
    r.timer = setInterval(() => { try { flush(r); } catch (e) { log('[rec] flush', key, e.message); } }, 1000);
    recs.set(key, r);
    log(`[rec] recording ${key}: ${pre.length} trades loaded from disk`);
    return r;
  }

  // book: write the last column of each second
  function onCol(r, c) {
    const sec = Math.floor(c.t / 1000);
    if (r.pending && Math.floor(r.pending.t / 1000) !== sec) writeCol(r, r.pending);
    r.pending = c;
  }
  function writeCol(r, c) {
    const b = Buffer.alloc(HEAT_REC); b.writeDoubleLE(c.t, 0); b.writeInt32LE(c.lo, 8); b.writeInt32LE(c.bb, 12); b.writeInt32LE(c.ba, 16); b.writeInt32LE(c.last == null ? -1 : c.last, 20);
    for (let i = 0; i < COL_BINS; i++) b.writeUInt16LE(qHeat(c.data[i]), 24 + 2 * i);
    fs.appendFileSync(path.join(r.dir, hourName('heat', c.t)), b);
  }
  // trades: append the live ones once a second; after the first history download, also save that once
  function flush(r) {
    // after downloaded history or a filled hole, rewrite the hour files from memory so the disk copy has no holes
    const note = r.e.debug().stat.note || '';
    if (note !== r.lastNote) { r.lastNote = note; if (/^(history from|filled)/.test(note)) { rewriteTrades(r); return; } }
    const a = r.e.tradesBetween(r.lastWT || Date.now() - 5000), keep = [];
    for (let i = 0; i < a.length; i += 5) {
      const t = a[i], id = a[i + 4];
      if (t < r.lastWT || (t === r.lastWT && r.idsAtLastWT.has(id))) continue;
      if (t > r.lastWT) { r.lastWT = t; r.idsAtLastWT = new Set(); }
      r.idsAtLastWT.add(id); keep.push(...a.subarray(i, i + 5));
    }
    if (keep.length) appendRows(r.dir, 'trades', Float64Array.from(keep));
  }
  function rewriteTrades(r) {
    const a = r.e.tradesBetween(0); if (!a.length) return;
    const byF = new Map();
    for (let i = 0; i < a.length; i += 5) { const f = hourName('trades', a[i]); if (!byF.has(f)) byF.set(f, [i, i]); byF.get(f)[1] = i + 5; }
    for (const [f, [s, e]] of byF) { const tmp = path.join(r.dir, f + '.tmp'); fs.writeFileSync(tmp, Buffer.from(a.slice(s, e).buffer)); fs.renameSync(tmp, path.join(r.dir, f)); }
    const n = a.length; r.lastWT = a[n - 5]; r.idsAtLastWT = new Set();
    for (let i = n - 5; i >= 0 && a[i] === r.lastWT; i -= 5) r.idsAtLastWT.add(a[i + 4]);
  }
  // disk -> memory at start: trades of the last 24 h only; delete files older than 7 days
  function loadTrades(r) {
    const pre = [], now = Date.now();
    for (const f of fs.readdirSync(r.dir).sort()) {
      const m = FILE_RE.exec(f); if (!m) continue;
      const t = fileHour(m);
      if (t < now - DISK_DAYS * 864e5) { fs.unlinkSync(path.join(r.dir, f)); continue; }
      if (m[1] !== 'trades' || t < now - KEEP_MS - 3600e3) continue;
      const b = fs.readFileSync(path.join(r.dir, f)), a = new Float64Array(b.buffer, b.byteOffset, (b.length - b.length % TRADE_REC) / 8);
      for (let i = 0; i < a.length; i += 5) if (a[i] >= now - KEEP_MS) pre.push([a[i], a[i + 1], a[i + 2], a[i + 3], a[i + 4]]);
    }
    pre.sort((x, y) => x[0] - y[0] || x[4] - y[4]);
    if (pre.length) r.lastWT = pre[pre.length - 1][0];
    r.histCut = pre.length ? pre[0][0] : now - 5000;            // history older than this is not on disk yet
    return pre;
  }

  // heatmap history for [from, to] squeezed into at most n columns, read from the hour files. Each output column keeps,
  // per price row, the largest size seen in its time slot, so a wall is never lost by squeezing. Binary, per column:
  // Float64 t, Int32 lo, bb, ba, last, then COL_BINS Uint16 sizes (log scale, see qHeat); exchange ticks / rows.
  function heat(key, from, to, n) {
    const r = recs.get(recKey(key)); if (!r) return null;
    n = Math.max(1, Math.min(4000, n | 0)); const slot = Math.max(1000, (to - from) / n);
    const files = fs.readdirSync(r.dir).filter(f => { const m = FILE_RE.exec(f); if (!m || m[1] !== 'heat') return false; const t = fileHour(m); return t + 3600e3 > from && t <= to; }).sort();
    const out = []; let cur = null, curSlot = -1;
    const finish = () => { if (cur) out.push(cur); cur = null; };
    for (const f of files) {
      const b = fs.readFileSync(path.join(r.dir, f));
      for (let o = 0; o + HEAT_REC <= b.length; o += HEAT_REC) {
        const t = b.readDoubleLE(o); if (t < from || t > to) continue;
        const s = Math.floor((t - from) / slot), lo = b.readInt32LE(o + 8);
        if (s !== curSlot) { finish(); curSlot = s; cur = { t, lo, bb: 0, ba: 0, last: -1, q: new Uint16Array(COL_BINS) }; }
        const d = lo - cur.lo;
        for (let i = 0; i < COL_BINS; i++) { const k = i + d; if (k < 0 || k >= COL_BINS) continue; const v = b.readUInt16LE(o + 24 + 2 * i); if (v > cur.q[k]) cur.q[k] = v; }
        cur.t = t; cur.bb = b.readInt32LE(o + 12); cur.ba = b.readInt32LE(o + 16); cur.last = b.readInt32LE(o + 20);
      }
    }
    finish();
    const buf = Buffer.alloc(out.length * HEAT_REC);
    out.forEach((c, k) => { const o = k * HEAT_REC; buf.writeDoubleLE(c.t, o); buf.writeInt32LE(c.lo, o + 8); buf.writeInt32LE(c.bb, o + 12); buf.writeInt32LE(c.ba, o + 16); buf.writeInt32LE(c.last, o + 20); Buffer.from(c.q.buffer).copy(buf, o + 24); });
    return buf;
  }
  function trades(key, from, to) { const r = recs.get(recKey(key)); return r ? Buffer.from(r.e.tradesBetween(from, to || Infinity).buffer) : null; }
  function info() {
    return [...recs.values()].map(r => {
      const d = r.e.debug(), hf = fs.readdirSync(r.dir).map(f => FILE_RE.exec(f)).filter(m => m && m[1] === 'heat').map(fileHour).sort((a, b) => a - b);
      return { key: r.key, heatFromHour: hf.length ? hf[0] : null, trades: d.tr ? d.tr.n : 0, tradesFrom: d.tr && d.tr.n ? d.tr.t[0] : null, book: d.stat && d.stat.book, gaps: d.stat && d.stat.gaps, mbRSS: Math.round(process.memoryUsage().rss / 1e6) };
    });
  }
  return { start, heat, trades, info, has: key => recs.has(recKey(key)) };
}
