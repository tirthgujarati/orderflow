# Does the footprint match the global gold market? (checked 22 Nov 2026)

Day tested: Friday 20 Nov 2026, 00:00-21:00 UTC (all gold markets open). Script: `test/compare_global.py`,
full output: `test/compare_global-20261120.txt`.

| source | what it is | what it gives |
|---|---|---|
| Binance XAUUSDT perp (our footprint) | 1,135,007 trades | price, size, aggressor side |
| Bybit XAUUSDT perp | 297,257 trades | price, size, aggressor side |
| Dukascopy XAUUSD | 814,240 spot ticks (Swiss bank) | spot bid/ask, no volume |
| TradingView OANDA:XAUUSD | 252 five-minute candles | the chart you compare against |
| COMEX gold futures GC (Yahoo) | 1,259 one-minute candles | the main global gold exchange: price, volume |

## 1. Prices: excellent match
- Perp minus spot gap that day: median $5.96 (5-95%: $5.35-$7.24). The app subtracts this live, rounded to $0.05.
- Our 5m candles in XAUUSD vs TradingView OANDA: median difference open $0.08, high $0.17, low $0.20, close $0.15;
  90% of closes within $0.39; same candle colour 99%.
- vs Dukascopy spot: close $0.12, same colour 98%.
- Candle-to-candle moves: correlation 0.998 with OANDA (5m), 0.996 with spot (1m), 0.993 / 0.998 with COMEX (1m / 5m).

## 2. Activity (volume): good match in timing, small in size
- 5m volume (log): Binance vs COMEX 0.81, vs Bybit 0.78, vs OANDA tick count 0.70: Binance is busy when the world is busy.
- Size: Binance traded 1.46 M oz, COMEX 30.7 M oz: Binance is about 4.8% of COMEX by ounces.

## 3. Delta (aggressive buying minus selling): partly global
- Binance delta vs the global price move in the same candle: correlation 0.50 (1m) / 0.56 (5m); the delta sign equals the
  colour of the COMEX / OANDA / spot candle 71% of the time.
- Binance vs Bybit delta: correlation 0.37 (1m), 0.44 (5m), 0.50 (1h); same sign about 61%.
So Binance delta reflects real global pressure most of the time, but each venue also has its own local flow.

## 4. Footprint price levels: broad shape agrees, exact rows are venue-specific
- That day was volatile: median hourly range $28.
- Busiest $0.10 row (POC) Binance vs Bybit: median $5.60 apart (18% of the hourly range).
- Hourly volume-at-price shape Binance vs Bybit: correlation 0.24 with $0.10 rows, 0.55 with $0.50 rows, 0.66 with $1 rows;
  Binance vs spot activity 0.60.
Meaning: the exact single busiest $0.10 level is local to each exchange; zones of $0.50-$1 agree. For 1h and 4h footprints
use $0.50-$1 rows (or more) and read zones, not single ticks.

## Bottom line
The footprint candles reproduce the real XAUUSD candles (TradingView OANDA, spot, COMEX) almost exactly in price and
timing. The order flow inside them (delta, volume at price) comes from crypto gold venues worth about 5% of COMEX: it
agrees with the global direction about 70% of the time and in broad zones, not tick by tick. The only true global order flow
(COMEX with aggressor side) is paid CME data.

## 5. Candle times and prices against TradingView (added 22 Nov 2026)
- TradingView's own charts were read on 22 Nov: OANDA:XAUUSD/XAGUSD use session 17:00-17:00 New York, so 4h candles start
  at 17, 21, 01, 05, 09, 13 New York time (02, 06, 10, 14, 18, 22 UTC in winter); FOREX.com, Pepperstone, Capital.com, FX and
  TVC:GOLD use 18:00, one hour later; Binance uses 00:00 UTC. 1m-1h candles are the same everywhere. The app has a
  "4h like" setting for these three; `test/checkbig.mjs` checks the clock (including US daylight saving).
- Each trade is now converted to XAUUSD with the perp-minus-spot gap of its own minute (Dukascopy spot minute candles for the
  past, the live Swissquote quote from when the page is open). Before this, past candles used today's gap and could be
  several dollars off.
- `test/check4h-files.mjs`, Friday 20 Nov, five OANDA 4h candles: volume, delta, trade count and footprint totals identical to
  the raw Binance file; prices vs TradingView OANDA: close within $0.27-$0.67, high $0.03-$0.99, low $0.09-$0.35
  (OANDA and Dukascopy are different spot feeds, and rows are $0.05).
