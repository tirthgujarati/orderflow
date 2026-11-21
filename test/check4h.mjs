// Loads 12 h of XAUUSD (Binance gold flow) at 4h candles like the app does, then compares every 4h candle that loaded
// trades fully cover with Binance's own 4h candle (volume, delta = 2 x taker buy - volume, high, low).
import { createEngine } from '../engine.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const e = createEngine(() => {}); e.on({ type: 'open', key: 'spot:XAUUSD', tf: 14400000 });
const t0 = Date.now();
while (Date.now() - t0 < 280000) { await new Promise(r => setTimeout(r, 5000)); const s = e.debug().stat; if (/^history from/.test(s.note || '')) break; }
const { stat, tr, view, off, mk } = e.debug();
console.log('note:', stat.note, '| trades', tr.n, '| from', new Date(tr.t[0]).toISOString(), '| offset', (off * mk.tick).toFixed(2));
const kl = await (await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=4h&limit=6')).json();
let checked = 0;
for (const k of kl) {
  const key = k[0] / 14400000, closed = k[6] < Date.now(); if (!closed) continue;
  const v = view(key); if (v.partial) { console.log('     ', new Date(k[0]).toISOString().slice(0, 16), 'partly before the loaded trades (cells from', new Date(v.cellsFrom || 0).toISOString().slice(11, 16) + '); OHLC/delta taken from the Binance candle'); continue; }
  const kv = +k[5], kd = 2 * +k[9] - kv, kh = Math.round(+k[2] / mk.tick) - off, kL = Math.round(+k[3] / mk.tick) - off;
  checked++;
  ok(Math.abs(v.v - kv) < 1e-6 && Math.abs(v.d - kd) < 1e-6 && v.h === kh && v.l === kL,
    `${new Date(k[0]).toISOString().slice(0, 16)} 4h: trades v ${v.v.toFixed(3)} d ${v.d.toFixed(3)} H ${(v.h * mk.tick).toFixed(2)} L ${(v.l * mk.tick).toFixed(2)} | Binance v ${kv.toFixed(3)} d ${kd.toFixed(3)} H ${(kh * mk.tick).toFixed(2)} L ${(kL * mk.tick).toFixed(2)} (spot prices = perp - offset)`);
}
ok(checked > 0, `${checked} closed 4h candle(s) fully covered by loaded trades were compared`);
e.on({ type: 'close' }); console.log(fails ? `${fails} FAILED` : 'all checks passed'); process.exit(fails ? 1 : 0);
