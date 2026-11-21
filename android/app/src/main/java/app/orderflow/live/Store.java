package app.orderflow.live;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Files on the phone, same format as the laptop recorder (recorder.mjs), one file per UTC hour:
 *   heat-YYYYMMDDHH.bin    664-byte records: double t, int lo, int bestBid, int bestAsk, int last, 320 x uint16 sizes (log scale)
 *   trades-YYYYMMDDHH.bin  40-byte records: double t, double price, double size, double side (+1 buy / -1 sell), double id
 * All little-endian. Prices are exchange ticks; the web app converts to spot itself.
 */
final class Store {
    static final int BINS = 320, HEAT_REC = 24 + 2 * BINS, TRADE_REC = 40;
    static final Pattern FILE = Pattern.compile("^(heat|trades)-(\\d{10})\\.bin$");

    static String hour(String kind, long t) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMddHH", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return kind + "-" + f.format(new Date(t)) + ".bin";
    }

    static long fileHour(String digits) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyyMMddHH", Locale.US);
            f.setTimeZone(TimeZone.getTimeZone("UTC"));
            return f.parse(digits).getTime();
        } catch (Exception e) { return 0; }
    }

    static synchronized void append(File f, byte[] b) throws IOException {
        try (FileOutputStream o = new FileOutputStream(f, true)) { o.write(b); }
    }

    /** rows: {t, price, size, side, id}; written into the hour file of each row's time */
    static void appendTrades(File dir, List<double[]> rows) throws IOException {
        Map<String, ByteArrayOutputStream> byFile = new LinkedHashMap<>();
        ByteBuffer b = ByteBuffer.allocate(TRADE_REC).order(ByteOrder.LITTLE_ENDIAN);
        for (double[] r : rows) {
            String f = hour("trades", (long) r[0]);
            ByteArrayOutputStream o = byFile.get(f);
            if (o == null) { o = new ByteArrayOutputStream(); byFile.put(f, o); }
            b.clear();
            for (int i = 0; i < 5; i++) b.putDouble(r[i]);
            o.write(b.array(), 0, TRADE_REC);
        }
        for (Map.Entry<String, ByteArrayOutputStream> e : byFile.entrySet()) append(new File(dir, e.getKey()), e.getValue().toByteArray());
    }

    /** largest trade id on disk (newest hour file), or -1 */
    static long lastTradeId(File dir) {
        File[] fs = dir.listFiles((d, n) -> n.startsWith("trades-") && n.endsWith(".bin"));
        if (fs == null || fs.length == 0) return -1;
        Arrays.sort(fs);
        long best = -1;
        for (int k = fs.length - 1; k >= 0 && best < 0; k--) {
            try {
                byte[] all = Files.readAllBytes(fs[k].toPath());
                ByteBuffer b = ByteBuffer.wrap(all).order(ByteOrder.LITTLE_ENDIAN);
                for (int o = 0; o + TRADE_REC <= all.length; o += TRADE_REC) best = Math.max(best, (long) b.getDouble(o + 32));
            } catch (IOException ignored) { }
        }
        return best;
    }

    static void cleanup(File dir, long keepMs) {
        File[] fs = dir.listFiles(); if (fs == null) return;
        long cut = System.currentTimeMillis() - keepMs;
        for (File f : fs) {
            Matcher m = FILE.matcher(f.getName());
            if (m.matches() && fileHour(m.group(2)) + 3600_000L < cut) f.delete();
        }
    }

    static List<File> filesFor(File dir, String kind, long from, long to) {
        List<File> out = new ArrayList<>();
        File[] fs = dir.listFiles(); if (fs == null) return out;
        Arrays.sort(fs);
        for (File f : fs) {
            Matcher m = FILE.matcher(f.getName());
            if (!m.matches() || !m.group(1).equals(kind)) continue;
            long h = fileHour(m.group(2));
            if (h + 3600_000L > from && h <= to) out.add(f);
        }
        return out;
    }

    /** trades with from <= t <= to, as 5-number rows (any order; the app sorts) */
    static byte[] trades(File dir, long from, long to) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (File f : filesFor(dir, "trades", from, to)) {
            byte[] all = Files.readAllBytes(f.toPath());
            ByteBuffer b = ByteBuffer.wrap(all).order(ByteOrder.LITTLE_ENDIAN);
            for (int o = 0; o + TRADE_REC <= all.length; o += TRADE_REC) {
                double t = b.getDouble(o);
                if (t >= from && t <= to) out.write(all, o, TRADE_REC);
            }
        }
        return out.toByteArray();
    }

    /** book history squeezed into at most n columns; per row the largest size in each time slot (same as recorder.mjs) */
    static byte[] heat(File dir, long from, long to, int n) throws IOException {
        n = Math.max(1, Math.min(4000, n));
        double slot = Math.max(1000.0, (to - from) / (double) n);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ByteBuffer w = ByteBuffer.allocate(HEAT_REC).order(ByteOrder.LITTLE_ENDIAN);
        long curSlot = -1; int[] q = new int[BINS]; double ct = 0; int clo = 0, cbb = 0, cba = 0, clast = -1; boolean have = false;
        for (File f : filesFor(dir, "heat", from, to)) {
            byte[] all = Files.readAllBytes(f.toPath());
            ByteBuffer b = ByteBuffer.wrap(all).order(ByteOrder.LITTLE_ENDIAN);
            for (int o = 0; o + HEAT_REC <= all.length; o += HEAT_REC) {
                double t = b.getDouble(o);
                if (t < from || t > to) continue;
                long s = (long) Math.floor((t - from) / slot);
                int lo = b.getInt(o + 8);
                if (s != curSlot) {
                    if (have) writeCol(out, w, ct, clo, cbb, cba, clast, q);
                    curSlot = s; have = true; clo = lo; Arrays.fill(q, 0);
                }
                int d = lo - clo;
                for (int i = 0; i < BINS; i++) {
                    int k = i + d; if (k < 0 || k >= BINS) continue;
                    int v = b.getShort(o + 24 + 2 * i) & 0xffff;
                    if (v > q[k]) q[k] = v;
                }
                ct = t; cbb = b.getInt(o + 12); cba = b.getInt(o + 16); clast = b.getInt(o + 20);
            }
        }
        if (have) writeCol(out, w, ct, clo, cbb, cba, clast, q);
        return out.toByteArray();
    }

    private static void writeCol(ByteArrayOutputStream out, ByteBuffer w, double t, int lo, int bb, int ba, int last, int[] q) {
        w.clear(); w.putDouble(t); w.putInt(lo); w.putInt(bb); w.putInt(ba); w.putInt(last);
        for (int i = 0; i < BINS; i++) w.putShort((short) q[i]);
        out.write(w.array(), 0, HEAT_REC);
    }

    static void touch(RandomAccessFile f) { }
}
