package app.orderflow.live;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import java.io.File;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;

/**
 * Keeps recording with the screen off: a foreground service (shows a notification), a partial wake lock (CPU stays on),
 * and one BinanceRecorder per market. Data goes to the app's own storage on the phone (files/rec/...).
 */
public class RecorderService extends Service {
    private static final String CH = "recording";
    private static final Map<String, BinanceRecorder> recs = new ConcurrentHashMap<>();
    private static OkHttpClient client;
    private static File root;
    private PowerManager.WakeLock wake;

    // markets recorded on the phone: exchange market -> {symbol, tick, heatmap row}
    private static final Object[][] MARKETS = {
            {"binance:XAUUSDT", "XAUUSDT", 0.01, 0.05},
            {"binance:XAGUSDT", "XAGUSDT", 0.01, 0.01},
    };

    static synchronized OkHttpClient http() {
        if (client == null) client = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build();
        return client;
    }

    static Map<String, BinanceRecorder> recorders() { return recs; }

    /** the web app asks with its market key; spot markets use the Binance flow (spot:XAUUSD -> binance:XAUUSDT) */
    static BinanceRecorder recorderFor(String key) {
        if (key == null) return null;
        if (key.startsWith("spot:")) key = "binance:" + key.substring(5).replace("USD", "") + "USDT";
        return recs.get(key);
    }

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel ch = new NotificationChannel(CH, "Recording", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while Order Flow records the market in the background");
        nm.createNotificationChannel(ch);
        root = new File(getFilesDir(), "rec");
        root.mkdirs();
        LocalServer.ensure(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "stop".equals(intent.getAction())) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY; }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, RecorderService.class).setAction("stop"), PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH)
                .setContentTitle("Order Flow is recording")
                .setContentText("Gold and silver order book and trades, saved on this phone")
                .setSmallIcon(R.drawable.ic_stat)
                .setOngoing(true)
                .setContentIntent(open)
                .addAction(new Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), "Stop recording", stop).build())
                .build();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, n);
        if (wake == null) {
            wake = ((PowerManager) getSystemService(POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OrderFlow:recorder");
            wake.setReferenceCounted(false);
            wake.acquire();
        }
        for (Object[] m : MARKETS) {
            String key = (String) m[0];
            if (!recs.containsKey(key)) {
                BinanceRecorder r = new BinanceRecorder(key, (String) m[1], (Double) m[2], (Double) m[3], root, http());
                recs.put(key, r); r.start();
            }
        }
        return START_STICKY;
    }

    @Override public void onDestroy() {
        for (BinanceRecorder r : recs.values()) r.stop();
        recs.clear();
        if (wake != null && wake.isHeld()) wake.release();
        wake = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
