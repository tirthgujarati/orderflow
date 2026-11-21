package app.orderflow.live;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Records one Binance USD-M futures market on the phone, all the time:
 *  - order book: diff stream + REST snapshot, synced by update ids (first event U <= lastUpdateId <= u, then pu == previous u);
 *    one 320-row column (rows of binTicks ticks around the mid) written every second
 *  - trades: aggTrade stream; aggTrade ids are consecutive, so any jump (network drop, phone asleep, app killed) is fetched back
 * Same rules as feeds.js / recorder.mjs in the web app.
 */
final class BinanceRecorder {
    private static final String TAG = "OrderFlowRec";
    private static final String REST = "https://fapi.binance.com/fapi/v1";
    static final int BINS = Store.BINS;

    final String key, sym; final double tick; final int binTicks; final File dir;
    private final OkHttpClient http;
    private final Object lock = new Object();
    private final TreeMap<Long, Double> bids = new TreeMap<>(), asks = new TreeMap<>();
    private final ArrayDeque<JSONObject> buffer = new ArrayDeque<>();
    private final List<double[]> tradeBuf = new ArrayList<>();
    private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor();
    private final ExecutorService rest = Executors.newSingleThreadExecutor();
    private final ExecutorService gapper = Executors.newSingleThreadExecutor();
    private WebSocket wsBook, wsTrades;
    private volatile boolean closed;
    private int state = 0;                 // 0 waiting for snapshot, 1 first event after snapshot, 2 live
    private long L, lastU, lastAggId, lastTradeTick = -1, lastE, lastERecv;
    private int retryB, retryT, secs;
    volatile String status = "starting";
    volatile long gaps, filled;

    BinanceRecorder(String key, String sym, double tick, double bin, File root, OkHttpClient http) {
        this.key = key; this.sym = sym; this.tick = tick; this.http = http;
        this.binTicks = (int) Math.max(1, Math.round(bin / tick));
        this.dir = new File(root, key.replaceAll("[^A-Za-z0-9]+", "_"));
        dir.mkdirs();
        lastAggId = Store.lastTradeId(dir);
    }

    void start() {
        Store.cleanup(dir, 7L * 86400_000L);
        openBook(); openTrades();
        timer.scheduleAtFixedRate(this::everySecond, 1, 1, TimeUnit.SECONDS);
    }

    void stop() {
        closed = true;
        if (wsBook != null) wsBook.cancel();
        if (wsTrades != null) wsTrades.cancel();
        timer.shutdownNow(); rest.shutdownNow(); gapper.shutdownNow();
    }

    private static long backoff(int n) { return Math.min(30000L, 1500L << Math.min(n, 5)); }

    private String get(String url) throws Exception {
        for (int i = 0; ; i++) {
            try (Response r = http.newCall(new Request.Builder().url(url).build()).execute()) {
                if ((r.code() == 429 || r.code() == 418) && i < 4) {
                    String ra = r.header("Retry-After");
                    Thread.sleep(1000L * (ra != null ? Long.parseLong(ra) : 30));
                    continue;
                }
                if (!r.isSuccessful() || r.body() == null) throw new Exception("HTTP " + r.code());
                return r.body().string();
            }
        }
    }

    // ------------------------------------------------------------------ order book
    private void openBook() {
        if (closed) return;
        Request r = new Request.Builder().url("wss://fstream.binance.com/public/stream?streams=" + sym.toLowerCase() + "@depth@100ms").build();
        wsBook = http.newWebSocket(r, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response resp) { retryB = 0; rest.execute(BinanceRecorder.this::resync); }
            @Override public void onMessage(WebSocket ws, String text) {
                try {
                    JSONObject d = new JSONObject(text).optJSONObject("data");
                    if (d == null || !"depthUpdate".equals(d.optString("e"))) return;
                    synchronized (lock) {
                        lastE = d.getLong("E"); lastERecv = System.currentTimeMillis();
                        if (state == 0) { buffer.add(d); if (buffer.size() > 3000) buffer.poll(); return; }
                        apply(d);
                    }
                } catch (JSONException ignored) { }
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) { if (ws == wsBook) reconnectBook(); }
            @Override public void onFailure(WebSocket ws, Throwable t, Response resp) { if (ws == wsBook) reconnectBook(); }
        });
    }

    private void reconnectBook() {
        synchronized (lock) { state = 0; buffer.clear(); }
        if (closed) return;
        status = "reconnecting";
        timer.schedule(this::openBook, backoff(retryB++), TimeUnit.MILLISECONDS);
    }

    /** holding lock */
    private void apply(JSONObject d) throws JSONException {
        long U = d.getLong("U"), u = d.getLong("u"), pu = d.getLong("pu");
        if (state == 1) {
            if (u < L) return;
            if (U > L) { needResync(); return; }
            state = 2;
        } else if (pu != lastU) { gaps++; needResync(); return; }
        lastU = u;
        levels(bids, d.getJSONArray("b"));
        levels(asks, d.getJSONArray("a"));
    }

    private void levels(TreeMap<Long, Double> m, JSONArray a) throws JSONException {
        for (int i = 0; i < a.length(); i++) {
            JSONArray x = a.getJSONArray(i);
            long k = Math.round(Double.parseDouble(x.getString(0)) / tick);
            double q = Double.parseDouble(x.getString(1));
            if (q > 0) m.put(k, q); else m.remove(k);
        }
    }

    /** holding lock */
    private void needResync() { state = 0; buffer.clear(); rest.execute(this::resync); }

    private void resync() {
        if (closed) return;
        synchronized (lock) { state = 0; }
        try {
            JSONObject j = new JSONObject(get(REST + "/depth?symbol=" + sym + "&limit=1000"));
            synchronized (lock) {
                bids.clear(); asks.clear();
                levels(bids, j.getJSONArray("bids")); levels(asks, j.getJSONArray("asks"));
                L = j.getLong("lastUpdateId"); state = 1;
                List<JSONObject> pend = new ArrayList<>(buffer); buffer.clear();
                for (JSONObject d : pend) { if (state == 0) break; apply(d); }
            }
            status = "recording";
        } catch (Exception e) {
            status = "book: " + e.getMessage();
            if (!closed) timer.schedule(() -> rest.execute(this::resync), 3, TimeUnit.SECONDS);
        }
    }

    // ------------------------------------------------------------------ trades
    private void openTrades() {
        if (closed) return;
        Request r = new Request.Builder().url("wss://fstream.binance.com/market/stream?streams=" + sym.toLowerCase() + "@aggTrade").build();
        wsTrades = http.newWebSocket(r, new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response resp) { retryT = 0; }
            @Override public void onMessage(WebSocket ws, String text) {
                try {
                    JSONObject d = new JSONObject(text).optJSONObject("data");
                    if (d == null || !"aggTrade".equals(d.optString("e"))) return;
                    long a = d.getLong("a");
                    double p = Double.parseDouble(d.getString("p")), q = Double.parseDouble(d.getString("q"));
                    synchronized (lock) {
                        tradeBuf.add(new double[]{d.getLong("T"), p, q, d.getBoolean("m") ? -1 : 1, a});
                        lastTradeTick = Math.round(p / tick);
                        if (lastAggId >= 0 && a > lastAggId + 1) { final long from = lastAggId + 1, to = a - 1; gapper.execute(() -> fillGap(from, to)); }
                        if (a > lastAggId) lastAggId = a;
                    }
                } catch (JSONException ignored) { }
            }
            @Override public void onClosed(WebSocket ws, int code, String reason) { if (ws == wsTrades) reconnectTrades(); }
            @Override public void onFailure(WebSocket ws, Throwable t, Response resp) { if (ws == wsTrades) reconnectTrades(); }
        });
    }

    private void reconnectTrades() {
        if (closed) return;
        timer.schedule(this::openTrades, backoff(retryT++), TimeUnit.MILLISECONDS);
    }

    /** fetch trades with ids from..to (missed while disconnected), at most ~1 million, paced for Binance's request limit */
    private void fillGap(long from, long to) {
        if (to - from > 1_000_000) from = to - 1_000_000;
        int pages = 0;
        try {
            while (from <= to && !closed) {
                int n = (int) Math.min(1000, to - from + 1);
                JSONArray arr = new JSONArray(get(REST + "/aggTrades?symbol=" + sym + "&fromId=" + from + "&limit=" + n));
                if (arr.length() == 0) break;
                List<double[]> rows = new ArrayList<>();
                long last = from;
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject d = arr.getJSONObject(i);
                    long a = d.getLong("a"); if (a > to) break;
                    rows.add(new double[]{d.getLong("T"), Double.parseDouble(d.getString("p")), Double.parseDouble(d.getString("q")), d.getBoolean("m") ? -1 : 1, a});
                    last = a;
                }
                Store.appendTrades(dir, rows);
                filled += rows.size();
                from = last + 1;
                if (++pages >= 10) Thread.sleep(1200);
            }
        } catch (Exception e) { Log.w(TAG, "gap fill " + key + ": " + e.getMessage()); }
    }

    // ------------------------------------------------------------------ once a second: save trades, write one book column
    private void everySecond() {
        try {
            List<double[]> tb;
            synchronized (lock) { tb = new ArrayList<>(tradeBuf); tradeBuf.clear(); }
            if (!tb.isEmpty()) Store.appendTrades(dir, tb);

            byte[] rec = null; long t = 0;
            synchronized (lock) {
                if (state == 2 && !bids.isEmpty() && !asks.isEmpty()) {
                    long bb = bids.lastKey(), ba = asks.firstKey();
                    if (bb < ba) {
                        long midBin = Math.floorDiv(bb + ba, 2L * binTicks), lo = midBin - BINS / 2;
                        double[] v = new double[BINS];
                        for (Map.Entry<Long, Double> e : bids.subMap(lo * binTicks, true, (lo + BINS) * binTicks, false).entrySet())
                            v[(int) (Math.floorDiv(e.getKey(), (long) binTicks) - lo)] += e.getValue();
                        for (Map.Entry<Long, Double> e : asks.subMap(lo * binTicks, true, (lo + BINS) * binTicks, false).entrySet())
                            v[(int) (Math.floorDiv(e.getKey(), (long) binTicks) - lo)] += e.getValue();
                        t = lastE + (System.currentTimeMillis() - lastERecv);      // exchange clock
                        ByteBuffer b = ByteBuffer.allocate(Store.HEAT_REC).order(ByteOrder.LITTLE_ENDIAN);
                        b.putDouble(t); b.putInt((int) lo); b.putInt((int) bb); b.putInt((int) ba); b.putInt((int) lastTradeTick);
                        for (int i = 0; i < BINS; i++) {
                            long q = Math.min(65535, Math.round(1024 * Math.log(1 + v[i]) / Math.log(2)));
                            b.putShort((short) q);
                        }
                        rec = b.array();
                    }
                }
                if (++secs % 10 == 0 && state == 2 && !bids.isEmpty() && !asks.isEmpty()) {      // forget levels far from the price
                    long mid = (bids.lastKey() + asks.firstKey()) / 2, keep = Math.max(2000, mid * 3 / 100);
                    bids.headMap(mid - keep).clear(); asks.tailMap(mid + keep).clear();
                }
            }
            if (rec != null) Store.append(new File(dir, Store.hour("heat", t)), rec);
            if (secs % 3600 == 0) Store.cleanup(dir, 7L * 86400_000L);
        } catch (Exception e) { Log.w(TAG, "tick " + key + ": " + e.getMessage()); }
    }
}
