package app.orderflow.live;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Starts recording again after the phone restarts. */
public class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            try { ctx.startForegroundService(new Intent(ctx, RecorderService.class)); } catch (Exception ignored) { }
        }
    }
}
