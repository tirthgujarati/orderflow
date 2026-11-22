# Does our footprint (Binance XAUUSDT perp, shown as XAUUSD) match the global gold market? Friday 20 Nov 2026, 00:00-21:00 UTC.
# Sources: Binance + Bybit trades (aggressor side known), Dukascopy spot XAUUSD ticks, TradingView OANDA:XAUUSD 5m candles,
# COMEX gold futures GC=F 1m candles (Yahoo). Pure standard library.
import sys, os, io, csv, gzip, json, lzma, math, struct, zipfile, statistics as st, datetime as dt
D = sys.argv[1]
T0 = int(dt.datetime(2026, 11, 20, tzinfo=dt.timezone.utc).timestamp() * 1000); T1 = T0 + 21 * 3600_000
def corr(a, b):
    n = len(a); ma, mb = sum(a) / n, sum(b) / n
    sa = math.sqrt(sum((x - ma) ** 2 for x in a)); sb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sa * sb) if sa and sb else float('nan')
def pct(v, q): v = sorted(v); return v[min(len(v) - 1, int(q * len(v)))]

# ---------------- load
def trades_binance():
    z = zipfile.ZipFile(os.path.join(D, 'dl', 'binance.zip')); f = io.TextIOWrapper(z.open(z.namelist()[0]))
    r = csv.reader(f); next(r)
    return [(int(x[5]), float(x[1]), float(x[2]), -1 if x[6] == 'true' else 1) for x in r if T0 <= int(x[5]) < T1]
def trades_bybit():
    out = []
    with gzip.open(os.path.join(D, 'dl', 'bybit.csv.gz'), 'rt') as f:
        r = csv.reader(f); next(r)
        for x in r:
            t = int(float(x[0]) * 1000)
            if T0 <= t < T1: out.append((t, float(x[4]), float(x[3]), 1 if x[2] == 'Buy' else -1))
    out.sort(); return out
def ticks_duka():                                  # bi5: 20-byte big-endian records: ms, ask, bid (x1000), askVol, bidVol
    out = []
    for h in range(21):
        raw = open(os.path.join(D, 'dl', 'duka', f'{h:02d}.bi5'), 'rb').read()
        if len(raw) < 1000: continue
        b = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
        for i in range(0, len(b) - 19, 20):
            ms, ask, bid, av, bv = struct.unpack('>3I2f', b[i:i + 20])
            out.append((T0 + h * 3600_000 + ms, (ask + bid) / 2000, (ask - bid) / 1000))
    return out
def candles_tv():
    lines = open(os.path.join(D, 'tv-oanda-xauusd-5m-20261120.txt')).read().split('\n')
    base = int(lines[0].split('=')[1]); rows = lines[3].strip().split(';'); out = {}
    for r in rows:
        v = [int(x, 36) for x in r.split(',')]
        t = T0 + v[0] * 60000
        if t < T1: out[t // 300000] = dict(o=(v[1] + base) / 1000, h=(v[2] + base) / 1000, l=(v[3] + base) / 1000, c=(v[4] + base) / 1000, v=v[5])
    return out
def candles_comex():
    j = json.load(open(os.path.join(D, 'dl', 'comex.json')))['chart']['result'][0]; q = j['indicators']['quote'][0]; out = {}
    for i, t in enumerate(j['timestamp']):
        if q['close'][i] is None or not (T0 <= t * 1000 < T1): continue
        out[t * 1000 // 60000] = dict(o=q['open'][i], h=q['high'][i], l=q['low'][i], c=q['close'][i], v=q['volume'][i] or 0)
    return out

bn, by, du, tv, cx = trades_binance(), trades_bybit(), ticks_duka(), candles_tv(), candles_comex()
print(f'loaded: Binance {len(bn):,} trades, Bybit {len(by):,} trades, Dukascopy {len(du):,} spot ticks, TradingView OANDA {len(tv)} x 5m, COMEX {len(cx)} x 1m')

def bars(tr, tf):                                  # trades -> candles with delta and volume-at-price ($0.10 rows)
    out = {}
    for t, p, q, s in tr:
        k = t // tf; c = out.get(k)
        if c is None: c = out[k] = dict(o=p, h=p, l=p, c=p, v=0.0, d=0.0, n=0, vp={})
        c['h'] = max(c['h'], p); c['l'] = min(c['l'], p); c['c'] = p; c['v'] += q; c['d'] += s * q; c['n'] += 1
        r = math.floor(p * 10 + 1e-9); c['vp'][r] = c['vp'].get(r, 0) + q
    return out
def tickbars(ticks, tf):
    out = {}
    for t, m, sp in ticks:
        k = t // tf; c = out.get(k)
        if c is None: c = out[k] = dict(o=m, h=m, l=m, c=m, n=0, vp={})
        c['h'] = max(c['h'], m); c['l'] = min(c['l'], m); c['c'] = m; c['n'] += 1
        r = math.floor(m * 10 + 1e-9); c['vp'][r] = c['vp'].get(r, 0) + 1
    return out
def agg(src, tf_from, tf_to):                      # 1m candles -> bigger
    out = {}
    for k in sorted(src):
        c = src[k]; K = k * tf_from // tf_to; o = out.get(K)
        if o is None: out[K] = dict(c); continue
        o['h'] = max(o['h'], c['h']); o['l'] = min(o['l'], c['l']); o['c'] = c['c']; o['v'] = o.get('v', 0) + c.get('v', 0)
    return out

M, M5, M60 = 60000, 300000, 3600000
B1, B5, B60 = bars(bn, M), bars(bn, M5), bars(bn, M60)
Y1, Y5, Y60 = bars(by, M), bars(by, M5), bars(by, M60)
D1, D5, D60 = tickbars(du, M), tickbars(du, M5), tickbars(du, M60)
C5, C60 = agg(cx, M, M5), agg(cx, M, M60)

print('\n== 1. Price: our candles vs real XAUUSD (Dukascopy spot, TradingView OANDA) and COMEX')
gap = [B1[k]['c'] - D1[k]['c'] for k in B1 if k in D1]
print(f'perp - spot gap over the day: median {st.median(gap):.2f}, 5-95% range {pct(gap, .05):.2f} .. {pct(gap, .95):.2f}  (this is the offset the app subtracts)')
# the app's method: offset = gap smoothed over ~20 s, rounded to $0.05. Approximate with the gap of the previous minute, rounded.
off_prev = {k: round((B1[k - 1]['c'] - D1[k - 1]['c']) / 0.05) * 0.05 for k in B1 if (k - 1) in B1 and (k - 1) in D1}
for name, ref, refk in [('TradingView OANDA 5m', tv, M5), ('Dukascopy spot 5m', D5, M5)]:
    err = {x: [] for x in 'ohlc'}; same_dir = 0; n = 0
    for k, c in B5.items():
        if k not in ref: continue
        k1 = k * 5 + 4                              # last minute of the candle: use the offset known just before it
        o = off_prev.get(k * 5) ; oc = off_prev.get(k1, o)
        if o is None or oc is None: continue
        r = ref[k]; n += 1
        err['o'].append(abs(c['o'] - o - r['o'])); err['h'].append(abs(c['h'] - o - r['h'])); err['l'].append(abs(c['l'] - o - r['l'])); err['c'].append(abs(c['c'] - oc - r['c']))
        same_dir += (c['c'] - c['o'] >= 0) == (r['c'] - r['o'] >= 0)
    print(f'{name}: {n} candles. typical difference (median): open ${st.median(err["o"]):.2f}, high ${st.median(err["h"]):.2f}, low ${st.median(err["l"]):.2f}, close ${st.median(err["c"]):.2f};'
          f' 90% within close ${pct(err["c"], .9):.2f}; same candle colour {same_dir / n:.0%}')
for name, a, b, tf in [('Binance vs TradingView OANDA', B5, tv, '5m'), ('Binance vs Dukascopy spot', B1, D1, '1m'), ('Binance vs COMEX futures', B1, cx, '1m'), ('Binance vs COMEX futures', B5, C5, '5m'), ('TradingView OANDA vs COMEX', tv, C5, '5m')]:
    ks = sorted(k for k in a if k in b and (k - 1) in a and (k - 1) in b)
    print(f'{name} ({tf}): correlation of candle-to-candle moves {corr([a[k]["c"] - a[k - 1]["c"] for k in ks], [b[k]["c"] - b[k - 1]["c"] for k in ks]):.3f} over {len(ks)} candles')

print('\n== 2. Volume: is Binance busy when the world is busy?')
for name, a, b in [('Binance vs COMEX', B5, C5), ('Binance vs Bybit', B5, Y5), ('Binance vs OANDA tick count', B5, tv)]:
    ks = [k for k in a if k in b and a[k]['v'] > 0 and b[k]['v'] > 0]
    print(f'{name} (5m volume, log scale): correlation {corr([math.log(a[k]["v"]) for k in ks], [math.log(b[k]["v"]) for k in ks]):.3f}  ({len(ks)} candles)')
tot_b, tot_c = sum(c['v'] for c in B1.values()), sum(c['v'] for c in cx.values())
print(f'size: Binance {tot_b:,.0f} oz vs COMEX {tot_c:,.0f} contracts (x100 oz = {tot_c * 100:,.0f} oz): Binance = {tot_b / (tot_c * 100):.1%} of COMEX ounces')

print('\n== 3. Delta (who is aggressive): does Binance flow agree with other markets?')
for tfname, a, b in [('1m', B1, Y1), ('5m', B5, Y5), ('1h', B60, Y60)]:
    ks = [k for k in a if k in b]
    sg = sum((a[k]['d'] > 0) == (b[k]['d'] > 0) for k in ks) / len(ks)
    print(f'Binance delta vs Bybit delta ({tfname}): correlation {corr([a[k]["d"] for k in ks], [b[k]["d"] for k in ks]):.3f}, same sign {sg:.0%}  ({len(ks)} candles)')
for name, ref, tf in [('COMEX futures', cx, '1m'), ('Dukascopy spot', D1, '1m'), ('COMEX futures', C5, '5m'), ('TradingView OANDA', tv, '5m')]:
    src = B1 if tf == '1m' else B5
    ks = [k for k in src if k in ref]
    sg = sum((src[k]['d'] > 0) == (ref[k]['c'] - ref[k]['o'] > 0) for k in ks if ref[k]['c'] != ref[k]['o']) / max(1, sum(1 for k in ks if ref[k]['c'] != ref[k]['o']))
    print(f'Binance delta vs {name} candle move ({tf}): correlation {corr([src[k]["d"] for k in ks], [ref[k]["c"] - ref[k]["o"] for k in ks]):.3f}, delta sign = candle colour {sg:.0%}')

print('\n== 4. Footprint levels: do the busiest prices agree?')
def pocs(a, b, shift_rows=0):
    d = []
    for k in a:
        if k not in b or not a[k]['vp'] or not b[k]['vp']: continue
        pa = max(a[k]['vp'], key=a[k]['vp'].get); pb = max(b[k]['vp'], key=b[k]['vp'].get)
        d.append(abs(pa - shift_rows - pb) / 10)
    return d
d = pocs(B60, Y60); print(f'POC (most traded $0.10 row) Binance vs Bybit, per hour: median distance ${st.median(d):.2f}, within $0.50 in {sum(x <= .5 for x in d) / len(d):.0%} of hours')
sh = round(st.median(gap) * 10)
d = pocs(B60, D60, sh); print(f'POC Binance (shifted to spot) vs Dukascopy spot activity, per hour: median distance ${st.median(d):.2f}, within $0.50 in {sum(x <= .5 for x in d) / len(d):.0%} of hours')
pc = []
for k in B60:
    if k not in D60: continue
    rows = set(B60[k]['vp']) | set(r + sh for r in D60[k]['vp'])
    pc.append(corr([B60[k]['vp'].get(r, 0) for r in rows], [D60[k]['vp'].get(r - sh, 0) for r in rows]))
print(f'volume-at-price shape, Binance vs spot activity, per hour: median correlation {st.median(pc):.2f}')

print('\n== 4b. Footprint levels, done fairly (same price basis, shape of the whole profile)')
gb = [B1[k]['c'] - Y1[k]['c'] for k in B1 if k in Y1]
print(f'Binance - Bybit price gap: median {st.median(gb):.2f}, 5-95% {pct(gb, .05):.2f} .. {pct(gb, .95):.2f}')
shb = round(st.median(gb) * 10)
rng = []; d = []; pcs = []
for k in B60:
    if k not in Y60: continue
    a, b = B60[k]['vp'], Y60[k]['vp']
    pa = max(a, key=a.get); pb = max(b, key=b.get) + shb
    d.append(abs(pa - pb) / 10); rng.append((B60[k]['h'] - B60[k]['l']))
    rows = set(a) | set(r + shb for r in b)
    pcs.append(corr([a.get(r, 0) for r in rows], [b.get(r - shb, 0) for r in rows]))
print(f'per hour: hourly range median ${st.median(rng):.2f}; POC distance median ${st.median(d):.2f} = {st.median([x / r for x, r in zip(d, rng)]):.0%} of the range;'
      f' profile shape correlation median {st.median(pcs):.2f}')
# coarser rows, as used on 1h/4h footprints
for row in (0.5, 1.0):
    pcs = []
    for k in B60:
        if k not in Y60: continue
        f = lambda vp, s: {}
        A = {}; Bq = {}
        for r, v in B60[k]['vp'].items(): A[math.floor(r / (row * 10))] = A.get(math.floor(r / (row * 10)), 0) + v
        for r, v in Y60[k]['vp'].items(): rr = math.floor((r + shb) / (row * 10)); Bq[rr] = Bq.get(rr, 0) + v
        rows = set(A) | set(Bq); pcs.append(corr([A.get(r, 0) for r in rows], [Bq.get(r, 0) for r in rows]))
    print(f'  with ${row:.2f} rows: Binance vs Bybit hourly profile shape correlation median {st.median(pcs):.2f}')
