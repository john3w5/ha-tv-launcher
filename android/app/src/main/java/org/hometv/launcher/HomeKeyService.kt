package org.hometv.launcher

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent

/**
 * Sony opens Google TV on the Home key whatever app holds the HOME role. A start
 * sent at the same moment can lose to it before the launcher even resumes, so
 * this waits until Google TV has finished coming up. The key is only observed.
 */
class HomeKeyService : AccessibilityService() {
    private val ui = Handler(Looper.getMainLooper())
    private val open = Runnable { TvAutostart.launch(this) }

    override fun onKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_HOME && event.action == KeyEvent.ACTION_UP) {
            ui.removeCallbacks(open); ui.postDelayed(open, HOME_DELAY_MS)
        }
        return false
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit
    override fun onDestroy() { ui.removeCallbacks(open); super.onDestroy() }

    private companion object { const val HOME_DELAY_MS = 700L }
}
