# Order Flow: local live order-flow app (gold, silver, currencies)

Heatmap, footprint, DOM, time & sales, delta bars, CVD and volume profile, drawn from the exchanges' free public
data. Runs entirely on your laptop or phone: the browser connects straight to Binance, Bybit or Hyperliquid.
No account, no API key, no server of ours.

## Android app
Download: **https://github.com/tirthgujarati/orderflow/releases/download/app/OrderFlow.apk**

1. Open the link on the phone and download OrderFlow.apk. Android asks to allow installs from your browser: allow it
   for this install (Settings > Apps > your browser > Install unknown apps).
2. Open Order Flow. Allow notifications, and allow "run without battery restrictions" when asked: that is what lets
   it keep recording with the screen off.
3. A notification "Order Flow is recording" stays while it records gold and silver (book every second, every trade)
   into the phone's own storage (kept 7 days). "Stop recording" in the notification stops it; opening the app starts it.
   It starts again by itself after the phone restarts.

How it works: the app is the same web app as on the laptop, served by a tiny web server inside the app (127.0.0.1,
this phone only). A background service (foreground service + CPU wake lock) records Binance XAUUSDT / XAGUSDT the same
way as the laptop recorder; missed trades (no network, phone off) are fetched back by trade id. Spot XAUUSD comes from
Swissquote. Battery: expect it to use noticeably more battery while recording; a charger overnight is best.
Every push to `main` rebuilds the APK in GitHub Actions (`.github/workflows/android.yml`) and replaces the release file,
so the link above always gives the latest version. Updates install over the old app and keep its data.

## Start it (laptop)
```
node serve.mjs
```
Open http://localhost:8090. (Opening index.html directly from the folder does not work: browsers block the
background engine on file:// pages.)

## On the phone
- Same Wi-Fi as the laptop: run `node serve.mjs` and open the `http://192.168.x.x:8090` address it prints.
  Windows may ask whether Node may accept connections on the private network; allow it only for private networks.
- The phone shows one panel at a time (Heatmap, Footprint, DOM, Tape) from the bottom bar.
- Installing it as a real home-screen app (works offline, opens like an app) needs https; that comes when it is
  hosted somewhere (for example GitHub Pages). Not done yet.

## Always-on recorder (history while the phone or browser is closed)
`serve.mjs` also runs a recorder: the same engine as the app, in Node, for Binance gold and silver (and any market the
app opens). It writes one book snapshot per second and every trade to `data/rec/<market>/` (hour files, kept 7 days,
~55 MB of book per market per day). When the app opens it takes trades and book history from the recorder, so the heatmap,
footprint and CVD cover the time your screen was off. It only works while the laptop is awake: set Windows so the PC does
not sleep when plugged in (the screen may turn off). Holes are handled: Binance trade ids are consecutive, so any jump
(network drop, laptop asleep, recorder stopped) is fetched back from Binance automatically; the book for such a time
cannot be recovered and shows as "no book recorded here". Memory: about 60-120 MB.

## XAUUSD and XAGUSD (spot)
Spot gold trades between banks, so no exchange publishes an XAUUSD order book or trade tape. The app's XAUUSD
market therefore uses the deepest public gold flow (Binance XAUUSDT perpetual) and shows every price in spot terms:

    XAUUSD price = XAUUSDT price - offset,   offset = live (XAUUSDT mid - spot XAUUSD mid), smoothed ~20 s

- Spot mid comes from Swissquote's public live quote (a Swiss bank), fetched once a second by `serve.mjs`
  (`/spot`), because Swissquote does not let web pages read it directly. So XAUUSD needs `node serve.mjs` running.
- The offset is rounded to one heatmap row ($0.05) and only moves when the live gap moves more than $0.04, so shown
  prices are within about $0.03 of the spot mid. When it moves, every stored trade, level and candle moves together.
- When spot is shut (weekends from Friday 22:00 UTC, the daily break) the offset stays at the gap measured at the
  last spot quote; the header says "spot shut since ..." and the prices are an indication only.
- The header shows the live spot mid and the offset in use.

## Controls
- Market list: Binance (gold, silver, platinum), Bybit (gold, silver, EURUSD, GBPUSD, USDJPY), Hyperliquid
  (gold, silver, EUR, JPY). Markets marked "thin" have little real volume; read their order flow with care.
- Timeframe chips (15s, 1m, 5m, 15m) and bucket chips set the footprint candles and price rows.
- Heatmap: mouse wheel = time zoom, Shift+wheel or wheel over the price axis = price zoom, drag up/down = move
  price, drag sideways = look back, double-click or ⟲ = follow live. On a phone use − + ⟲.
- Footprint: wheel = wider/narrower candles, drag sideways = older candles, Shift+wheel = price zoom.

## What each number is
- Buy/sell = aggressive side (the trader who crossed the spread). Delta = buy volume - sell volume. CVD = running
  delta since the first loaded trade.
- Bubble, tape and "big" sizes are set from the data: 90th, 97th and 99th percentile of the last 5,000 trades.
- Imbalance: buy volume at a price at least 3x the sell volume one row lower (or sell 3x buy one row higher),
  shown as a solid green or red cell. POC (orange box) = most traded row. VA = 70% value area.
- impact λ (footer) = least-squares slope of the 10-second price change on 10-second delta.
- delay = exchange timestamp to arrival here, including any error in the laptop clock.

## History
- Candle sizes 15s, 1m, 5m, 15m, 1h, 4h. On Binance markets (and XAUUSD/XAGUSD) the last 500 candles come from Binance's
  own candles, whose taker-buy volume makes delta per candle exact; CVD runs across all of them.
- Footprint cells need individual trades. Binance trade history loads in the background, newest first:
  1 h for 15s/1m, 2 h for 5m, 4 h for 15m, 6 h for 1h, 12 h for 4h (progress in the footer; 12 h takes 1-3 minutes
  because Binance allows ~2 history requests a second). A candle that starts before the loaded trades shows its
  OHLC/delta from Binance's candle and is marked "cells from HH:MM"; older candles are drawn as plain candles.
- Bybit gives only the last 1,000 trades; Hyperliquid sends its recent trades. After that everything is live.
- Heatmap (resting orders): from the recorder (1 s resolution) while serve.mjs runs, plus 100 ms live detail for the
  last 10 minutes the page has been open. Colour scale: log scale between a lower cut (◐ contrast button: 30/50/70/85th
  percentile of what is in view) and the 99.5th percentile; thinner levels show as a faint trace, empty levels black.
- Bubbles: trades in the same $0.05 row and ~6 px time slot form one bubble at their volume-weighted price and time (so it
  sits on the price line), sized by volume, green/red slice = buy/sell share; shown from the 95th percentile of trade size.
  Price line = every trade as a step line. Thin green/red lines = best bid / best ask.

## Accuracy checks
```
node test/check.mjs offline <Binance XAUUSDT aggTrades csv from data.binance.vision>
node test/check.mjs live 75
node test/check4h.mjs
```
check4h loads 12 h of XAUUSD at 4h candles and compares every fully covered 4h candle with Binance's own 4h candle:
on 21 Nov 2026 both (00:00 and 04:00 UTC) matched exactly in volume, delta, high and low.
Offline: rebuilds a full day (19 Nov 2026, 690,151 trades) and compares every candle and footprint cell with an
independent integer-cents calculation: 1,440 candles and 13,947 cells identical. Live: runs the engine on Binance,
Bybit and Hyperliquid, then compares the order book with each exchange's REST book and a closed minute candle with
the exchange's own trade list: all equal on 21 Nov 2026.

## Files
index.html (layout, colours) · app.js (drawing, controls) · engine.js (background worker: book, candles) ·
core.js (maths, markets) · feeds.js (exchange connections) · sw.js + manifest.json (offline cache, install) ·
serve.mjs (local file server) · test/check.mjs (accuracy checks) · mockup.html (design mockup)
