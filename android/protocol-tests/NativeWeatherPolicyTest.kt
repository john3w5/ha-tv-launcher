package org.hometv.launcher

/** Real weather projection contract with fixed public fixtures; no Android, JSON, network or location. */
object NativeWeatherPolicyTest {
    private var checks = 0
    private fun check(value: Boolean, label: String) { checks++; if (!value) error(label) }
    private const val NOW = 1792900800000L // 2026-10-25T04:00:00Z
    private const val UPDATED = "2026-10-25T04:00:00.000Z"

    @JvmStatic fun main(args: Array<String>) {
        fun derive(mode: String = "live", updated: String = UPDATED, now: Long = NOW,
                   sun: String = "above_horizon", elevation: Double? = 30.0, azimuth: Double? = 180.0,
                   condition: String = "sunny", rain: Double? = null, unit: String = "mm/h") =
            NativeWeatherPolicy.derive(mode, updated, now, sun, elevation, azimuth, condition, rain, unit)

        val fresh = derive()
        check(fresh.fresh && fresh.sunVisible && fresh.scene == "clear", "Fresh explicit sunny data with actual angles")
        check(NativeWeatherPolicy.isFresh("live", UPDATED, NOW + 300000), "Exactly five minutes is still fresh")
        check(!NativeWeatherPolicy.isFresh("live", UPDATED, NOW + 300001), "More than five minutes is stale")
        check(NativeWeatherPolicy.isFresh("live", UPDATED, NOW - 60000), "At most sixty seconds clock skew")
        check(!NativeWeatherPolicy.isFresh("live", UPDATED, NOW - 60001), "Far future reading is rejected")
        for (updated in listOf("2026-10-25T04:00:00Z", "2026-10-25T04:00:00.0Z", "2026-10-25T04:00:00.000000000Z",
            "2026-10-25T06:00:00.000+02:00", "2026-10-25T03:00:00.000-01:00"))
            check(NativeWeatherPolicy.isFresh("live", updated, NOW), "Equivalent actual ISO timestamps share freshness")
        for (updated in listOf("", "unknown", "unavailable", "2026-02-30T04:00:00.000Z", "2026-13-25T04:00:00.000Z",
            "2026-10-25T25:00:00.000Z", "2026-10-25T04:60:00.000Z", "2026-10-25", "2026-10-25T04:00:00", UPDATED + "extra",
            "2026-02-29T04:00:00.000Z", "2026-11-31T04:00:00.000Z", "2026-10-25T04:00:00.000+24:00")) {
            val result = derive(updated = updated)
            check(!result.fresh && !result.sunVisible && result.scene == "unknown", "Invalid timestamp never becomes real weather")
        }
        for (mode in listOf("offline", "demo", "setup", "loading", "", "LIVE")) {
            val result = derive(mode = mode)
            check(!result.fresh && !result.sunVisible && result.scene == "unknown", "Only actual live data drives weather")
        }
        for (result in listOf(derive(now = NOW + 300001), derive(now = NOW - 60001)))
            check(!result.sunVisible && result.scene == "unknown", "Stale or future weather is neutral even with cached valid angles")
        for (sun in listOf("unknown", "unavailable", "", "below_horizon"))
            check(!derive(sun = sun).sunVisible, "Sun horizon must be explicitly above")
        for (angle in listOf(null, Double.NaN, Double.POSITIVE_INFINITY, -1.0, 90.1))
            check(!derive(elevation = angle).sunVisible, "Invalid or below-horizon elevation does not draw a sun")
        for (angle in listOf(null, Double.NaN, Double.NEGATIVE_INFINITY, -0.1, 360.1))
            check(!derive(azimuth = angle).sunVisible, "Sun needs an actual bounded azimuth")
        check(derive(elevation = 0.0, azimuth = 0.0).sunVisible, "Real zero angles remain valid, not missing data")
        check(derive(elevation = 90.0, azimuth = 360.0).sunVisible, "Valid endpoint angles")

        for (rain in listOf(null, 0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY))
            check(derive(condition = "", rain = rain).scene == "unknown", "Missing/zero/invalid rain cannot prove a clear sky")
        for (unit in listOf("", "%", "mm", "l", "unknown"))
            check(derive(condition = "", rain = 2.0, unit = unit).scene == "unknown", "Rain inference requires an actual rate unit")
        for (unit in listOf("mm/h", "mm/hr", "in/h", "in/hr"))
            check(derive(condition = "", rain = 0.2, unit = unit).scene == "rain", "Verified positive rain rate drives rain")
        check(derive(condition = "cloudy", rain = 0.2).scene == "rain", "Own station rain can override provider cloudiness")
        check(derive(condition = "rainy", rain = 0.0).scene == "rain", "Zero station rain does not erase explicit provider rain")
        check(derive(condition = "lightning-rainy", rain = 2.0).scene == "storm", "Rain cannot erase explicit storm condition")
        check(derive(condition = "snowy", rain = 2.0).scene != "rain", "Rain cannot erase explicit snow condition")
        check(derive(condition = "<script>", rain = null).scene == "unknown", "Unknown condition remains unknown")
        println("NativeWeatherPolicy: $checks assertions passed.")
    }
}
