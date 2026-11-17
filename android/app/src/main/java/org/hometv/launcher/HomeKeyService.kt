package org.hometv.launcher

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * Sony opens Google TV on the Home key whatever app holds the HOME role. A start
 * sent at the same moment can lose to it before the launcher even resumes, so
 * this waits until Google TV has finished coming up. The key is only observed.
 *
 * The system rebinds this service even after the process is force-stopped (a
 * WebView update does that), which drops the sticky overlay service. It
 * therefore also covers the wake-up start while that service is not running.
 */
class HomeKeyService : AccessibilityService() {
    private val ui = Handler(Looper.getMainLooper())
    private val open = Runnable { TvAutostart.launch(this) }
    private val screenOn = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_ON && !TvOverlayService.running) {
                ui.removeCallbacks(open); ui.postDelayed(open, TvAutostart.SCREEN_ON_DELAY_MS)
            }
        }
    }
    private var receiving = false

    override fun onServiceConnected() {
        super.onServiceConnected()
        if (!receiving) { registerReceiver(screenOn, IntentFilter(Intent.ACTION_SCREEN_ON)); receiving = true }
        TvOverlayService.startAfterUpdate(this)
    }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_HOME && event.action == KeyEvent.ACTION_UP) {
            ui.removeCallbacks(open); ui.postDelayed(open, HOME_DELAY_MS)
        }
        return false
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit
    override fun onDestroy() {
        ui.removeCallbacks(open)
        if (receiving) { runCatching { unregisterReceiver(screenOn) }; receiving = false }
        super.onDestroy()
    }

    private companion object { const val HOME_DELAY_MS = 700L }
}
