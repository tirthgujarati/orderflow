package app.orderflow.live;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tiny web server inside the app, on 127.0.0.1:8090 (this phone only). It serves the web app (bundled in assets/web)
 * and the same endpoints as the laptop's serve.mjs: /spot, /rec/info, /rec/heat, /rec/trades.
 */
final class LocalServer extends Thread {
    static final int PORT = 8090;
    private static LocalServer instance;
    static volatile boolean ready;
    private final Context ctx;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    static synchronized void ensure(Context ctx) {
        if (instance == null) { instance = new LocalServer(ctx.getApplicationContext()); instance.start(); }
    }

    private LocalServer(Context ctx) { super("order-flow-http"); this.ctx = ctx; setDaemon(true); }

    @Override public void run() {
        try (ServerSocket ss = new ServerSocket(PORT, 50, InetAddress.getByName("127.0.0.1"))) {
            ready = true;
            while (true) { Socket s = ss.accept(); pool.execute(() -> handle(s)); }
        } catch (Exception e) { Log.e("OrderFlowHttp", "server stopped: " + e.getMessage()); ready = false; synchronized (LocalServer.class) { instance = null; } }
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); int c;
        while ((c = in.read()) != -1 && c != '\n') if (c != '\r') b.write(c);
        return b.toString("ISO-8859-1");
    }

    private void handle(Socket s) {
        try (Socket sock = s; InputStream in = sock.getInputStream(); OutputStream out = sock.getOutputStream()) {
            sock.setSoTimeout(15000);
            String first = readLine(in); if (first.isEmpty()) return;
            while (!readLine(in).isEmpty()) { }                       // skip headers
            String[] parts = first.split(" ");
            if (parts.length < 2 || !"GET".equals(parts[0])) { send(out, 405, "text/plain", "GET only".getBytes()); return; }
            String target = parts[1], path = target, query = "";
            int qi = target.indexOf('?'); if (qi >= 0) { path = target.substring(0, qi); query = target.substring(qi + 1); }
            Map<String, String> q = new HashMap<>();
            for (String kv : query.split("&")) { int e = kv.indexOf('='); if (e > 0) q.put(URLDecoder.decode(kv.substring(0, e), "UTF-8"), URLDecoder.decode(kv.substring(e + 1), "UTF-8")); }
            route(path, q, out);
        } catch (Exception e) { Log.w("OrderFlowHttp", "request: " + e.getMessage()); }
    }

    private void route(String path, Map<String, String> q, OutputStream out) throws Exception {
        if (path.equals("/spot")) {
            String inst = q.get("i");
            if (inst == null || !Spot.allowed(inst)) { send(out, 400, "text/plain", "unknown instrument".getBytes()); return; }
            try { send(out, 200, "application/json", Spot.get(RecorderService.http(), inst).getBytes(StandardCharsets.UTF_8)); }
            catch (Exception e) { send(out, 502, "application/json", new JSONObject().put("error", String.valueOf(e.getMessage())).toString().getBytes()); }
            return;
        }
        if (path.startsWith("/rec/")) {
            if (path.equals("/rec/info")) {
                JSONArray a = new JSONArray();
                for (BinanceRecorder r : RecorderService.recorders().values())
                    a.put(new JSONObject().put("key", r.key).put("status", r.status).put("gaps", r.gaps).put("filled", r.filled));
                send(out, 200, "application/json", a.toString().getBytes()); return;
            }
            BinanceRecorder r = RecorderService.recorderFor(q.get("key"));
            if (r == null) { send(out, 404, "text/plain", "not recorded on this phone".getBytes()); return; }
            long from = parseLong(q.get("from"), 0), to = parseLong(q.get("to"), System.currentTimeMillis());
            if (to <= 0) to = System.currentTimeMillis();
            if (path.equals("/rec/heat")) { send(out, 200, "application/octet-stream", Store.heat(r.dir, from, to, (int) parseLong(q.get("n"), 1000))); return; }
            if (path.equals("/rec/trades")) { send(out, 200, "application/octet-stream", Store.trades(r.dir, from, to)); return; }
            send(out, 404, "text/plain", "not found".getBytes()); return;
        }
        String file = path.equals("/") ? "index.html" : path.substring(1);
        if (file.contains("..")) { send(out, 404, "text/plain", "not found".getBytes()); return; }
        try (InputStream a = ctx.getAssets().open("web/" + file)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream(); byte[] buf = new byte[16384]; int n;
            while ((n = a.read(buf)) > 0) b.write(buf, 0, n);
            send(out, 200, type(file), b.toByteArray());
        } catch (Exception e) { send(out, 404, "text/plain", "not found".getBytes()); }
    }

    private static long parseLong(String s, long d) { try { return s == null ? d : (long) Double.parseDouble(s); } catch (Exception e) { return d; } }

    private static String type(String f) {
        if (f.endsWith(".html")) return "text/html; charset=utf-8";
        if (f.endsWith(".js") || f.endsWith(".mjs")) return "text/javascript; charset=utf-8";
        if (f.endsWith(".json")) return "application/json";
        if (f.endsWith(".svg")) return "image/svg+xml";
        if (f.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    private static void send(OutputStream out, int code, String type, byte[] body) throws Exception {
        String head = "HTTP/1.1 " + code + (code == 200 ? " OK" : " Error") + "\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                + "\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1)); out.write(body); out.flush();
    }
}
