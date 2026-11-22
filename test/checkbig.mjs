// 1h / 4h footprint check, independent of the engine:
//  - downloads one Binance daily trade file directly, builds hourly volume and delta from the raw CSV here,
//  - runs the engine's own daily-file reader (binanceDayHours) on the same day,
//  - compares every hour (volume, delta, trade count, high, low, and the sum of all footprint cells),
//  - checks that 4h candles start where TradingView's OANDA / FOREX.com / Binance 4h candles start.
//   node test/checkbig.mjs [YYYY-MM-DD=2026-11-20]
import { binanceDayHours } from '../feeds.js';
import { candleClock } from '../core.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const day = Date.parse((process.argv[2] || '2026-11-20') + 'T00:00:00Z');
const t0 = performance.now();
const hrs = await binanceDayHours('XAUUSDT', day, 0.01, 5);
console.log(`engine reader: ${hrs.length} hours in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
// independent: plain unzip of the same file with DecompressionStream is the same code path, so read the CSV through a
// different route: Node's zlib inflateRaw on the raw zip bytes
const { inflateRawSync } = await import('node:zlib');
const name = new Date(day).toISOString().slice(0, 10);
const zip = Buffer.from(await (await fetch(`https://data.binance.vision/data/futures/um/daily/aggTrades/XAUUSDT/XAUUSDT-aggTrades-${name}.zip`)).arrayBuffer());
const nameLen = zip.readUInt16LE(26), extra = zip.readUInt16LE(28), csize = zip.readUInt32LE(18);
let csv = inflateRawSync(zip.subarray(30 + nameLen + extra, csize ? 30 + nameLen + extra + csize : undefined)).toString();
const ref = new Map();
for (const ln of csv.split('\n')) {
  const f = ln.split(','); if (f.length < 7 || f[0] === 'agg_trade_id') continue;
  const h = Math.floor(+f[5] / 3600e3), cents = Math.round(+f[1] * 100), q = +f[2], s = f[6] === 'true' ? -1 : 1;
  let r = ref.get(h); if (!r) { r = { v: 0, d: 0, n: 0, hi: -1, lo: 1e12 }; ref.set(h, r); }
  r.v += q; r.d += s * q; r.n++; r.hi = Math.max(r.hi, cents); r.lo = Math.min(r.lo, cents);
}
csv = null;
let bad = 0;
for (const x of hrs) {
  const r = ref.get(x.h); let cv = 0; for (let i = 0; i < x.cells.length; i += 3) cv += x.cells[i + 1] + x.cells[i + 2];
  if (!r || Math.abs(r.v - x.v) > 1e-6 || Math.abs(r.d - x.d) > 1e-6 || r.n !== x.n || r.hi !== x.hi || r.lo !== x.lo || Math.abs(cv - x.v) > 1e-6) { bad++; console.log('  mismatch hour', x.h, r, x.v, x.d, x.n); }
}
ok(hrs.length === ref.size && bad === 0, `${hrs.length} hours: volume, delta, count, high, low and footprint totals identical to an independent read (mismatches ${bad})`);
const iso = t => new Date(t).toISOString().slice(11, 16);
const exp = { oanda: ['02:00', '06:00', '10:00', '14:00', '18:00', '22:00'], fx: ['03:00', '07:00', '11:00', '15:00', '19:00', '23:00'], utc: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'] };
for (const [s, want] of Object.entries(exp)) {
  const c = candleClock(4 * 3600e3, s), got = new Set();
  for (let h = 0; h < 24; h++) got.add(iso(c.startOf(c.keyOf(day + h * 3600e3))));
  ok(want.every(w => got.has(w)) && got.size === 6, `4h ${s}: candles start ${[...got].sort().join(' ')} UTC on ${name} (TradingView shows ${want.join(' ')})`);
}
console.log(fails ? `${fails} FAILED` : 'all checks passed'); process.exit(fails ? 1 : 0);
