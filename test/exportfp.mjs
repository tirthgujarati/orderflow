// Export the last N hours of recorded gold trades (laptop recorder files) as a compact JS file for the footprint mockup.
import fs from 'node:fs';
const dir = 'data/rec/binance_XAUUSDT', hours = +(process.argv[2] || 4), off = +(process.argv[3] || 9.9), now = Date.now();
const rows = [];
for (const f of fs.readdirSync(dir).filter(f => f.startsWith('trades-')).sort()) {
  const b = fs.readFileSync(`${dir}/${f}`), a = new Float64Array(b.buffer, b.byteOffset, (b.length - b.length % 40) / 8);
  for (let i = 0; i < a.length; i += 5) rows.push([a[i], Math.round((a[i + 1] - off) * 100), a[i + 2], a[i + 3], a[i + 4]]);
}
rows.sort((x, y) => x[0] - y[0] || x[4] - y[4]);
const tEnd = rows.length ? rows[rows.length - 1][0] : now; rows.splice(0, rows.findIndex(r => r[0] >= tEnd - hours * 3600e3));
const seen = new Set(), T = [], P = [], Q = [], S = [];
for (const r of rows) { if (seen.has(r[4])) continue; seen.add(r[4]); T.push(r[0]); P.push(r[1]); Q.push(+r[2].toFixed(3)); S.push(r[3]); }
fs.writeFileSync('fp-data.js', `// real Binance XAUUSDT trades shown as XAUUSD (minus ${off}), exported ${new Date(now).toISOString()}\nwindow.FP={T:${JSON.stringify(T)},P:${JSON.stringify(P)},Q:${JSON.stringify(Q)},S:${JSON.stringify(S)}};\n`);
console.log(T.length, 'trades', new Date(T[0]).toISOString(), '->', new Date(T[T.length - 1]).toISOString(), 'price', Math.min(...P) / 100, Math.max(...P) / 100);
