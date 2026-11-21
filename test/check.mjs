// Accuracy checks for the order-flow engine.
//   node test/check.mjs offline <binance aggTrades csv>   rebuilds candles/footprint from a day of trades and compares with an
//                                                          independent integer-cents calculation
//   node test/check.mjs live [seconds=75]                  runs the real engine on Binance, Bybit and Hyperliquid, then compares
//                                                          its order book and a closed candle with the exchanges' own REST answers
import { readFileSync } from 'node:fs';
import { MARKETS, Candles, toTick, imbalances, poc, impact } from '../core.js';
import { createEngine } from '../engine.js';

const mode = process.argv[2] || 'live';
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fails++; };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const cents = s => { const [i, f = ''] = s.split('.'); return +(i + (f + '00').slice(0, 2)); };   // "3746.8" -> 374680, no floating point

if (mode === 'offline') {
  const lines = readFileSync(process.argv[3], 'utf8').trim().split('\n').slice(1);
  const mk = MARKETS['binance:XAUUSDT'], BK = 25;                       // $0.25 buckets = 25 cents
  const cand = new Candles(60000, BK);
  const ref = new Map();                                                // independent: minute -> {o,h,l,c,v,d,cells}
  const T = [], P = [], Q = [], S = [];
  let vol = 0, buy = 0;
  for (const ln of lines) {
    const f = ln.split(','); const t = +f[5], q = +f[2], s = f[6] === 'true' ? -1 : 1, pc = cents(f[1]);
    cand.add(t, toTick(+f[1], mk.tick), q, s);
    T.push(t); P.push(pc); Q.push(q); S.push(s); vol += q; if (s > 0) buy += q;
    const k = Math.floor(t / 60000); let r = ref.get(k);
    if (!r) { r = { o: pc, h: pc, l: pc, c: pc, v: 0, d: 0, cells: new Map() }; ref.set(k, r); }
    r.h = Math.max(r.h, pc); r.l = Math.min(r.l, pc); r.c = pc; r.v += q; r.d += s * q;
    const b = Math.floor(pc / BK); const e = r.cells.get(b) || [0, 0]; e[s > 0 ? 1 : 0] += q; r.cells.set(b, e);
  }
  ok(cand.list.length === ref.size, `candles: engine ${cand.list.length}, independent ${ref.size}`);
  let bad = 0, cells = 0;
  for (const c of cand.list) {
    const r = ref.get(c.k);
    if (!r || c.o !== r.o || c.h !== r.h || c.l !== r.l || c.c !== r.c || !near(c.v, r.v) || !near(c.d, r.d) || c.cells.size !== r.cells.size) { bad++; continue; }
    for (const [b, e] of c.cells) { cells++; const x = r.cells.get(b); if (!x || !near(e[0], x[0]) || !near(e[1], x[1])) bad++; }
  }
  ok(bad === 0, `OHLC, volume, delta and ${cells.toLocaleString()} footprint cells identical (mismatches: ${bad})`);
  ok(near(cand.cvd, buy - (vol - buy)), `day CVD ${cand.cvd.toFixed(3)} = buys - sells ${(2 * buy - vol).toFixed(3)}`);
  ok(Math.round(vol) === 909934 && (buy / vol).toFixed(3) === '0.478', `volume ${Math.round(vol)} oz and buy share ${(buy / vol).toFixed(3)} match the Python study (909934, 0.478)`);
  const im = impact(Float64Array.from(T), Int32Array.from(P.map(x => x)), Float64Array.from(Q), Int8Array.from(S), T.length, 0.01, 10000);
  ok(Math.abs(im.lambda * 100 - 0.382) < 0.002, `impact lambda $${(im.lambda * 100).toFixed(3)} per 100 oz on 10 s bars (Python study: 0.382)`);
  // imbalance rule spot check on one constructed candle: buys 30 at bucket 10 vs sells 5 at bucket 9 -> buy imbalance
  const flat = [9, 5, 1, 10, 2, 30, 11, 20, 4];
  const im2 = imbalances(flat, 3); ok(im2.get(10) === 1 && poc(flat) === 10, 'diagonal imbalance and POC rules');
} else {
  const secs = +(process.argv[3] || 75);
  const markets = ['binance:XAUUSDT', 'bybit:XAUUSDT', 'hl:xyz:GOLD', 'spot:XAUUSD'];
  const engines = markets.map(key => {
    const st = { frames: 0, last: null, key };
    const e = createEngine(m => { if (m.type === 'frame') { st.frames++; st.last = m.stat; } });
    e.on({ type: 'open', key, tf: 60000, backfillMin: 3 });
    return { key, e, st };
  });
  await new Promise(r => setTimeout(r, secs * 1000));
  for (const { key, e, st } of engines) {
    const { mk, book, cand, stat, tr } = e.debug();
    console.log(`\n== ${key}: ${st.frames} frames, ${tr.n} trades, gaps ${stat.gaps}${stat.lastGap ? ' (' + stat.lastGap + ')' : ''}, crossed ${stat.crossed}, delay ${stat.delay} ms`);
    ok(stat.synced, `${key} book synced`);
    // 1. order book vs the exchange's REST book, fetched right now
    let rb, ra;
    if (mk.ex === 'binance') { const j = await (await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${mk.sym}&limit=20`)).json(); rb = j.bids; ra = j.asks; }
    else if (mk.ex === 'bybit') { const j = await (await fetch(`https://api.bytick.com/v5/market/orderbook?category=linear&symbol=${mk.sym}&limit=50`)).json(); rb = j.result.b; ra = j.result.a; }
    else { const j = await (await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'l2Book', coin: mk.sym }) })).json(); rb = j.levels[0].map(x => [x.px, x.sz]); ra = j.levels[1].map(x => [x.px, x.sz]); }
    let same = 0, tot = 0;
    for (const [side, lv] of [[book.bids, rb], [book.asks, ra]]) for (const [p, q] of lv.slice(0, 10)) { tot++; if (near(side.get(toTick(+p, mk.tick) - book.off) || 0, +q)) same++; }
    if (mk.spot) {                                               // spot conversion: offset = perp - spot gap, rounded to one row
      const { off, spot } = e.debug();
      ok(spot && Math.abs(off * mk.tick - spot.gap) <= mk.bin, `${key} offset ${(off * mk.tick).toFixed(2)} vs measured perp-spot gap ${spot ? spot.gap.toFixed(3) : '?'} (spot ${spot ? spot.mid.toFixed(3) : '?'}, ${spot && spot.open ? 'market open' : 'market shut, gap at the close'})`);
      const j = await (await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${mk.sym}&limit=1`)).json();
      ok(tr.n > 0, `${key} last shown price ${((tr.p[tr.n - 1]) * mk.tick).toFixed(2)} = perp ${((tr.p[tr.n - 1] + off) * mk.tick).toFixed(2)} - ${(off * mk.tick).toFixed(2)} (perp now ${(+j[0].p).toFixed(2)})`);
    }
    ok(same / tot >= 0.7, `${key} top-10 book levels equal to REST: ${same}/${tot} (the market moves between the two reads, so a few differences are normal)`);
    const [bb, ba] = book.best();
    ok(bb < ba, `${key} best bid ${(bb * mk.tick).toFixed(4)} < best ask ${(ba * mk.tick).toFixed(4)}`);
    // 2. last closed candle vs trades fetched independently from REST
    const closed = cand.list.filter(c => (c.k + 1) * 60000 < Date.now() - 2000);
    const c = closed[closed.length - 1];
    if (!c) { console.log(`     ${key}: no closed candle yet`); continue; }
    let rt = null;
    if (mk.ex === 'binance') {
      const j = await (await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=${mk.sym}&startTime=${c.k * 60000}&endTime=${c.k * 60000 + 59999}&limit=1000`)).json();
      rt = j.map(d => [d.T, +d.p, +d.q, d.m ? -1 : 1]);
    } else if (mk.ex === 'bybit') {
      const j = await (await fetch(`https://api.bytick.com/v5/market/recent-trade?category=linear&symbol=${mk.sym}&limit=1000`)).json();
      const all = j.result.list.map(x => [+x.time, +x.price, +x.size, x.side === 'Buy' ? 1 : -1]);
      if (all.length && Math.min(...all.map(x => x[0])) < c.k * 60000) rt = all.filter(x => Math.floor(x[0] / 60000) === c.k);
    }
    if (!rt) { console.log(`     ${key}: no independent REST trade source for this minute; candle v ${c.v.toFixed(4)} d ${c.d.toFixed(4)} n ${c.n}`); continue; }
    let v = 0, d = 0; for (const x of rt) { v += x[2]; d += x[3] * x[2]; }
    ok(rt.length < 1000 || mk.ex !== 'binance', `${key} REST returned the whole minute (${rt.length} trades)`);
    ok(near(c.v, v) && near(c.d, d) && c.n === rt.length, `${key} candle ${new Date(c.k * 60000).toISOString().slice(11, 16)} UTC: engine v ${c.v.toFixed(4)} d ${c.d.toFixed(4)} n ${c.n} | REST v ${v.toFixed(4)} d ${d.toFixed(4)} n ${rt.length}`);
    if (mk.ex === 'binance') {                                   // exchange candle for the same minute: delta = 2 x taker buy - volume must agree
      const k = await (await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${mk.sym}&interval=1m&startTime=${c.k * 60000}&limit=1`)).json();
      const kv = +k[0][5], kd = 2 * +k[0][9] - kv;
      ok(near(c.v, kv) && near(c.d, kd), `${key} same minute from Binance candles: v ${kv.toFixed(4)} d ${kd.toFixed(4)} (candle counts ${k[0][8]} raw fills; aggTrades merge fills of one order)`);
    }
  }
  for (const { e } of engines) e.on({ type: 'close' });
}
console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
