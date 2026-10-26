package org.hometv.launcher

import android.content.ComponentName
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager

/** Resolve the requested installed app now. No shell, package mutation, content URI, or catalog UI. */
class TvAppLauncher(private val pm: PackageManager) {
    @Suppress("DEPRECATION")
    fun resolve(appId: String): Intent? {
        if (!NativeLaunchPolicy.isAllowedPackage(appId)) return null
        val app = runCatching { pm.getApplicationInfo(appId, 0) }.getOrNull() ?: return null
        val packageEnabled = runCatching { enabled(pm.getApplicationEnabledSetting(appId)) }.getOrDefault(false)
        if (!app.enabled || !packageEnabled || (app.flags and ApplicationInfo.FLAG_SUSPENDED) != 0) return null
        // TV-specific entry first; ordinary launcher entry is the native fallback.
        val categories = if (appId == NativeLaunchPolicy.GOOGLE_TV_HOME) listOf(Intent.CATEGORY_HOME) else listOf(Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER)
        for (category in categories) {
            val query = Intent(Intent.ACTION_MAIN).addCategory(category).setPackage(appId)
            val matches = runCatching { pm.queryIntentActivities(query, 0) }.getOrDefault(emptyList())
            for (match in matches.sortedBy { it.activityInfo?.name.orEmpty() }) {
                val info = match.activityInfo ?: continue
                val component = ComponentName(info.packageName, info.name)
                val componentEnabled = runCatching { enabled(pm.getComponentEnabledSetting(component)) }.getOrDefault(false)
                val permissionGranted = info.permission.isNullOrEmpty() ||
                    pm.checkPermission(info.permission, "org.hometv.launcher") == PackageManager.PERMISSION_GRANTED
                if (NativeLaunchPolicy.isLaunchable(appId, info.packageName, info.exported,
                        info.enabled, info.applicationInfo.enabled, packageEnabled, componentEnabled,
                        (info.applicationInfo.flags and ApplicationInfo.FLAG_SUSPENDED) == 0, permissionGranted)) {
                    return Intent(Intent.ACTION_MAIN).addCategory(category).setComponent(component)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
                }
            }
        }
        return null
    }

    private fun enabled(state: Int) = state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ||
        state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
}
