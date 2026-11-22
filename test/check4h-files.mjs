// End-to-end 4h footprint check: the real engine (XAUUSD, OANDA 4h clock) loads Binance daily files, then each complete
// 4h candle of the test day is compared with
//   (a) an independent count from the raw daily file (volume, delta, trades, high, low, sum of footprint cells)
//   (b) TradingView OANDA:XAUUSD candles (5m candles saved from TradingView, grouped into the same 4h windows), prices
//       compared after adding back the engine's perp-spot offset
//   node test/check4h-files.mjs <binance aggTrades zip of the day> <tv 5m file> [YYYY-MM-DD=2026-11-20]
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createEngine } from '../engine.js';
import { candleClock } from '../core.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const [zipPath, tvPath, dayArg = '2026-11-20'] = process.argv.slice(2), day = Date.parse(dayArg + 'T00:00:00Z');
const clock = candleClock(4 * 3600e3, 'oanda');

const e = createEngine(() => {}); e.on({ type: 'open', key: 'spot:XAUUSD', tf: 14400000, session: 'oanda', bucket: 1, backfillMin: 5, proxy: process.env.PROXY || null });
const t0 = Date.now();
while (Date.now() - t0 < 600000) { await new Promise(r => setTimeout(r, 5000)); const s = e.debug().stat; process.stdout.write(`\r${s.note || ''}                    `); if (/^footprint history/.test(s.note || '') && e.debug().offHist.has(Math.floor(day / 60000) + 600)) break; }
console.log();
const { viewAll, off, fileHours, mk } = e.debug();
const list = viewAll(), tick = mk.tick;
console.log(`engine: ${fileHours.size} file hours, live offset $${(off * tick).toFixed(2)}, spot history ${e.debug().offHist.size} minutes, ${list.length} candles`);

// (a) independent count from the raw file
const zip = readFileSync(zipPath), n = zip.readUInt16LE(26), x = zip.readUInt16LE(28);
const ref = new Map();
for (const ln of inflateRawSync(zip.subarray(30 + n + x)).toString().split('\n')) {
  const f = ln.split(','); if (f.length < 7 || f[0] === 'agg_trade_id') continue;
  const t = +f[5], k = clock.keyOf(t), c = Math.round(+f[1] * 100), q = +f[2], s = f[6] === 'true' ? -1 : 1;
  let r = ref.get(k); if (!r) { r = { v: 0, d: 0, n: 0, h: -1, l: 1e12, t0: clock.startOf(k) }; ref.set(k, r); }
  r.v += q; r.d += s * q; r.n++; r.h = Math.max(r.h, c); r.l = Math.min(r.l, c);
}
// (b) TradingView 5m -> same 4h windows
const lines = readFileSync(tvPath, 'utf8').split('\n'), base = +lines[0].split('=')[1], tv = new Map();
for (const row of lines[3].trim().split(';')) {
  const v = row.split(',').map(z => parseInt(z, 36)), t = day + v[0] * 60000, k = clock.keyOf(t);
  let r = tv.get(k); if (!r) { r = { o: (v[1] + base) / 1000, h: -1, l: 1e9, c: 0 }; tv.set(k, r); }
  r.h = Math.max(r.h, (v[2] + base) / 1000); r.l = Math.min(r.l, (v[3] + base) / 1000); r.c = (v[4] + base) / 1000;
}
let checked = 0;
for (const c of list) {
  const r = ref.get(c.k); if (!r || c.partial || c.t0 < day || c.t0 + 4 * 3600e3 > day + 864e5) continue;
  checked++;
  let cv = 0; for (let i = 0; i < c.cells.length; i += 3) cv += c.cells[i + 1] + c.cells[i + 2];
  // (exchange high/low are not compared here: each hour is shown with its own spot offset, so they are checked against
  //  TradingView below instead; test/checkbig.mjs checks raw highs/lows of the daily-file reader)
  ok(Math.abs(c.v - r.v) < 1e-6 && Math.abs(c.d - r.d) < 1e-6 && c.n === r.n && Math.abs(cv - r.v) < 1e-6,
    `4h ${new Date(c.t0).toISOString().slice(5, 16)} UTC: engine v ${c.v.toFixed(3)} d ${c.d.toFixed(3)} n ${c.n} | raw file v ${r.v.toFixed(3)} d ${r.d.toFixed(3)} n ${r.n}`);
  const t = tv.get(c.k);
  if (t) console.log(`     vs TradingView OANDA same 4h: open ${(c.o * tick).toFixed(2)} / ${t.o.toFixed(2)}, high ${(c.h * tick).toFixed(2)} / ${t.h.toFixed(2)}, low ${(c.l * tick).toFixed(2)} / ${t.l.toFixed(2)}, close ${(c.c * tick).toFixed(2)} / ${t.c.toFixed(2)} (offset of each hour applied)`);
  if (t) { const dc = Math.abs(c.c * tick - t.c), dh = Math.abs(c.h * tick - t.h), dl = Math.abs(c.l * tick - t.l); ok(dc < 1 && dh < 1 && dl < 1, `     price vs TradingView OANDA within $1 (different spot feed + $0.05 rows): close ${dc.toFixed(2)}, high ${dh.toFixed(2)}, low ${dl.toFixed(2)}`); }
}
ok(checked >= 4, `${checked} complete 4h candles of ${dayArg} checked (OANDA clock)`);
e.on({ type: 'close' }); console.log(fails ? `${fails} FAILED` : 'all checks passed'); process.exit(fails ? 1 : 0);
