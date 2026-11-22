package app.orderflow.live;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.file.Files;
import java.util.Calendar;
import java.util.TimeZone;

import okhttp3.Request;
import okhttp3.Response;

/**
 * Dukascopy spot history files (minute candles, one LZMA file per day per side), fetched for the web app because Dukascopy
 * does not let web pages read them. Cached in the app's storage: finished days are kept, today is refreshed after 10 minutes.
 * One request at a time, at least 1.5 s apart, with retries: Dukascopy blocks clients that ask too fast.
 */
final class Duka {
    private static long last;

    static boolean validPath(String p) { return p != null && p.matches("[A-Z]{6}/\\d{4}/\\d{2}/\\d{2}/(BID|ASK)_candles_min_1\\.bi5"); }

    static synchronized byte[] get(Context ctx, String p) throws Exception {
        File dir = new File(ctx.getFilesDir(), "duka"); dir.mkdirs();
        File f = new File(dir, p.replace('/', '_'));
        String[] parts = p.split("/");
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        c.clear(); c.set(Integer.parseInt(parts[1]), Integer.parseInt(parts[2]), Integer.parseInt(parts[3]));   // month is 0-based in both
        boolean done = c.getTimeInMillis() + 86400_000L + 3 * 3600_000L < System.currentTimeMillis();
        if (f.exists() && (done || System.currentTimeMillis() - f.lastModified() < 600_000L)) return Files.readAllBytes(f.toPath());
        for (int i = 0; i < 5; i++) {
            long wait = last + 3000 - System.currentTimeMillis(); if (wait > 0) Thread.sleep(wait);
            last = System.currentTimeMillis();
            try (Response r = RecorderService.http().newCall(new Request.Builder().url("https://datafeed.dukascopy.com/datafeed/" + p).header("User-Agent", "Mozilla/5.0").build()).execute()) {
                if (r.code() == 404) return null;
                if (r.isSuccessful() && r.body() != null) {
                    byte[] b = r.body().bytes();
                    try (FileOutputStream o = new FileOutputStream(f)) { o.write(b); }
                    return b;
                }
            } catch (Exception ignored) { }
            Thread.sleep(10000L << i);
        }
        if (f.exists()) return Files.readAllBytes(f.toPath());
        throw new Exception("Dukascopy not reachable");
    }
}
