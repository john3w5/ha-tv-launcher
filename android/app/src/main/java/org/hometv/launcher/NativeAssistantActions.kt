package org.hometv.launcher

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.view.KeyEvent
import org.json.JSONObject

/** Executes only a confirmed, fixed-schema command inside this TV. No ADB or network shell. */
object NativeAssistantActions {
    data class Outcome(val reply: String, val leaveDialog: Boolean = false)

    fun execute(activity: Activity, action: JSONObject, home: () -> Unit, back: () -> Unit): Outcome {
        val allowedFields = setOf("type", "appId", "key", "url")
        val keys = action.keys().asSequence().toList()
        if (keys.any { it !in allowedFields || action.opt(it) !is String }) throw IllegalArgumentException("Invalid native action")
        val type = action.optString("type")
        val appId = if (action.has("appId")) action.optString("appId") else null
        val key = if (action.has("key")) action.optString("key") else null
        val url = if (action.has("url")) action.optString("url") else null
        if (!NativeAssistantPolicy.authorize(type, appId, key, url, keys.size)) throw IllegalArgumentException("Denied native action")
        val pm = activity.packageManager
        if (type == "launch_app") {
            val intent = TvAppLauncher(pm).resolve(appId!!) ?: return Outcome("Aplikace nyní není v televizi dostupná.")
            activity.startActivity(intent)
            return Outcome("Aplikace byla otevřena.", true)
        }
        if (type == "prima_episode") {
            if (TvAppLauncher(pm).resolve(appId!!) == null) return Outcome("Aplikace prima+ nyní není dostupná.")
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).setPackage(appId)
            @Suppress("DEPRECATION")
            val candidates = pm.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
            val resolved = candidates.firstOrNull { match ->
                val info = match.activityInfo ?: return@firstOrNull false
                info.packageName == appId && info.exported && info.enabled && info.applicationInfo.enabled &&
                    (info.applicationInfo.flags and ApplicationInfo.FLAG_SUSPENDED) == 0 &&
                    (info.permission.isNullOrEmpty() || pm.checkPermission(info.permission, activity.packageName) == PackageManager.PERMISSION_GRANTED) &&
                    runCatching { pm.getComponentEnabledSetting(ComponentName(info.packageName, info.name)) != PackageManager.COMPONENT_ENABLED_STATE_DISABLED }.getOrDefault(false)
            }?.activityInfo ?: return Outcome("prima+ nepotvrdila podporu odkazu na tuto epizodu. Žádný jiný prohlížeč neotevírám.")
            intent.component = ComponentName(resolved.packageName, resolved.name)
            activity.startActivity(intent)
            return Outcome("Odkaz byl předán prima+. Skutečné přehrávání ani přístup účtu nejsou ověřené.", true)
        }
        val audio = activity.getSystemService(Activity.AUDIO_SERVICE) as AudioManager
        when (key) {
            "volume_up" -> audio.adjustSuggestedStreamVolume(AudioManager.ADJUST_RAISE, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
            "volume_down" -> audio.adjustSuggestedStreamVolume(AudioManager.ADJUST_LOWER, AudioManager.USE_DEFAULT_STREAM_TYPE, AudioManager.FLAG_SHOW_UI)
            "mute" -> audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
            "play_pause", "pause", "play" -> {
                val code = when (key) { "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE; "play" -> KeyEvent.KEYCODE_MEDIA_PLAY; else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE }
                audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
                audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
            }
            "home" -> { home(); return Outcome("Hlavní nabídka.", true) }
            "back" -> { back(); return Outcome("Zpět.", true) }
        }
        return Outcome("Povel byl předán systému televize. Fyzický výsledek ověř na obrazovce.")
    }
}
