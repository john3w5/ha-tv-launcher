package org.hometv.launcher

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.util.Log

/**
 * Brings the launcher to the front after the TV boots or wakes from standby.
 * Android allows this background start only for apps the user granted
 * "display over other apps"; without that permission nothing happens.
 */
object TvAutostart {
    // Lets the system home finish its own wake-up before the launcher replaces it.
    const val SCREEN_ON_DELAY_MS = 1500L

    fun launch(context: Context) {
        if (!Settings.canDrawOverlays(context)) return
        runCatching {
            context.startActivity(Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
        }.onFailure { Log.w("HomeTVAutostart", "launch_unavailable") }
    }
}

class TvBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) TvAutostart.launch(context)
    }
}
