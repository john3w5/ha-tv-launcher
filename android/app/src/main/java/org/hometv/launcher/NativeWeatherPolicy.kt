package org.hometv.launcher

import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Pure policy shared by native artwork and dashboard availability. No Android runtime. */
object NativeWeatherPolicy {
    data class State(val fresh: Boolean, val scene: String, val sunVisible: Boolean)

    fun isFresh(mode: String, updatedAt: String, now: Long): Boolean {
        if (mode != "live") return false
        val parts = Regex("^(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2})(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:?\\d{2})$").matchEntire(updatedAt) ?: return false
        val fraction = parts.groupValues[2].padEnd(3, '0').take(3)
        val offset = parts.groupValues[3].let { if (it == "Z") "+0000" else it.replace(":", "") }
        val normalized = parts.groupValues[1] + "." + fraction + offset
        val parser = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZ", Locale.ROOT).apply { isLenient = false; timeZone = TimeZone.getTimeZone("UTC") }
        val position = ParsePosition(0)
        val timestamp = parser.parse(normalized, position)?.takeIf { position.index == normalized.length }?.time ?: return false
        // Compare without subtraction overflow on malformed/unbounded input.
        return timestamp >= now - 300_000L && timestamp <= now + 60_000L
    }

    fun derive(mode: String, updatedAt: String, now: Long, solarState: String,
               elevation: Double?, azimuth: Double?, condition: String,
               rainRate: Double?, rainUnit: String): State {
        val fresh = isFresh(mode, updatedAt, now)
        val measuredRain = rainRate != null && rainRate.isFinite() && rainRate > 0 &&
            rainUnit.trim().lowercase() in setOf("mm/h", "mm/hr", "in/h", "in/hr")
        val scene = when {
            !fresh -> "unknown"
            condition in setOf("lightning", "lightning-rainy") -> "storm"
            condition in setOf("snowy", "snowy-rainy", "hail") -> "snow"
            condition in setOf("rainy", "pouring") || measuredRain -> "rain"
            condition == "fog" -> "fog"
            condition == "cloudy" -> "cloudy"
            condition == "partlycloudy" -> "partly"
            condition in setOf("sunny", "clear-night") -> "clear"
            else -> "unknown"
        }
        val sunVisible = fresh && solarState == "above_horizon" &&
            elevation != null && elevation.isFinite() && elevation in 0.0..90.0 &&
            azimuth != null && azimuth.isFinite() && azimuth in 0.0..360.0
        return State(fresh, scene, sunVisible)
    }
}
