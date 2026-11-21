package app.orderflow.live;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** Live spot XAU/USD, XAG/USD from Swissquote's public quote feed ("prime" profile mid), cached for 500 ms. */
final class Spot {
    private static final Map<String, Object[]> cache = new HashMap<>();   // inst -> {time fetched, json}

    static boolean allowed(String inst) { return "XAU/USD".equals(inst) || "XAG/USD".equals(inst); }

    static synchronized String get(OkHttpClient http, String inst) throws Exception {
        Object[] c = cache.get(inst);
        if (c != null && System.currentTimeMillis() - (Long) c[0] < 500) return (String) c[1];
        String body;
        try (Response r = http.newCall(new Request.Builder().url("https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/" + inst).build()).execute()) {
            if (!r.isSuccessful() || r.body() == null) throw new Exception("HTTP " + r.code());
            body = r.body().string();
        }
        JSONArray a = new JSONArray(body);
        double bid = 0, ask = 0, ts = -1;
        for (int i = 0; i < a.length(); i++) {
            JSONObject pl = a.getJSONObject(i);
            JSONArray sp = pl.optJSONArray("spreadProfilePrices"); if (sp == null) continue;
            for (int k = 0; k < sp.length(); k++) {
                JSONObject p = sp.getJSONObject(k);
                if ("prime".equals(p.optString("spreadProfile")) && pl.optDouble("ts", 0) > ts) { ts = pl.optDouble("ts", 0); bid = p.getDouble("bid"); ask = p.getDouble("ask"); }
            }
        }
        if (ts < 0) throw new Exception("no quote");
        String json = new JSONObject().put("bid", bid).put("ask", ask).put("ts", (long) ts).toString();
        cache.put(inst, new Object[]{System.currentTimeMillis(), json});
        return json;
    }
}
