package org.hometv.launcher

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Shader
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/** Static, local weather artwork. No animation, bitmap downloads, timers or invented readings. */
class NativeWeatherPainter {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()

    fun draw(canvas: Canvas, width: Float, height: Float, dashboard: JSONObject, dark: Boolean, now: Long = System.currentTimeMillis()) {
        val weather = dashboard.optJSONObject("weather")
        val solar = dashboard.optJSONObject("solar")
        val condition = weather?.optString("condition", "") ?: ""
        val rain = weather?.opt("rainRate") as? Number
        val elevation = (solar?.opt("elevation") as? Number)?.toDouble()
        val azimuth = (solar?.opt("azimuth") as? Number)?.toDouble()
        val state = NativeWeatherPolicy.derive(dashboard.optString("mode"), dashboard.optString("updatedAt"), now,
            solar?.optString("state", "") ?: "", elevation, azimuth, condition, rain?.toDouble(),
            weather?.optJSONObject("units")?.optString("rainRate", "") ?: "")
        val active = state.fresh && solar?.optString("state") == "above_horizon"
        val scene = if (active) state.scene else "unknown"
        val cloudy = scene in listOf("cloudy", "fog")
        val rainy = scene in listOf("rain", "storm")
        val top = when {
            dark && active && rainy -> Color.rgb(41, 56, 68)
            dark && active && cloudy -> Color.rgb(48, 56, 65)
            dark && active -> Color.rgb(40, 54, 66)
            dark -> Color.rgb(36, 37, 39)
            !active -> Color.rgb(239, 240, 242)
            rainy -> Color.rgb(129, 153, 174)
            cloudy -> Color.rgb(174, 191, 207)
            else -> Color.rgb(159, 199, 228)
        }
        val middle = when { dark && active && rainy -> Color.rgb(37, 45, 56); dark && active && cloudy -> Color.rgb(37, 43, 50); dark && active -> Color.rgb(34, 42, 52); dark -> Color.rgb(26, 27, 29); !active -> Color.rgb(223, 225, 228); rainy -> Color.rgb(189, 203, 213); cloudy -> Color.rgb(215, 223, 229); else -> Color.rgb(200, 220, 233) }
        val bottom = when { dark && active && (rainy || cloudy) -> middle; dark && active -> Color.rgb(32, 35, 41); dark -> Color.rgb(17, 18, 20); !active -> Color.rgb(207, 210, 214); rainy -> Color.rgb(212, 219, 224); cloudy -> Color.rgb(230, 229, 223); else -> Color.rgb(236, 223, 207) }
        // CSS linear-gradient angles and stops used by the companion preview.
        val angle = Math.toRadians(if (!active) { if (dark) 150.0 else 145.0 } else if (dark && cloudy) 150.0 else if (cloudy || rainy) 155.0 else 165.0)
        val dx = sin(angle).toFloat(); val dy = -cos(angle).toFloat(); val extent = abs(width * dx) + abs(height * dy)
        paint.color = Color.WHITE; paint.shader = LinearGradient(width / 2f - dx * extent / 2f, height / 2f - dy * extent / 2f,
            width / 2f + dx * extent / 2f, height / 2f + dy * extent / 2f, intArrayOf(top, middle, bottom),
            floatArrayOf(0f, if (dark && active) when { cloudy -> .7f; rainy -> .65f; else -> .57f } else if (cloudy || rainy) .68f else .5f, 1f), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, width, height, paint)
        paint.shader = null
        if (state.sunVisible && elevation != null && elevation < 12.0) {
            paint.color = Color.WHITE; paint.shader = LinearGradient(0f, height, 0f, height * .35f,
                if (dark) Color.argb(22, 217, 164, 126) else Color.argb(77, 237, 196, 165), Color.TRANSPARENT, Shader.TileMode.CLAMP)
            canvas.drawRect(0f, 0f, width, height, paint); paint.shader = null
        }

        if (state.sunVisible && elevation != null && azimuth != null) {
            // Decorative east-to-west placement driven by the actual HA angles, not a fabricated sunrise time.
            val x = width * ((8.0 + (azimuth - 90.0) / 180.0 * 84.0).coerceIn(4.0, 96.0) / 100.0).toFloat()
            val y = height * ((74.0 - elevation.coerceAtLeast(0.0) / 90.0 * 62.0).coerceIn(12.0, 74.0) / 100.0).toFloat()
            val opacity = when (scene) { "clear" -> .85f; "partly" -> .95f; "cloudy", "rain" -> .15f; "storm", "fog", "snow" -> .07f; else -> .4f }
            val radius = width * .035f; val glow = radius * 4.2f
            paint.color = Color.WHITE; paint.shader = RadialGradient(x, y, glow, intArrayOf(Color.argb((34 * opacity).toInt(), 232, 201, 154), Color.TRANSPARENT), floatArrayOf(0f, 1f), Shader.TileMode.CLAMP)
            canvas.drawCircle(x, y, glow, paint); paint.shader = null
            paint.color = Color.WHITE; paint.shader = RadialGradient(x - radius * .24f, y - radius * .44f, radius * 1.5f,
                Color.argb((217 * opacity).toInt(), 255, 248, 231), Color.argb((156 * opacity).toInt(), 231, 198, 142), Shader.TileMode.CLAMP)
            canvas.drawCircle(x, y, radius, paint); paint.shader = null
        }
        if (scene in listOf("partly", "cloudy", "fog", "rain", "storm", "snow")) {
            // Sparse atmospheric silhouettes: one continuous contour, with no stacked circles or ellipses.
            cloud(canvas, width * .15f, height * .16f, width * .21f, dark, 67)
            cloud(canvas, width * .84f, height * .14f, width * .23f, dark, 77)
            if (scene != "partly") cloud(canvas, width * .61f, height * .53f, width * .24f, dark, 39)
        }
        if (scene in listOf("rain", "storm")) {
            paint.color = Color.argb(33, 199, 216, 229)
            paint.strokeWidth = 1.3f
            repeat(18) { index ->
                val x = width * (40 + index * 83) / 1440f
                val y = height * (280 + index % 3 * 180) / 810f
                canvas.drawLine(x, y, x - width * 20f / 1440f, y + height * 76f / 810f, paint)
            }
        } else if (scene == "snow") {
            paint.color = Color.argb(89, 255, 255, 255)
            repeat(22) { index ->
                canvas.drawCircle(width * (33 + index * 67) / 1440f, height * (290 + index % 5 * 112) / 810f, if (index % 3 == 0) 4f else 2.5f, paint)
            }
        }
    }

    private fun cloud(canvas: Canvas, x: Float, y: Float, width: Float, dark: Boolean, opacity: Int) {
        val left = x - width / 2f; val height = width * .31f
        NativeCloudSilhouette.build(path, left, y, width, height)
        paint.color = Color.WHITE
        paint.shader = LinearGradient(left, y, left + width * .15f, y + height,
            if (dark) Color.argb(19, 230, 238, 249) else Color.argb(opacity, 255, 255, 255),
            if (dark) Color.argb(4, 171, 190, 213) else Color.argb(opacity / 4, 216, 229, 240), Shader.TileMode.CLAMP)
        canvas.drawPath(path, paint); paint.shader = null
    }
}

/** Shared single organic silhouette for the backdrop and the compact weather illustration. */
internal object NativeCloudSilhouette {
    fun build(path: Path, x: Float, y: Float, width: Float, height: Float) {
        path.reset()
        path.moveTo(x + width * .035f, y + height * .66f)
        path.cubicTo(x - width * .012f, y + height * .53f, x + width * .035f, y + height * .39f, x + width * .14f, y + height * .405f)
        path.cubicTo(x + width * .15f, y + height * .23f, x + width * .285f, y + height * .175f, x + width * .385f, y + height * .29f)
        path.cubicTo(x + width * .435f, y + height * .08f, x + width * .60f, y + height * .045f, x + width * .704f, y + height * .245f)
        path.cubicTo(x + width * .83f, y + height * .185f, x + width * .956f, y + height * .35f, x + width * .93f, y + height * .495f)
        path.cubicTo(x + width * 1.035f, y + height * .61f, x + width * 1.008f, y + height * .805f, x + width * .86f, y + height * .88f)
        path.cubicTo(x + width * .70f, y + height * .965f, x + width * .55f, y + height * .91f, x + width * .385f, y + height * .94f)
        path.cubicTo(x + width * .25f, y + height * .97f, x + width * .12f, y + height * .91f, x + width * .075f, y + height * .81f)
        path.cubicTo(x + width * .025f, y + height * .8f, x + width * .005f, y + height * .745f, x + width * .035f, y + height * .66f)
        path.close()
    }
}
