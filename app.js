// Screen thread: receives 100 ms frames from the engine worker and draws every panel on canvas, only when something changed.
import { MARKETS, decimals, imbalances, poc, valueArea, quantile, impact } from './core.js';

// ---------------------------------------------------------------- colours (TradingView dark theme)
const C = { G: '#089981', R: '#f23645', OR: '#ff9800', YEL: '#ffeb3b', BLUE: '#2962ff', TXT: '#dbdbdb', SUB: '#b8b8b8', MUT: '#8c8c8c', LINE: '#303030', BG: '#000000', VG: 'rgba(38,166,154,0.5)', VR: 'rgba(239,83,80,0.5)' };
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${n >> 8 & 255},${n & 255},${a})`; };
const MONO = 'Consolas, "JetBrains Mono", ui-monospace, Menlo, monospace', SANS = '-apple-system, "Segoe UI", Inter, sans-serif';
const $ = id => document.getElementById(id);
const LS = { get(k, d) { try { const v = localStorage.getItem('of.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
             set(k, v) { try { localStorage.setItem('of.' + k, JSON.stringify(v)); } catch {} } };

// heatmap colour scale built from TradingView palette shades: black -> blue -> TV blue -> orange -> yellow -> white
const LUT = (() => {
  const st = [[0, [0, 0, 0]], [0.25, [12, 29, 77]], [0.5, [29, 69, 179]], [0.66, [41, 98, 255]], [0.8, [255, 152, 0]], [0.92, [255, 235, 59]], [1, [255, 255, 255]]];
  const L = new Uint32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const v = Math.pow(i / 1023, 1.1); let j = 0; while (v > st[j + 1][0]) j++;   // gamma keeps ordinary size dark, walls bright
    const [a, ca] = st[j], [b, cb] = st[j + 1], f = (v - a) / (b - a), c = ca.map((x, k) => Math.round(x + (cb[k] - x) * f));
    L[i] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  return L;
})();

// ---------------------------------------------------------------- state
let key = LS.get('key', 'spot:XAUUSD'); if (!MARKETS[key]) key = 'spot:XAUUSD';
let tf = LS.get('tf', 60000);
const bucketBy = LS.get('bucket', {});
let mk, tick, dp, binTicks, bucketTicks;
const S = { n: 0, t: new Float64Array(1 << 16), p: new Int32Array(1 << 16), q: new Float64Array(1 << 16), s: new Int8Array(1 << 16), cd: new Float64Array(1 << 16) };
let cols = []; const MAXCOLS = 6000;                   // 100 ms book columns: last 10 minutes (older comes from the recorder, 1 s)
let candles = [], cIndex = new Map(), liqs = [], stat = {}, th = { bubble: 0, tape: 0, big: 0 }, lam = null;
const dirty = new Set(['heat', 'delta', 'cvd', 'fp', 'dom', 'tape', 'hdr']);
const all = () => ['heat', 'delta', 'cvd', 'fp', 'dom', 'tape', 'hdr'].forEach(k => dirty.add(k));
const hv = { span: LS.get('span', 5 * 60e3), auto: true, center: null, halfBins: LS.get('halfBins', 70), live: true, tEnd: 0, contrast: LS.get('contrast', 1) };
const fv = { cw: LS.get('cw', 112), back: 0, auto: true, center: null, half: null };

function growS() { for (const k of ['t', 'p', 'q', 's', 'cd']) { const a = new S[k].constructor(S[k].length * 2); a.set(S[k]); S[k] = a; } }
function pushT(t, p, q, s) { if (S.n === S.t.length) growS(); const i = S.n++; S.t[i] = t; S.p[i] = p; S.q[i] = q; S.s[i] = s; S.cd[i] = (i ? S.cd[i - 1] : 0) + s * q; }
const lb = (arr, n, x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; };
const colAt = t => { let lo = 0, hi = cols.length; while (lo < hi) { const m = (lo + hi) >> 1; if (cols[m].t <= t) lo = m + 1; else hi = m; } return lo - 1; };

// ---------------------------------------------------------------- formatting
const fP = ticks => (ticks * tick).toFixed(dp);
const fQ = q => { const a = Math.abs(q); return a >= 1e4 ? (q / 1e3).toFixed(0) + 'k' : a >= 1e3 ? (q / 1e3).toFixed(1) + 'k' : a >= 100 ? q.toFixed(0) : a >= 10 ? q.toFixed(1) : a >= 1 ? q.toFixed(2) : q.toFixed(3); };
const fS = q => (q > 0 ? '+' : q < 0 ? '−' : '') + fQ(Math.abs(q));
const IST = 5.5 * 3600e3;
const hm = (t, sec) => { const d = new Date(t + IST), f = x => String(x).padStart(2, '0'); return f(d.getUTCHours()) + ':' + f(d.getUTCMinutes()) + (sec ? ':' + f(d.getUTCSeconds()) : ''); };
const niceStep = (raw, steps) => steps.find(s => s >= raw) || steps[steps.length - 1];

// ---------------------------------------------------------------- worker
const worker = new Worker(new URL('./engine.js', import.meta.url), { type: 'module' });
worker.onmessage = ev => onMsg(ev.data);
worker.onerror = e => { stat = { conn: 'engine error: ' + (e.message || 'worker failed') }; dirty.add('hdr'); };

function open(k) {
  key = k; LS.set('key', k); mk = MARKETS[k]; tick = mk.tick; dp = decimals(tick);
  binTicks = Math.max(1, Math.round(mk.bin / tick)); bucketTicks = Math.max(1, Math.round((bucketBy[k] || mk.bucket) / tick));
  S.n = 0; cols = []; recCols = []; recReq = ''; candles = []; cIndex = new Map(); liqs = []; stat = {}; lam = null; th = { bubble: 0, tape: 0, big: 0 };
  hv.center = null; hv.auto = true; hv.live = true; fv.back = 0; fv.auto = true;
  worker.postMessage({ type: 'open', key: k, tf, bucket: bucketTicks * tick });
  buildControls(); all();
}
function setCandles(list) { candles = list; cIndex = new Map(list.map((c, i) => [c.k, i])); }
function onMsg(m) {
  if (m.type === 'reset') {
    S.n = 0; const a = m.trades; for (let i = 0; i < a.length; i += 4) pushT(a[i], a[i + 1], a[i + 2], a[i + 3]);
    if (!m.keep) { cols = []; liqs = []; }
    setCandles(m.candles); updateStats(true); all();
  } else if (m.type === 'candles') { setCandles(m.candles); dirty.add('fp'); }
  else if (m.type === 'prepend') {                                // older history: put in front of what we hold
    const a = m.trades, old = { n: S.n, t: S.t.slice(0, S.n), p: S.p.slice(0, S.n), q: S.q.slice(0, S.n), s: S.s.slice(0, S.n) };
    S.n = 0; for (let i = 0; i < a.length; i += 4) pushT(a[i], a[i + 1], a[i + 2], a[i + 3]);
    for (let i = 0; i < old.n; i++) pushT(old.t[i], old.p[i], old.q[i], old.s[i]);
    updateStats(true); all();
  } else if (m.type === 'shift') {                                // spot offset moved by d ticks: move everything we hold the same way
    const d = m.d; for (let i = 0; i < S.n; i++) S.p[i] -= d;
    for (const c of cols) { c.lo -= d / binTicks; c.bb -= d; c.ba -= d; if (c.last != null) c.last -= d; }
    for (const c of recCols) { c.lo -= d / binTicks; c.bb -= d; c.ba -= d; if (c.last != null) c.last -= d; }
    for (const l of liqs) l.p -= d; if (hv.center !== null) hv.center -= d; if (fv.center !== null) fv.center -= d;
    all();
  }
  else if (m.type === 'frame') {
    const a = m.trades; for (let i = 0; i < a.length; i += 4) pushT(a[i], a[i + 1], a[i + 2], a[i + 3]);
    if (m.col) { cols.push(m.col); if (cols.length > MAXCOLS + 600) { cols.splice(0, 600); recReq = ''; } }
    for (const c of m.candles) {
      const i = cIndex.get(c.k);
      if (i !== undefined) candles[i] = c;
      else { candles.push(c); if (candles.length > 1 && candles[candles.length - 2].k > c.k) candles.sort((x, y) => x.k - y.k); cIndex = new Map(candles.map((x, j) => [x.k, j])); if (fv.back > 0) fv.back++; }
    }
    for (let i = 0; i < m.liqs.length; i += 4) liqs.push({ t: m.liqs[i], p: m.liqs[i + 1], q: m.liqs[i + 2], s: m.liqs[i + 3] });
    stat = m.stat;
    if (m.col || a.length) ['heat', 'delta', 'cvd', 'dom', 'tape', 'hdr'].forEach(k => dirty.add(k));
    if (m.candles.length) dirty.add('fp');
    dirty.add('hdr');
  }
}
// size thresholds from recent trades (quantiles), impact lambda from all loaded trades
let lastStats = 0;
function updateStats(force) {
  const now = performance.now(); if (!force && now - lastStats < 3000) return; lastStats = now;
  const n = Math.min(S.n, 5000); if (n > 50) { const a = S.q.subarray(S.n - n, S.n); th = { bubble: quantile(a, 0.95), tape: quantile(a, 0.97), big: quantile(a, 0.99) }; }
  lam = impact(S.t, S.p, S.q, S.s, S.n, tick, 10000);
}

// ---------------------------------------------------------------- canvases
const pane = {};
function setup(id) {
  const c = $(id), r = c.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  if (r.width < 2 || r.height < 2) { pane[id] = null; return; }
  c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
  const x = c.getContext('2d', { alpha: false }); pane[id] = { c, x, w: r.width, h: r.height, dpr };
}
const ro = new ResizeObserver(() => { ['heat', 'delta', 'cvd', 'fp', 'dom', 'tape'].forEach(setup); all(); });
['heat', 'delta', 'cvd', 'fp', 'dom', 'tape'].forEach(id => ro.observe($(id)));
function begin(id) {
  const P = pane[id]; if (!P) return null;
  const { x, w, h, dpr } = P; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.fillStyle = C.BG; x.fillRect(0, 0, w, h);
  x.textBaseline = 'middle'; x.font = `11px ${MONO}`; return P;
}
function waiting(P, msg) { const { x, w, h } = P; x.fillStyle = C.MUT; x.textAlign = 'center'; x.font = `12px ${SANS}`; x.fillText(msg, w / 2, h / 2); }
function priceAxis(x, w, h, loT, hiT, yOf, lastTicks, lastCol, top = 0) {
  const AX = 62; x.fillStyle = C.BG; x.fillRect(w - AX, 0, AX, h + top);
  x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(w - AX + 0.5, 0); x.lineTo(w - AX + 0.5, h + top); x.stroke();
  const pxPerTick = h / (hiT - loT); let step = Math.max(1, Math.round(mk.axis / tick));
  const cands = []; for (const m of [1, 2, 2.5, 5]) for (let e = 0; e < 12; e++) cands.push(Math.round(m * 10 ** e)); cands.sort((a, b) => a - b);
  step = cands.find(s => s * pxPerTick >= 34) || step;
  x.fillStyle = C.SUB; x.textAlign = 'left'; x.font = `11px ${MONO}`;
  for (let p = Math.ceil(loT / step) * step; p <= hiT; p += step) { const y = yOf(p); if (y < top + 6 || y > top + h - 6) continue; x.fillText(fP(p), w - AX + 6, y); x.fillStyle = C.LINE; x.fillRect(w - AX, Math.round(y), 4, 1); x.fillStyle = C.SUB; }
  if (lastTicks != null) { const y = Math.max(top + 8, Math.min(top + h - 8, yOf(lastTicks))); x.fillStyle = lastCol; x.fillRect(w - AX, y - 8, AX, 16); x.fillStyle = '#fff'; x.font = `bold 11px ${MONO}`; x.fillText(fP(lastTicks), w - AX + 6, y); }
}
function timeAxis(x, y0, w, h, tStart, span, X) {
  x.fillStyle = C.BG; x.fillRect(0, y0, w, h);
  const step = niceStep(span / Math.max(1, w / 80), [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]);
  x.fillStyle = C.SUB; x.textAlign = 'center'; x.font = `10.5px ${MONO}`;
  for (let t = Math.ceil(tStart / step) * step; t < tStart + span; t += step) { const xx = X(t); if (xx > 20 && xx < w - 20) x.fillText(hm(t, step < 6e4), xx, y0 + h / 2); }
  return step;
}

// ---------------------------------------------------------------- heatmap + bubbles + profile
function heatWindow() {
  const tLast = Math.max(cols.length ? cols[cols.length - 1].t : 0, S.n ? S.t[S.n - 1] : 0, recCols.length ? recCols[recCols.length - 1].t : 0);
  const tEnd = hv.live ? tLast : hv.tEnd; return [tEnd - hv.span, tEnd];
}
// ---- recorded heatmap history from the laptop recorder (serve.mjs): fetched for the part of the view before this page opened
let recCols = [], recReq = '', recBusy = false, recOK = location.protocol.startsWith('http');
const offTicks = () => mk && mk.spot && stat.spot && stat.spot.off != null ? Math.round(stat.spot.off / tick) : 0;
async function loadRec(t0, t1, n) {
  if (!recOK || recBusy || !mk) return;
  const slot = Math.max(1000, (t1 - t0) / n), a = Math.floor(t0 / slot) * slot, b = Math.ceil(t1 / slot) * slot;
  const qs = `key=${encodeURIComponent(key)}&from=${a}&to=${b}&n=${Math.ceil((b - a) / slot)}`;
  if (qs === recReq) return; recBusy = true; recReq = qs; const forKey = key, ot = offTicks();
  try {
    const r = await fetch('rec/heat?' + qs);
    if (r.status === 404 || !r.ok) { if (forKey === key) recCols = []; }
    else {
      const buf = await r.arrayBuffer(), dv = new DataView(buf), REC = 24 + 2 * 320, out = [];
      for (let o = 0; o + REC <= buf.byteLength; o += REC) {
        const q = new Uint16Array(buf, o + 24, 320), data = new Float32Array(320);
        for (let i = 0; i < 320; i++) data[i] = q[i] ? Math.pow(2, q[i] / 1024) - 1 : 0;
        const last = dv.getInt32(o + 20, true);
        out.push({ t: dv.getFloat64(o, true), lo: dv.getInt32(o + 8, true) - ot / binTicks, bb: dv.getInt32(o + 12, true) - ot, ba: dv.getInt32(o + 16, true) - ot, last: last < 0 ? null : last - ot, data, slot });
      }
      if (forKey === key) { recCols = out; dirty.add('heat'); }
    }
  } catch { recOK = false; }
  recBusy = false;
}
const recAt = t => { let lo = 0, hi = recCols.length; while (lo < hi) { const m = (lo + hi) >> 1; if (recCols[m].t < t) lo = m + 1; else hi = m; } return lo; };
function colFor(t) {                                              // live 100 ms column if we have one, else the recorded one
  if (cols.length && t >= cols[0].t) { const ci = colAt(t); const c = cols[ci]; return c && t - c.t <= 1500 ? c : null; }
  const i = recAt(t); const c = recCols[i]; return c && c.t - t <= c.slot + 2000 ? c : null;
}
const CONTRAST = [0.3, 0.5, 0.7, 0.85];                           // lower cut: sizes below this percentile of the view stay dark
function drawHeat() {
  const P = begin('heat'); if (!P) return; const { x, w, h, dpr } = P;
  const AX = 62, TB = 18, hw = w - AX, hh = h - TB;
  const [tStart, tEnd] = heatWindow();
  const liveStart = cols.length ? cols[0].t : Date.now();
  if (tStart < liveStart) loadRec(tStart, Math.min(tEnd, liveStart), Math.max(50, Math.round(hw)));
  if (!cols.length && !recCols.length) return waiting(P, stat.book === 'syncing' ? 'syncing order book…' : `connecting to ${mk.label}…`);
  const lastC = cols.length ? cols[cols.length - 1] : recCols[recCols.length - 1], lastP = S.n ? S.p[S.n - 1] : (lastC.bb + lastC.ba) / 2;
  const half = hv.halfBins * binTicks;
  if (hv.auto && (hv.center === null || Math.abs(lastP - hv.center) > 0.55 * half)) hv.center = lastP;
  if (hv.center === null) hv.center = lastP;
  const loT = hv.center - half, hiT = hv.center + half;
  const X = t => (t - tStart) / hv.span * hw, Y = pt => (hiT - pt) / (hiT - loT) * hh;
  // 1. book pixels
  const W = Math.max(1, Math.round(hw * dpr)), H = Math.max(1, Math.round(hh * dpr));
  if (!P.img || P.img.width !== W || P.img.height !== H) { P.img = x.createImageData(W, H); P.px = new Uint32Array(P.img.data.buffer); P.rowBin = new Int32Array(H); }
  const px = P.px; px.fill(LUT[0]);
  const b0 = Math.floor(loT / binTicks), b1 = Math.floor(hiT / binTicks), nb = b1 - b0 + 1;
  for (let yy = 0; yy < H; yy++) P.rowBin[yy] = Math.floor((hiT - (yy + 0.5) / H * (hiT - loT)) / binTicks) - b0;
  // which column each pixel column shows, and the colour scale from the sizes actually in view:
  // log scale between a lower cut (contrast setting, a percentile of the view) and the 99.5th percentile; sizes below the
  // lower cut show as a faint trace, so empty price levels (black) differ from thin ones
  const pcol = new Array(W), smp = [];
  for (let xx = 0; xx < W; xx++) pcol[xx] = colFor(tStart + (xx + 0.5) / W * hv.span);
  for (let xx = 0; xx < W; xx += Math.max(1, Math.floor(W / 160))) { const c = pcol[xx]; if (c) for (let b = b0; b <= b1; b++) { const v = c.data[b - c.lo]; if (v) smp.push(Math.abs(v)); } }
  const lcut = Math.log(Math.max(1e-12, quantile(smp, CONTRAST[hv.contrast] ?? 0.5))), lcap = Math.log(Math.max(1e-12, quantile(smp, 0.995)));
  const span = Math.max(1e-9, lcap - lcut), FAINT = LUT[70];
  const colour = new Uint32Array(nb); let prev = null;
  for (let xx = 0; xx < W; xx++) {
    const c = pcol[xx]; if (!c) continue;                                     // no data here (gap: laptop asleep or recorder off)
    if (c !== prev) {
      for (let k = 0; k < nb; k++) {
        const v = Math.abs(c.data[b0 + k - c.lo] || 0);
        if (!v) { colour[k] = LUT[0]; continue; }
        const f = (Math.log(v) - lcut) / span; colour[k] = f <= 0 ? FAINT : LUT[Math.min(1023, 90 + (f * 933) | 0)];
      }
      prev = c;
    }
    for (let yy = 0, o = xx; yy < H; yy++, o += W) { const k = P.rowBin[yy]; if (k >= 0 && k < nb) px[o] = colour[k]; }
  }
  x.putImageData(P.img, 0, 0);
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  // stretches with no book data at all: say so, so black is not mistaken for an empty market
  x.fillStyle = C.MUT; x.font = `11px ${SANS}`; x.textAlign = 'center';
  for (let a = 0; a < W;) { if (pcol[a]) { a++; continue; } let b = a; while (b < W && !pcol[b]) b++; if ((b - a) / dpr > 110) { const msg = recOK ? 'no book recorded here (recorder off or laptop asleep)' : 'book history needs serve.mjs', tw = x.measureText(msg).width / 2 + 6; x.fillText(msg, Math.max(tw, Math.min(hw - tw, (a + b) / 2 / dpr)), hh * 0.12); } a = b; }
  // best bid / best ask through time (thin green / red step lines), from the same columns
  for (const [key2, col] of [['bb', rgba(C.G, 0.9)], ['ba', rgba(C.R, 0.9)]]) {
    x.strokeStyle = col; x.lineWidth = 1; x.beginPath(); let py = null;
    for (let xx = 0; xx < W; xx += Math.max(1, Math.round(dpr))) { const c = pcol[xx]; const X0 = xx / dpr; if (!c) { py = null; continue; } const y = Y(c[key2] + 0.5); if (py === null) x.moveTo(X0, y); else { x.lineTo(X0, py); x.lineTo(X0, y); } py = y; }
    x.stroke();
  }
  // 2. grid
  const tstep = niceStep(hv.span / Math.max(1, hw / 80), [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5]);
  x.strokeStyle = 'rgba(242,242,242,0.06)'; x.lineWidth = 1;
  for (let t = Math.ceil(tStart / tstep) * tstep; t < tEnd; t += tstep) { const xx = Math.round(X(t)) + 0.5; x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx, hh); x.stroke(); }
  // 3. trades in the window: volume profile, bubbles
  const j0 = lb(S.t, S.n, tStart), j1 = lb(S.t, S.n, tEnd + 1);
  const vb = new Float64Array(nb * 2), vol = new Map();
  // bubbles: all trades in the same heatmap row ($0.05 for gold) inside one short time slot (~6 px) become one bubble, at
  // their volume-weighted price and time, so every bubble sits on the price line; green/red share = buy/sell volume
  const gMs = hv.span / Math.max(1, hw / 6), groups = new Map();
  for (let j = j0; j < j1; j++) {
    const k = Math.floor(S.p[j] / binTicks) - b0, q = S.q[j], sd = S.s[j];
    if (k >= 0 && k < nb) { vb[2 * k + (sd > 0 ? 0 : 1)] += q; vol.set(k, (vol.get(k) || 0) + q); }
    const gk = Math.floor(S.t[j] / gMs) * 4e6 + Math.floor(S.p[j] / binTicks); let g = groups.get(gk);
    if (!g) { g = { b: 0, s: 0, tq: 0, pq: 0 }; groups.set(gk, g); }
    if (sd > 0) g.b += q; else g.s += q; g.tq += S.t[j] * q; g.pq += S.p[j] * q;
  }
  const VW = Math.min(110, hw * 0.16); let vmax = 0; for (const v of vol.values()) vmax = Math.max(vmax, v);
  const va = valueArea(vol), bh = Math.max(1, binTicks / (hiT - loT) * hh);
  if (vmax > 0) for (const [k, v] of vol) {
    const y = Y((b0 + k + 1) * binTicks), lbuy = vb[2 * k] / vmax * VW, lsell = vb[2 * k + 1] / vmax * VW;
    if (va && k === va.poc) { x.fillStyle = rgba(C.OR, 0.9); x.fillRect(hw - lbuy - lsell, y, lbuy + lsell, Math.max(1, bh - 0.5)); continue; }
    x.fillStyle = C.VG; x.fillRect(hw - lbuy - lsell, y, lbuy, Math.max(1, bh - 0.5));
    x.fillStyle = C.VR; x.fillRect(hw - lsell, y, lsell, Math.max(1, bh - 0.5));
  }
  if (va) { x.strokeStyle = rgba(C.OR, 0.45); x.setLineDash([4, 4]); for (const k of [va.lo, va.hi + 1]) { const y = Math.round(Y((b0 + k) * binTicks)) + 0.5; x.beginPath(); x.moveTo(0, y); x.lineTo(hw, y); x.stroke(); } x.setLineDash([]); }
  // 4. last traded price: an exact step line built from every trade (per pixel: the range traded in it, then the last price)
  if (j1 > 0) {
    x.strokeStyle = 'rgba(255,255,255,0.95)'; x.lineWidth = 1.2; x.beginPath();
    let j = Math.max(0, j0 - 1), py = Y(S.p[j] + 0.5); x.moveTo(0, py); j = j0;
    const pxMs = hv.span / hw;
    while (j < j1) {
      const xx = Math.min(hw, X(S.t[j])), slotEnd = tStart + (Math.floor((S.t[j] - tStart) / pxMs) + 1) * pxMs;
      let hiP = S.p[j], loP = S.p[j], lastP2 = S.p[j];
      for (j++; j < j1 && S.t[j] < slotEnd; j++) { const p = S.p[j]; if (p > hiP) hiP = p; if (p < loP) loP = p; lastP2 = p; }
      x.lineTo(xx, py);                                           // hold the previous price until this trade
      if (hiP !== loP) { x.lineTo(xx, Y(hiP + 0.5)); x.lineTo(xx, Y(loP + 0.5)); }
      py = Y(lastP2 + 0.5); x.lineTo(xx, py);
    }
    x.lineTo(hv.live ? hw : Math.min(hw, X(tEnd)), py); x.stroke(); x.lineWidth = 1;
  }
  // 5. bubbles (largest first, so small ones stay visible on top)
  const ref = th.big || 1, list = [];
  for (const g of groups.values()) { const q = g.b + g.s; if (q >= th.bubble) list.push(g); }
  list.sort((a, b) => (b.b + b.s) - (a.b + a.s));
  for (const g of list) {
    const q = g.b + g.s, r = Math.max(2.5, Math.min(22, 9 * Math.sqrt(q / ref))), xx = X(g.tq / q), yy = Y(g.pq / q + 0.5), fb = g.b / q;
    x.beginPath(); x.arc(xx, yy, r, 0, 6.2832); x.fillStyle = rgba(C.R, 0.55); x.fill();                         // sell share
    if (fb > 0) { x.beginPath(); x.moveTo(xx, yy); x.arc(xx, yy, r, -Math.PI / 2, -Math.PI / 2 + fb * 6.2832); x.closePath(); x.fillStyle = rgba(C.G, 0.7); x.fill(); }   // buy share
    x.beginPath(); x.arc(xx, yy, r, 0, 6.2832); x.lineWidth = q >= ref ? 1.6 : 0.8; x.strokeStyle = q >= ref ? '#ffffff' : 'rgba(255,255,255,0.45)'; x.stroke();
  }
  x.lineWidth = 1;
  // 6. liquidations
  x.fillStyle = C.YEL;
  for (const l of liqs) { if (l.t < tStart || l.t > tEnd) continue; const xx = X(l.t), yy = Y(l.p + 0.5); x.beginPath(); x.moveTo(xx, yy - 5); x.lineTo(xx + 5, yy); x.lineTo(xx, yy + 5); x.lineTo(xx - 5, yy); x.fill(); }
  if (!hv.live) { x.fillStyle = rgba(C.OR, 0.9); x.textAlign = 'left'; x.font = `11px ${SANS}`; x.fillText('history · double-click or ⟲ to follow live', 8, 12); }
  priceAxis(x, w, hh, loT, hiT, pt => Y(pt + 0.5), S.n ? S.p[S.n - 1] : null, S.n && S.s[S.n - 1] > 0 ? C.G : C.R);
  timeAxis(x, hh, w - AX, TB, tStart, hv.span, X);
  $('heatInfo').textContent = ` · ${fmtSpan(hv.span)} · bubbles ≥ ${fQ(th.bubble)} ${mk.unit} · contrast ${(hv.contrast ?? 1) + 1}/4` + (recCols.length ? ' · recorded' : '');
  $('heatR').textContent = va ? `POC ${fP((b0 + va.poc) * binTicks)} · VA ${fP((b0 + va.lo) * binTicks)}–${fP((b0 + va.hi + 1) * binTicks)}` : '';
}
const fmtSpan = ms => ms >= 36e5 ? (ms / 36e5).toFixed(ms % 36e5 ? 1 : 0) + ' h' : ms >= 6e4 ? Math.round(ms / 6e4) + ' min' : Math.round(ms / 1e3) + ' s';

// ---------------------------------------------------------------- delta bars + CVD (same time axis as the heatmap)
function drawDelta() {
  const P = begin('delta'); if (!P || !S.n) return; const { x, w, h } = P, AX = 62, cw = w - AX;
  const [tStart, tEnd] = heatWindow();
  const bar = niceStep(hv.span / Math.max(1, cw / 6), [1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5]);
  const b0 = Math.floor(tStart / bar), nb = Math.floor(tEnd / bar) - b0 + 1, d = new Float64Array(nb);
  for (let j = lb(S.t, S.n, tStart); j < S.n && S.t[j] <= tEnd; j++) d[Math.floor(S.t[j] / bar) - b0] += S.s[j] * S.q[j];
  let mx = 1e-12; for (const v of d) mx = Math.max(mx, Math.abs(v));
  const mid = h / 2, X = t => (t - tStart) / hv.span * cw;
  x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(0, mid + 0.5); x.lineTo(cw, mid + 0.5); x.stroke();
  for (let i = 0; i < nb; i++) { const v = d[i]; if (!v) continue; const x0 = X((b0 + i) * bar), bw = Math.max(1, X((b0 + i + 1) * bar) - x0 - 1.5), bh = v / mx * (mid - 5);
    x.fillStyle = v > 0 ? C.G : C.R; x.fillRect(x0 + 0.75, v > 0 ? mid - bh : mid, bw, Math.abs(bh)); }
  x.fillStyle = C.BG; x.fillRect(cw, 0, AX, h); x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(cw + 0.5, 0); x.lineTo(cw + 0.5, h); x.stroke();
  x.fillStyle = C.SUB; x.textAlign = 'left'; x.fillText('+' + fQ(mx), cw + 6, 9); x.fillText('0', cw + 6, mid); x.fillText('−' + fQ(mx), cw + 6, h - 9);
  $('deltaInfo').textContent = ` · ${fmtSpan(bar)} bars`;
  const lv = d[nb - 1]; $('deltaR').innerHTML = `last bar <span class="${lv >= 0 ? 'g' : 'rd'}">${fS(lv)} ${mk.unit}</span>`;
}
function drawCvd() {
  const P = begin('cvd'); if (!P || !S.n) return; const { x, w, h } = P, AX = 62, cw = w - AX;
  const [tStart] = heatWindow(), pts = [], N = Math.max(2, Math.floor(cw / 2));
  for (let i = 0; i <= N; i++) { const t = tStart + i / N * hv.span, j = lb(S.t, S.n, t + 1) - 1; if (j >= 0) pts.push([i / N * cw, S.cd[j]]); }
  if (!pts.length) return;
  let lo = Infinity, hi = -Infinity; for (const [, v] of pts) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.12 || 1; lo -= pad; hi += pad; const Y = v => (hi - v) / (hi - lo) * h;
  const base = Math.max(0, Math.min(h, Y(pts[0][1])));          // colour relative to the CVD at the left edge of the window
  for (const [col, y0, y1] of [[C.G, 0, base], [C.R, base, h]]) {
    x.save(); x.beginPath(); x.rect(0, y0, cw, y1 - y0); x.clip();
    x.beginPath(); x.moveTo(pts[0][0], base); for (const [xx, v] of pts) x.lineTo(xx, Y(v)); x.lineTo(pts[pts.length - 1][0], base); x.closePath(); x.fillStyle = rgba(col, 0.16); x.fill();
    x.beginPath(); pts.forEach(([xx, v], i) => i ? x.lineTo(xx, Y(v)) : x.moveTo(xx, Y(v))); x.strokeStyle = col; x.lineWidth = 1.5; x.stroke(); x.restore();
  }
  x.lineWidth = 1; x.setLineDash([3, 3]); x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(0, base); x.lineTo(cw, base); x.stroke(); x.setLineDash([]);
  x.fillStyle = C.BG; x.fillRect(cw, 0, AX, h); x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(cw + 0.5, 0); x.lineTo(cw + 0.5, h); x.stroke();
  x.fillStyle = C.SUB; x.textAlign = 'left'; x.fillText(fS(hi - pad), cw + 6, 9); x.fillText(fS(lo + pad), cw + 6, h - 9);
  const last = S.cd[S.n - 1], yv = Math.max(8, Math.min(h - 8, Y(last)));
  x.fillStyle = last >= 0 ? C.G : C.R; x.fillRect(cw, yv - 8, AX, 16); x.fillStyle = '#fff'; x.font = `bold 11px ${MONO}`; x.fillText(fS(last), cw + 6, yv);
  $('cvdInfo').textContent = ` · since ${hm(S.t[0])} IST`;
  $('cvdR').innerHTML = `<span class="${last >= 0 ? 'g' : 'rd'}">${fS(last)} ${mk.unit}</span>`;
}

// ---------------------------------------------------------------- footprint
function drawFp() {
  const P = begin('fp'); if (!P) return; const { x, w, h } = P;
  if (!candles.length) return waiting(P, 'waiting for trades…');
  const AX = 62, LAB = 58, TOP = 18, SUMH = 5 * 18 + 6, plotW = w - AX - LAB, ch = h - TOP - SUMH;
  const ncol = Math.max(1, Math.floor(plotW / fv.cw)), cw = plotW / ncol;
  fv.back = Math.max(0, Math.min(candles.length - 1, fv.back));
  const end = candles.length - Math.round(fv.back), vis = candles.slice(Math.max(0, end - ncol), end);
  let loT, hiT;
  if (fv.auto || fv.center === null) {
    loT = Infinity; hiT = -Infinity; for (const c of vis) { loT = Math.min(loT, c.l); hiT = Math.max(hiT, c.h); }
    loT = Math.floor(loT / bucketTicks) * bucketTicks - bucketTicks; hiT = (Math.floor(hiT / bucketTicks) + 2) * bucketTicks;
    fv.center = (loT + hiT) / 2; fv.half = (hiT - loT) / 2;
  } else { loT = fv.center - fv.half; hiT = fv.center + fv.half; }
  const Y = pt => TOP + (hiT - pt) / (hiT - loT) * ch, rowPx = bucketTicks / (hiT - loT) * ch;
  let cmax = 1e-12; for (const c of vis) for (let j = 0; j < c.cells.length; j += 3) cmax = Math.max(cmax, c.cells[j + 1], c.cells[j + 2]);
  const fs = Math.max(8, Math.min(12, rowPx - 5)), text = rowPx >= 11 && cw >= 70;
  x.save(); x.beginPath(); x.rect(0, TOP, w - AX, ch); x.clip();
  // session profile (left column) over the visible candles
  const sp = new Map(); for (const c of vis) for (let j = 0; j < c.cells.length; j += 3) sp.set(c.cells[j], (sp.get(c.cells[j]) || 0) + c.cells[j + 1] + c.cells[j + 2]);
  const smax = Math.max(1e-12, ...sp.values()), spoc = valueArea(sp);
  for (const [b, v] of sp) { const lw = v / smax * (LAB - 10); x.fillStyle = spoc && b === spoc.poc ? rgba(C.OR, 0.85) : 'rgba(184,184,184,0.28)'; x.fillRect(LAB - 3 - lw, Y((b + 1) * bucketTicks) + 0.5, lw, Math.max(1, rowPx - 1)); }
  const off = ncol - vis.length;
  vis.forEach((c, i) => {
    const x0 = LAB + (off + i) * cw, cx = x0 + 8, cellL = x0 + 16, cellW = (cw - 20) / 2;
    let candleMax = 0; for (let j = 0; j < c.cells.length; j += 3) candleMax = Math.max(candleMax, c.cells[j + 1], c.cells[j + 2]);
    const imb = imbalances(c.cells, 3, candleMax * 0.05), pk = poc(c.cells);
    for (let j = 0; j < c.cells.length; j += 3) {
      const b = c.cells[j], sv = c.cells[j + 1], bv = c.cells[j + 2], y = Y((b + 1) * bucketTicks) + 0.5, hh = Math.max(1, rowPx - 1), f = imb.get(b) || 0;
      if (text) {
        x.fillStyle = f & 2 ? C.R : rgba(C.R, 0.1 + 0.55 * Math.sqrt(sv / cmax)); x.fillRect(cellL, y, cellW - 1, hh);
        x.fillStyle = f & 1 ? C.G : rgba(C.G, 0.1 + 0.55 * Math.sqrt(bv / cmax)); x.fillRect(cellL + cellW, y, cellW - 1, hh);
        x.font = `${f & 2 ? 'bold ' : ''}${fs}px ${MONO}`; x.textAlign = 'right'; x.fillStyle = f & 2 ? '#fff' : C.TXT; x.fillText(fQ(sv), cellL + cellW - 4, y + hh / 2);
        x.font = `${f & 1 ? 'bold ' : ''}${fs}px ${MONO}`; x.textAlign = 'left'; x.fillStyle = f & 1 ? '#fff' : C.TXT; x.fillText(fQ(bv), cellL + cellW + 3, y + hh / 2);
      } else {                                                  // zoomed out: bars instead of numbers
        const ls = sv / cmax * cellW, lbv = bv / cmax * cellW;
        x.fillStyle = f & 2 ? C.R : rgba(C.R, 0.6); x.fillRect(cellL + cellW - ls, y, ls, hh);
        x.fillStyle = f & 1 ? C.G : rgba(C.G, 0.6); x.fillRect(cellL + cellW, y, lbv, hh);
      }
      if (b === pk) { x.strokeStyle = C.OR; x.lineWidth = 1.4; x.strokeRect(cellL - 0.5, y - 0.5, cellW * 2 - 0.5, hh + 1); x.lineWidth = 1; }
    }
    const col = c.c >= c.o ? C.G : C.R, yb = Y(Math.max(c.o, c.c) + 1), yb2 = Y(Math.min(c.o, c.c));
    if (!c.cells.length) {                                      // older than the loaded trades: a normal candle (exchange OHLC)
      const mx = x0 + cw / 2; x.strokeStyle = col; x.beginPath(); x.moveTo(Math.round(mx) + 0.5, Y(c.h + 1)); x.lineTo(Math.round(mx) + 0.5, Y(c.l)); x.stroke();
      x.fillStyle = col; x.fillRect(mx - cw * 0.22, yb, cw * 0.44, Math.max(2, yb2 - yb));
    } else {
      x.strokeStyle = col; x.beginPath(); x.moveTo(cx + 0.5, Y(c.h + 1)); x.lineTo(cx + 0.5, Y(c.l)); x.stroke();
      x.fillStyle = col; x.fillRect(cx - 3, yb, 7, Math.max(2, yb2 - yb));
    }
  });
  if (S.n) { const y = Math.round(Y(S.p[S.n - 1] + 0.5)) + 0.5; x.strokeStyle = rgba('#ffffff', 0.35); x.setLineDash([2, 3]); x.beginPath(); x.moveTo(LAB, y); x.lineTo(w - AX, y); x.stroke(); x.setLineDash([]); }
  x.restore();
  // candle times and summary table
  x.font = `10px ${SANS}`; x.textAlign = 'center';
  vis.forEach((c, i) => {
    const x0 = LAB + (off + i) * cw; x.fillStyle = C.SUB; x.fillText(hm(c.k * tf, tf < 6e4), x0 + cw / 2, 9);
    if (c.partial && c.cells.length) { x.fillStyle = rgba(C.OR, 0.85); x.fillText(`cells from ${hm(c.cellsFrom)}`, x0 + cw / 2, TOP + 7); }   // footprint covers only part of this candle
    [[c.d, 1], [c.v, 0], [c.dmin, 1], [c.dmax, 1], [c.cvd, 1]].forEach(([v, sg], j) => {
      const y = h - SUMH + 6 + j * 18; x.fillStyle = j % 2 ? '#0c0c0c' : '#161616'; x.fillRect(x0 + 1, y, cw - 2, 17);
      x.font = `11px ${MONO}`;
      if (v == null) { x.fillStyle = C.MUT; x.fillText('–', x0 + cw / 2, y + 9); }
      else { x.fillStyle = sg ? (v >= 0 ? C.G : C.R) : C.TXT; x.fillText(sg ? fS(v) : fQ(v), x0 + cw / 2, y + 9); }
      x.font = `10px ${SANS}`;
    });
  });
  x.textAlign = 'left'; x.fillStyle = C.SUB; x.font = `10.5px ${SANS}`; ['Delta', 'Volume', 'Min Δ', 'Max Δ', 'CVD'].forEach((l, j) => x.fillText(l, 6, h - SUMH + 6 + j * 18 + 9));
  x.strokeStyle = C.LINE; x.beginPath(); x.moveTo(0, h - SUMH + 2.5); x.lineTo(w, h - SUMH + 2.5); x.stroke();
  priceAxis(x, w, ch, loT, hiT, pt => Y(pt + 0.5) - TOP, S.n ? S.p[S.n - 1] : null, S.n && S.s[S.n - 1] > 0 ? C.G : C.R, 0);
  if (fv.back >= 1) { x.fillStyle = rgba(C.OR, 0.9); x.textAlign = 'left'; x.font = `11px ${SANS}`; x.fillText(`${Math.round(fv.back)} candles back · ⟲ for latest`, LAB + 6, TOP + 10); }
  $('fpInfo').textContent = ` · ${fmtSpan(tf)} · bucket ${(bucketTicks * tick).toFixed(decimals(bucketTicks * tick))} · sell × buy` + (mk.flow ? ` · flow ${mk.flow}` : '');
}

// ---------------------------------------------------------------- DOM ladder
function drawDom() {
  const P = begin('dom'); if (!P) return; const { x, w, h } = P;
  const c = cols[cols.length - 1]; if (!c) return waiting(P, 'waiting for the book…');
  const HD = 20, rh = 18, rows = Math.max(4, Math.floor((h - HD) / rh)), half = rows >> 1;
  const bbBin = Math.floor(c.bb / binTicks), baBin = Math.floor(c.ba / binTicks), midBin = Math.floor((c.bb + c.ba) / 2 / binTicks);
  const top = midBin + half, cut = S.n ? S.t[S.n - 1] - 60000 : 0, tr = new Map();
  for (let j = lb(S.t, S.n, cut); j < S.n; j++) { const k = Math.floor(S.p[j] / binTicks), e = tr.get(k) || [0, 0]; e[S.s[j] > 0 ? 1 : 0] += S.q[j]; tr.set(k, e); }
  const abs = []; for (const v of c.data) if (v) abs.push(Math.abs(v)); const big = quantile(abs, 0.97);
  let mx = 1e-12, bidT = 0, askT = 0;
  for (let r = 0; r < rows; r++) { const v = c.data[top - r - c.lo] || 0; mx = Math.max(mx, Math.abs(v)); }
  for (let k = 0; k < 10; k++) { bidT += Math.abs(c.data[bbBin - k - c.lo] || 0); askT += Math.abs(c.data[baBin + k - c.lo] || 0); }
  const Cx = [0, w * 0.19, w * 0.42, w * 0.62, w * 0.85, w];
  x.fillStyle = C.SUB; x.font = `10px ${SANS}`; x.textAlign = 'center';
  ['sold 60s', 'Bid', 'Price', 'Ask', 'bought 60s'].forEach((l, i) => x.fillText(l, (Cx[i] + Cx[i + 1]) / 2, HD / 2));
  x.font = `11px ${MONO}`;
  for (let r = 0; r < rows; r++) {
    const k = top - r, y = HD + r * rh, v = c.data[k - c.lo] || 0, t = tr.get(k);
    x.fillStyle = r % 2 ? '#000000' : '#0c0c0c'; x.fillRect(0, y, w, rh);
    if (k === bbBin) { x.fillStyle = rgba(C.G, 0.14); x.fillRect(0, y, w, rh); } else if (k === baBin) { x.fillStyle = rgba(C.R, 0.14); x.fillRect(0, y, w, rh); }
    const a = Math.abs(v), bw = a / mx * (Cx[2] - Cx[1] - 6);
    if (v < 0) { x.fillStyle = rgba(C.G, 0.32); x.fillRect(Cx[2] - 3 - bw, y + 2, bw, rh - 4); x.fillStyle = a >= big ? C.OR : '#84ccc0'; x.textAlign = 'right'; x.fillText(fQ(a), Cx[2] - 6, y + rh / 2); }
    else if (v > 0) { x.fillStyle = rgba(C.R, 0.32); x.fillRect(Cx[3] + 3, y + 2, bw, rh - 4); x.fillStyle = a >= big ? C.OR : '#f99ba2'; x.textAlign = 'left'; x.fillText(fQ(a), Cx[3] + 6, y + rh / 2); }
    x.textAlign = 'center'; x.fillStyle = (k * binTicks) % (Math.round(mk.axis / tick)) === 0 ? '#ffffff' : C.SUB; x.fillText(fP(k * binTicks), (Cx[2] + Cx[3]) / 2, y + rh / 2);
    if (t && t[0]) { x.fillStyle = C.R; x.textAlign = 'right'; x.fillText(fQ(t[0]), Cx[1] - 6, y + rh / 2); }
    if (t && t[1]) { x.fillStyle = C.G; x.textAlign = 'left'; x.fillText(fQ(t[1]), Cx[4] + 6, y + rh / 2); }
  }
  x.strokeStyle = C.LINE; for (const cx of Cx.slice(1, 5)) { x.beginPath(); x.moveTo(Math.round(cx) + 0.5, HD); x.lineTo(Math.round(cx) + 0.5, h); x.stroke(); }
  const imb = (bidT - askT) / Math.max(1e-12, bidT + askT);
  $('domInfo').textContent = ` · ${mk.bin} rows`;
  $('domR').innerHTML = `book imbalance (10 rows) <span class="${imb >= 0 ? 'g' : 'rd'}">${imb >= 0 ? '+' : ''}${(imb * 100).toFixed(0)}%</span>`;
}

// ---------------------------------------------------------------- tape
function drawTape() {
  const P = begin('tape'); if (!P) return; const { x, w, h } = P, rh = 19, rows = Math.floor(h / rh);
  let n = 0;
  for (let j = S.n - 1; j >= 0 && n < rows; j--) {
    if (S.q[j] < th.tape) continue;
    const y = n * rh, big = S.q[j] >= th.big, col = S.s[j] > 0 ? C.G : C.R; n++;
    x.fillStyle = rgba(col, big ? 0.28 : 0.08); x.fillRect(0, y + 1, w, rh - 2);
    x.font = `${big ? 'bold ' : ''}11px ${MONO}`; x.textAlign = 'left';
    x.fillStyle = C.MUT; x.fillText(hm(S.t[j], true), 8, y + rh / 2);
    x.fillStyle = C.TXT; x.fillText(fP(S.p[j]), w * 0.32, y + rh / 2);
    x.fillStyle = col; x.textAlign = 'right'; x.fillText(`${fQ(S.q[j])} ${mk.unit}`, w - 46, y + rh / 2);
    x.textAlign = 'left'; x.fillText(S.s[j] > 0 ? 'BUY' : 'SELL', w - 40, y + rh / 2);
  }
  if (!n) waiting(P, 'no large trades yet');
  $('tapeInfo').textContent = ` · ≥ ${fQ(th.tape)} ${mk.unit}`; $('tapeR').textContent = `big ≥ ${fQ(th.big)} ${mk.unit}`;
}

// ---------------------------------------------------------------- header + footer
function drawHdr() {
  const last = S.n ? S.p[S.n - 1] : null, up = S.n && S.s[S.n - 1] > 0;
  $('hp').textContent = last == null ? '-' : fP(last); $('hp').style.color = last == null ? C.TXT : up ? C.G : C.R;
  const c = cols[cols.length - 1];
  let hs = c ? `bid ${fP(c.bb)} · ask ${fP(c.ba)}` : '';
  if (mk.spot) {
    const sp = stat.spot;
    if (!sp || sp.err && sp.mid == null) hs += ` · spot feed unavailable${sp && sp.err ? ' (' + sp.err + ')' : ''}: prices are ${mk.flow}`;
    else if (sp.open) hs += ` · spot ${sp.mid.toFixed(dp + 1)} live (Swissquote) · = ${mk.flow} − ${(sp.off ?? 0).toFixed(2)}`;
    else hs += ` · spot shut since ${hm(sp.ts)} IST · showing ${mk.flow} − ${(sp.off ?? 0).toFixed(2)} (gap at the close)`;
  } else if (c) hs += ` · spread ${fP(c.ba - c.bb)}`;
  $('hs').textContent = hs;
  const ok = stat.synced && (stat.conn === 'live' || stat.conn === 'book open'), bad = /closed|error|down/.test(stat.conn || '') || stat.book === 'down';
  $('dot').className = 'dot ' + (bad ? 'bad' : ok ? 'ok' : 'warn');
  $('lv').textContent = bad ? `reconnecting (${stat.conn || stat.book})` : `${ok ? 'LIVE' : (stat.book || 'connecting')} · ${stat.delay == null ? '-' : Math.max(0, stat.delay)} ms · ${stat.gaps || 0} gaps`;
  $('lv').title = 'delay = time from the exchange stamping a message to it arriving here (includes any laptop clock error)' + (stat.lastGap ? '\nlast gap: ' + stat.lastGap : '');
  if (!S.n) { $('foot').textContent = stat.note || ''; return; }
  let v = 0, b = 0; for (let i = 0; i < S.n; i++) { v += S.q[i]; if (S.s[i] > 0) b += S.q[i]; }
  const refQ = 10 ** Math.round(Math.log10(Math.max(1e-9, th.big * 5)));
  const lamTxt = lam && isFinite(lam.lambda) ? `impact λ <b>${(lam.lambda * refQ).toFixed(dp + 1)}</b> per ${fQ(refQ)} ${mk.unit} net (r ${lam.r.toFixed(2)}, 10 s bars)` : 'impact λ: collecting';
  $('foot').innerHTML = `<span>since <b>${hm(S.t[0])} IST</b></span><span>trades <b>${S.n.toLocaleString()}</b></span><span>volume <b>${fQ(v)} ${mk.unit}</b></span>` +
    `<span>delta <b class="${S.cd[S.n - 1] >= 0 ? 'g' : 'rd'}">${fS(S.cd[S.n - 1])}</b></span><span>buy share <b>${(b / v * 100).toFixed(1)}%</b></span><span>${lamTxt}</span>` +
    `<span>${stat.msgs ? Math.round(stat.msgs) + ' msg/s' : ''}</span><span class="sp"></span><span>${mk.thin ? '<span class="o">thin market: small share of real volume</span> · ' : ''}${stat.note || ''}</span>`;
}

// ---------------------------------------------------------------- controls
function chip(label, on, fn) { const d = document.createElement('div'); d.className = 'chip' + (on ? ' on' : ''); d.textContent = label; d.onclick = fn; return d; }
function buildControls() {
  const sel = $('mkt'); sel.innerHTML = '';
  const groups = { spot: 'Spot (order flow from Binance)', binance: 'Binance futures', bybit: 'Bybit', hl: 'Hyperliquid' };
  for (const [ex, name] of Object.entries(groups)) {
    const og = document.createElement('optgroup'); og.label = name;
    for (const [k, m] of Object.entries(MARKETS)) if ((m.spot ? 'spot' : m.ex) === ex) { const o = document.createElement('option'); o.value = k; o.textContent = m.label + (m.thin ? ' (thin)' : ''); og.appendChild(o); }
    sel.appendChild(og);
  }
  sel.value = key; sel.onchange = () => open(sel.value);
  const tfs = $('tfs'); tfs.innerHTML = '';
  for (const [l, v] of [['15s', 15000], ['1m', 60000], ['5m', 300000], ['15m', 900000], ['1h', 3600000], ['4h', 14400000]]) tfs.appendChild(chip(l, v === tf, () => { tf = v; LS.set('tf', v); fv.back = 0; worker.postMessage({ type: 'config', tf: v }); buildControls(); }));
  const bks = $('bks'); bks.innerHTML = '';
  for (const b of mk.buckets) bks.appendChild(chip(b.toFixed(decimals(b)), Math.round(b / tick) === bucketTicks, () => {
    bucketTicks = Math.round(b / tick); bucketBy[key] = b; LS.set('bucket', bucketBy); fv.auto = true; worker.postMessage({ type: 'config', bucket: b }); buildControls(); }));
}
for (const b of document.querySelectorAll('nav button')) b.onclick = () => {
  document.body.dataset.tab = b.dataset.tab; for (const o of document.querySelectorAll('nav button')) o.classList.toggle('on', o === b);
  requestAnimationFrame(() => { ['heat', 'delta', 'cvd', 'fp', 'dom', 'tape'].forEach(setup); all(); });
};

// zoom / pan
const zoomHeatTime = f => { hv.span = Math.max(20e3, Math.min(24 * 3600e3, hv.span * f)); LS.set('span', hv.span); };
const zoomHeatPrice = f => { hv.halfBins = Math.max(8, Math.min(150, hv.halfBins * f)); LS.set('halfBins', hv.halfBins); };
const zoomFp = f => { fv.cw = Math.max(36, Math.min(260, fv.cw * f)); LS.set('cw', fv.cw); };
for (const b of document.querySelectorAll('.zb button')) b.onclick = () => {
  const z = b.dataset.z;
  if (z === 'heat+') { zoomHeatTime(0.7); zoomHeatPrice(0.8); } else if (z === 'heat-') { zoomHeatTime(1.4); zoomHeatPrice(1.25); }
  else if (z === 'heat0') { hv.live = true; hv.auto = true; hv.center = null; }
  else if (z === 'heatC') { hv.contrast = ((hv.contrast ?? 1) + 1) % CONTRAST.length; LS.set('contrast', hv.contrast); }
  else if (z === 'fp+') zoomFp(1.25); else if (z === 'fp-') zoomFp(0.8); else if (z === 'fp0') { fv.back = 0; fv.auto = true; }
  all();
};
function drag(id, onMove, onDbl, onWheel) {
  const c = $(id); let p = null;
  c.addEventListener('pointerdown', e => { p = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
  c.addEventListener('pointermove', e => { if (!p) return; onMove(e.clientX - p.x, e.clientY - p.y, e); p = { x: e.clientX, y: e.clientY }; touched = performance.now(); all(); });
  c.addEventListener('pointerup', () => { p = null; }); c.addEventListener('pointercancel', () => { p = null; });
  c.addEventListener('dblclick', () => { onDbl(); all(); });
  c.addEventListener('wheel', e => { e.preventDefault(); onWheel(e); touched = performance.now(); all(); }, { passive: false });
}
drag('heat', (dx, dy) => {
  const P = pane.heat; if (!P) return; const hh = P.h - 18, hw = P.w - 62;
  if (Math.abs(dy) >= Math.abs(dx)) { hv.auto = false; hv.center += dy / hh * 2 * hv.halfBins * binTicks; }
  else { const [, tEnd] = heatWindow(); hv.tEnd = tEnd - dx / hw * hv.span; hv.live = false; if (S.n && hv.tEnd >= S.t[S.n - 1]) hv.live = true; }
}, () => { hv.live = true; hv.auto = true; hv.center = null; },
e => { const P = pane.heat; const onAxis = P && e.offsetX > P.w - 62; if (e.shiftKey || onAxis) zoomHeatPrice(e.deltaY > 0 ? 1.12 : 0.89); else zoomHeatTime(e.deltaY > 0 ? 1.15 : 0.87); });
drag('fp', (dx, dy) => {
  const P = pane.fp; if (!P) return;
  if (Math.abs(dx) > Math.abs(dy)) fv.back = Math.max(0, fv.back + dx / fv.cw);
  else { if (fv.center === null) return; fv.auto = false; fv.center += dy / (P.h - 114) * 2 * fv.half; }
}, () => { fv.back = 0; fv.auto = true; },
e => { if (e.shiftKey) { fv.auto = false; fv.half = Math.max(bucketTicks * 3, (fv.half || 100) * (e.deltaY > 0 ? 1.12 : 0.89)); } else zoomFp(e.deltaY > 0 ? 0.9 : 1.1); });

// ---------------------------------------------------------------- render loop: draw only what changed
const draws = { heat: drawHeat, delta: drawDelta, cvd: drawCvd, fp: drawFp, dom: drawDom, tape: drawTape, hdr: drawHdr };
// heavy panels (heatmap, footprint) redraw at most 4 times a second from data; at once when you drag or zoom
let lastHeavy = 0, touched = 0; const HEAVY = new Set(['heat', 'fp']);
function loop() {
  if (dirty.size && mk) {
    updateStats(); const now = performance.now(), heavyOk = now - lastHeavy >= 250 || now - touched < 300;
    for (const k of [...dirty]) { if (HEAVY.has(k) && !heavyOk) continue; dirty.delete(k); try { draws[k](); } catch (e) { console.error(k, e); } if (HEAVY.has(k)) lastHeavy = now; }
  }
  requestAnimationFrame(loop);
}
['heat', 'delta', 'cvd', 'fp', 'dom', 'tape'].forEach(setup);
open(key);
requestAnimationFrame(loop);
window.__of = { get state() { return { key, tick, binTicks, bucketTicks, tf, trades: S.n, cols: cols.length, candles: candles.length, stat, th, lam }; } };   // for checking from the console
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
