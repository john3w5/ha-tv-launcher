package org.hometv.launcher

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import java.util.Collections
import java.util.WeakHashMap

/** Shared skin for our own AlertDialogs. The system speech provider keeps its own UI. */
object NativeDialogStyle {
    private val normalized = Collections.newSetFromMap(WeakHashMap<View, Boolean>())

    /** Call after show(): Android creates the title, message and action buttons only then. */
    @JvmStatic fun apply(dialog: AlertDialog, activity: Activity, dark: Boolean) {
        val window = dialog.window ?: return
        val metrics = activity.resources.displayMetrics
        val scale = minOf(metrics.widthPixels / 1440f, metrics.heightPixels / 810f)
        fun px(value: Float) = value * scale
        fun unit(value: Int) = px(value.toFloat()).toInt()
        val ink = if (dark) Color.rgb(246, 247, 250) else Color.rgb(36, 40, 47)
        val muted = if (dark) Color.rgb(195, 199, 208) else Color.rgb(91, 98, 110)
        fun shape(fill: Int, border: Int = 0, radius: Float = 22f) = GradientDrawable().apply {
            setColor(fill); cornerRadius = px(radius)
            if (border != 0) setStroke(unit(1).coerceAtLeast(1), border)
        }
        window.setBackgroundDrawable(GradientDrawable(GradientDrawable.Orientation.TL_BR,
            if (dark) intArrayOf(Color.argb(244, 55, 60, 70), Color.argb(244, 34, 38, 47))
            else intArrayOf(Color.argb(244, 249, 251, 253), Color.argb(244, 232, 237, 243))).apply {
            cornerRadius = px(28f)
            setStroke(unit(1).coerceAtLeast(1), if (dark) Color.argb(78, 255, 255, 255) else Color.argb(230, 255, 255, 255))
        })
        window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.setDimAmount(.24f)
        val width = minOf(unit(800), 1100, metrics.widthPixels - unit(40)).coerceAtLeast(1)
        window.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT)
        val clearContainers = setOf("parentPanel", "topPanel", "contentPanel", "buttonPanel", "customPanel", "custom", "scrollView", "title_template")
        val densityRatio = scale / metrics.density
        fun walk(view: View) {
            val entry = if (view.id == View.NO_ID) "" else runCatching { view.resources.getResourceEntryName(view.id) }.getOrDefault("")
            val frameworkView = view.id != View.NO_ID && runCatching { view.resources.getResourcePackageName(view.id) == "android" }.getOrDefault(false)
            // Framework paddings are dp at density 2 on this TV; custom content already uses our design scale.
            if (frameworkView && normalized.add(view)) {
                view.setPadding((view.paddingLeft * densityRatio).toInt(), (view.paddingTop * densityRatio).toInt(),
                    (view.paddingRight * densityRatio).toInt(), (view.paddingBottom * densityRatio).toInt())
                val layout = view.layoutParams
                if (layout is ViewGroup.MarginLayoutParams) {
                    layout.leftMargin = (layout.leftMargin * densityRatio).toInt()
                    layout.topMargin = (layout.topMargin * densityRatio).toInt()
                    layout.rightMargin = (layout.rightMargin * densityRatio).toInt()
                    layout.bottomMargin = (layout.bottomMargin * densityRatio).toInt()
                    view.layoutParams = layout
                }
            }
            if (entry in clearContainers) view.setBackgroundColor(Color.TRANSPARENT)
            when (view) {
                is Button -> {
                    view.isAllCaps = false; view.includeFontPadding = false
                    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(14f)); view.setTextColor(ink)
                    view.typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                    view.minWidth = 0; view.minimumWidth = 0; view.minHeight = 0; view.minimumHeight = 0
                    view.setPadding(unit(18), unit(11), unit(18), unit(11))
                    view.backgroundTintList = null
                    view.background = StateListDrawable().apply {
                        addState(intArrayOf(android.R.attr.state_focused), shape(if (dark) Color.rgb(84, 91, 106) else Color.WHITE))
                        addState(intArrayOf(android.R.attr.state_pressed), shape(if (dark) Color.rgb(77, 85, 101) else Color.rgb(218, 226, 237)))
                        addState(intArrayOf(), shape(if (dark) Color.argb(18, 255, 255, 255) else Color.argb(100, 255, 255, 255)))
                    }
                    view.stateListAnimator = null; view.elevation = 0f; view.outlineProvider = null
                    if (Build.VERSION.SDK_INT >= 26) view.defaultFocusHighlightEnabled = false
                }
                is EditText -> {
                    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(14f)); view.setTextColor(ink); view.setHintTextColor(muted)
                    view.setPadding(unit(14), unit(12), unit(14), unit(12))
                    view.minHeight = unit(46); view.minimumHeight = unit(46)
                    view.backgroundTintList = null
                    view.background = StateListDrawable().apply {
                        addState(intArrayOf(android.R.attr.state_focused), shape(if (dark) Color.argb(34, 255, 255, 255) else Color.argb(225, 255, 255, 255), if (dark) Color.argb(150, 224, 235, 249) else Color.argb(160, 174, 190, 211), 15f))
                        addState(intArrayOf(), shape(if (dark) Color.argb(17, 255, 255, 255) else Color.argb(110, 255, 255, 255), if (dark) Color.argb(50, 255, 255, 255) else Color.argb(95, 174, 185, 200), 15f))
                    }
                    view.highlightColor = if (dark) Color.argb(100, 154, 173, 202) else Color.argb(95, 154, 173, 202)
                    if (Build.VERSION.SDK_INT >= 29) view.textCursorDrawable = shape(ink, radius = 1f).apply { setSize(unit(2).coerceAtLeast(1), unit(20)) }
                    if (Build.VERSION.SDK_INT >= 26) view.defaultFocusHighlightEnabled = false
                }
                is TextView -> {
                    val title = entry == "alertTitle" || view.id == android.R.id.title
                    view.setTextSize(TypedValue.COMPLEX_UNIT_PX, px(if (title) 24f else 14f))
                    view.setTextColor(if (title) ink else muted)
                    view.includeFontPadding = false
                    view.typeface = Typeface.create(if (title) "sans-serif-medium" else "sans-serif", Typeface.NORMAL)
                    view.setLineSpacing(px(3f), 1f)
                }
            }
            if (view is ViewGroup) for (index in 0 until view.childCount) walk(view.getChildAt(index))
        }
        walk(window.decorView)
        // Long details may scroll in Android's own content area; short inputs keep their natural height.
        window.decorView.post {
            if (dialog.isShowing && window.decorView.height > unit(660)) window.setLayout(width, unit(660))
        }
    }
}
