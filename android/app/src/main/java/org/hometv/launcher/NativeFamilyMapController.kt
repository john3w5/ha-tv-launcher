package org.hometv.launcher

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import kotlin.math.roundToInt

/** Local packaged Leaflet document with bounded, direct TV→OSM tiles. No HA cookie or JS bridge. */
class NativeFamilyMapController(
    private val activity: Activity,
    private val isDark: () -> Boolean,
    private val onClosed: () -> Unit,
) {
    private data class Position(val id: String, val name: String, val latitude: Double, val longitude: Double, val home: Boolean)
    private var positions = emptyList<Position>()
    private var missing = emptyList<String>()
    private var selected = "all"
    private var zoom = 16
    private var embedded: FrameLayout? = null
    private var expanded: FrameLayout? = null
    @Volatile private var web: WebView? = null
    private var caption: TextView? = null
    private var pills: LinearLayout? = null
    private var ready = false
    @Volatile private var paused = true
    @Volatile private var destroyed = false
    private var generation = 0L
    private var disposal: Runnable? = null
    private var lastPayload: String? = null
    private var layoutListener: View.OnLayoutChangeListener? = null
    private val handler = Handler(Looper.getMainLooper())
    private val scale get() = activity.resources.displayMetrics.widthPixels / 1440f

    fun bind(household: JSONObject) = ui {
        if (destroyed) return@ui
        val next = ArrayList<Position>(); val unavailable = ArrayList<String>()
        val people = household.optJSONArray("people")
        for (index in 0 until minOf(people?.length() ?: 0, 8)) {
            val item = people?.optJSONObject(index) ?: continue
            val name = text(item.optString("name", "Člen rodiny"), 40)
            val position = if (item.opt("available") == true && item.opt("locationAvailable") == true)
                position(item, "person-" + item.optString("id").takeIf { it.matches(Regex("[a-z0-9_-]{1,64}")) }.orEmpty().ifEmpty { index.toString() }, name, false) else null
            if (position != null) next.add(position) else unavailable.add(name)
        }
        val zones = household.optJSONArray("zones")
        for (index in 0 until minOf(zones?.length() ?: 0, 32)) {
            val item = zones?.optJSONObject(index) ?: continue
            if (item.optString("id") == "home" && item.opt("available") == true) {
                position(item, "home", "Domov", true)?.let(next::add); break
            }
        }
        positions = next; missing = unavailable
        if (selected != "all" && positions.none { it.id == selected }) selected = "all"
        refreshControls(); applyPayload()
    }

    private fun position(item: JSONObject, id: String, name: String, home: Boolean): Position? {
        val latitude = (item.opt("latitude") as? Number)?.toDouble() ?: return null
        val longitude = (item.opt("longitude") as? Number)?.toDouble() ?: return null
        if (!NativeFamilyMapPolicy.coordinates(latitude, longitude)) return null
        return Position(id, name, latitude, longitude, home)
    }

    /** Bounds are actual SCREEN pixels, matching NativeGoogleMapController's interface. */
    fun showEmbedded(bounds: RectF?) = ui {
        if (destroyed || expanded != null) return@ui
        if (bounds == null || bounds.width() < 1 || bounds.height() < 1) { hideEmbedded(); return@ui }
        cancelDisposal(); paused = false
        val frame = embedded ?: FrameLayout(activity).apply {
            background = shape(panelColor(), 16f); clipToOutline = true; isFocusable = false
            embedded = this; activity.findViewById<ViewGroup>(android.R.id.content).addView(this)
        }
        val width = bounds.width().roundToInt(); val height = bounds.height().roundToInt()
        val old = frame.layoutParams as? FrameLayout.LayoutParams
        if (old == null || old.width != width || old.height != height || old.leftMargin != bounds.left.roundToInt() || old.topMargin != bounds.top.roundToInt()) {
            frame.layoutParams = FrameLayout.LayoutParams(width, height).apply { leftMargin = bounds.left.roundToInt(); topMargin = bounds.top.roundToInt() }
        }
        frame.visibility = View.VISIBLE
        if (frame.childCount == 0) attachBody(frame, false)
        web?.onResume(); applyPayload(); setVisible(true)
    }

    fun openExpanded() = ui {
        if (destroyed || expanded != null) return@ui
        cancelDisposal(); paused = false
        embedded?.let { (it.parent as? ViewGroup)?.removeView(it) }; embedded = null
        val cover = FrameLayout(activity).apply { setBackgroundColor(Color.argb(105, 0, 0, 0)); isClickable = true }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(v(22), v(16), v(22), v(16)); background = shape(panelColor(), 26f)
        }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("Kde jsme", 24f), LinearLayout.LayoutParams(0, -2, 1f)); header.addView(button("Zavřít") { close() }); body.addView(header)
        pills = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, v(10), 0, v(8)) }.also {
            body.addView(it, LinearLayout.LayoutParams(-1, v(56)))
        }
        val mapFrame = FrameLayout(activity).apply { background = shape(panelColor(), 18f); clipToOutline = true }
        attachBody(mapFrame, true); body.addView(mapFrame, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, v(10), 0, 0) }
        footer.addView(label("← → výběr   ·   ↑ ↓ přiblížení   ·   Zpět zavřít", 13f), LinearLayout.LayoutParams(0, -2, 1f))
        footer.addView(button("−") { changeZoom(-1) }); footer.addView(button("+") { changeZoom(1) }); body.addView(footer)
        cover.addView(body, FrameLayout.LayoutParams(v(1120), v(650), Gravity.CENTER))
        expanded = cover; activity.findViewById<ViewGroup>(android.R.id.content).addView(cover, ViewGroup.LayoutParams(-1, -1))
        web?.onResume(); refreshControls(); applyPayload(); setVisible(true)
    }

    fun isOpen(): Boolean = expanded?.parent != null
    fun handleKey(event: KeyEvent): Boolean {
        if (!isOpen()) return false
        return when (event.keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> { if (event.action == KeyEvent.ACTION_UP) close(); true }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> { if (event.action == KeyEvent.ACTION_DOWN) changePerson(if (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -1 else 1); true }
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN) changeZoom(if (event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP)) 1 else -1); true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> true
            else -> false
        }
    }

    private fun changePerson(delta: Int) {
        val choices = listOf("all") + positions.map { it.id }
        selected = choices[(choices.indexOf(selected).coerceAtLeast(0) + delta + choices.size) % choices.size]
        refreshControls(); applyPayload()
    }
    private fun changeZoom(delta: Int) { val next = (zoom + delta).coerceIn(2, 18); if (next != zoom) { zoom = next; applyPayload() } }
    private fun refreshControls() {
        val current = positions.find { it.id == selected }
        val familyCount = positions.count { !it.home }
        caption?.text = (current?.name ?: "Rodina · $familyCount dostupné polohy") + if (missing.isEmpty()) "" else "   ·   Bez polohy: ${missing.joinToString(", ")}"
        pills?.let { row ->
            row.removeAllViews()
            val choices = listOf("all" to "Všichni") + positions.map { it.id to it.name }
            choices.forEach { (id, name) -> row.addView(button(name) { selected = id; refreshControls(); applyPayload() }.apply { isSelected = selected == id },
                LinearLayout.LayoutParams(if (choices.size > 6) 0 else -2, v(36), if (choices.size > 6) 1f else 0f).apply { marginEnd = v(8) }) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWeb(): WebView {
        val view = WebView(activity).apply {
            isFocusable = false; isFocusableInTouchMode = false; setBackgroundColor(panelColor())
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = false; databaseEnabled = false
                cacheMode = WebSettings.LOAD_DEFAULT; useWideViewPort = true; loadWithOverviewMode = true
                allowFileAccess = false; allowContentAccess = false; allowFileAccessFromFileURLs = false; allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW; javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false); setGeolocationEnabled(false); mediaPlaybackRequiresUserGesture = true
                userAgentString = "$userAgentString HomeTV/${BuildConfig.VERSION_NAME} (org.hometv.launcher)"
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean = true
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val raw = request.url.toString()
                    if (request.isForMainFrame && request.hasGesture() && NativeFamilyMapPolicy.attribution(raw)) ui {
                        runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(raw))) }
                    }
                    return !NativeFamilyMapPolicy.document(raw)
                }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val raw = request.url.toString()
                    if (!destroyed && view === web && request.method == "GET") {
                        val asset = NativeFamilyMapPolicy.asset(raw)
                        if (asset != null) return localAsset(asset)
                        // Let Chromium honour HTTP cache headers, Etag and normal Referer.
                        if (!paused && NativeFamilyMapPolicy.tile(raw)) return null
                    }
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (view === web && !destroyed && NativeFamilyMapPolicy.document(url)) { ready = true; lastPayload = null; applyPayload(); setVisible(!paused) }
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel() }
            }
        }
        web = view; ready = false; lastPayload = null
        view.loadUrl(NativeFamilyMapPolicy.DOCUMENT)
        return view
    }

    private fun localAsset(path: String): WebResourceResponse {
        val mime = when { path.endsWith(".html") -> "text/html"; path.endsWith(".js") -> "application/javascript"; path.endsWith(".css") -> "text/css"; else -> "image/png" }
        return try { WebResourceResponse(mime, if (mime == "image/png") null else "UTF-8", 200, "OK",
            mapOf("Referrer-Policy" to "origin", "X-Content-Type-Options" to "nosniff"), activity.assets.open(path)) }
        catch (_: Exception) { WebResourceResponse("text/plain", "UTF-8", 404, "Unavailable", emptyMap(), ByteArrayInputStream(ByteArray(0))) }
    }
    private fun attachBody(frame: FrameLayout, full: Boolean) {
        val view = web ?: createWeb()
        val title = caption ?: label("Rodinná mapa", if (full) 14f else 12f).apply { setPadding(v(9), v(5), v(9), 0) }.also { caption = it }
        listOf<View>(view, title).forEach { (it.parent as? ViewGroup)?.removeView(it) }
        frame.addView(view, FrameLayout.LayoutParams(-1, -1).apply { topMargin = v(28) })
        frame.addView(title, FrameLayout.LayoutParams(-1, v(28), Gravity.TOP))
        if (!full) frame.addView(View(activity).apply { isFocusable = false; setOnClickListener { openExpanded() } }, FrameLayout.LayoutParams(-1, -1))
        layoutListener?.let(view::removeOnLayoutChangeListener)
        layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            if (view === web && ready && !paused) view.evaluateJavascript("window.HomeTVFamilyMap&&window.HomeTVFamilyMap.resize()", null)
        }.also(view::addOnLayoutChangeListener)
        refreshControls()
    }
    private fun applyPayload() {
        val view = web ?: return
        if (!ready || paused || destroyed) return
        val rows = JSONArray()
        positions.take(9).forEach { position -> rows.put(JSONObject().put("id", position.id).put("name", position.name).put("latitude", position.latitude).put("longitude", position.longitude).put("home", position.home)) }
        val payload = JSONObject().put("positions", rows).put("selected", selected).put("zoom", zoom).put("dark", isDark()).toString()
        if (lastPayload == payload) return
        lastPayload = payload
        view.evaluateJavascript("window.HomeTVFamilyMap&&window.HomeTVFamilyMap.bind($payload)", null)
    }
    private fun setVisible(visible: Boolean) { if (ready) web?.evaluateJavascript("window.HomeTVFamilyMap&&window.HomeTVFamilyMap.setVisible(${if (visible) "true" else "false"})", null) }
    private fun hideEmbedded() {
        val frame = embedded ?: return
        if (paused) return
        paused = true; setVisible(false); frame.visibility = View.GONE; web?.onPause()
        cancelDisposal(); val ticket = generation; val owner = web
        disposal = Runnable { if (ticket == generation && paused && expanded == null && frame === embedded && owner === web) disposeWeb() }.also { handler.postDelayed(it, 30000) }
    }
    private fun cancelDisposal() { generation++; disposal?.let(handler::removeCallbacks); disposal = null }
    private fun disposeWeb() {
        cancelDisposal(); paused = true; ready = false; lastPayload = null
        web?.let { view -> layoutListener?.let(view::removeOnLayoutChangeListener); view.stopLoading(); view.onPause(); (view.parent as? ViewGroup)?.removeView(view); view.destroy() }; web = null; caption = null; layoutListener = null
        embedded?.let { (it.parent as? ViewGroup)?.removeView(it) }; embedded = null
    }
    fun close() = ui {
        val wasOpen = expanded != null
        disposeWeb(); expanded?.let { (it.parent as? ViewGroup)?.removeView(it) }; expanded = null; pills = null
        if (wasOpen) onClosed()
    }
    fun onPause() = close()
    fun onDestroy() = ui { destroyed = true; close(); positions = emptyList(); missing = emptyList() }
    private fun ui(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else activity.runOnUiThread(action) }
    private fun text(value: String, limit: Int) = value.replace(Regex("[\\p{Cntrl}]"), " ").take(limit)
    private fun v(value: Int) = (value * scale).roundToInt()
    private fun panelColor() = if (isDark()) Color.rgb(34, 40, 48) else Color.rgb(240, 243, 247)
    private fun ink() = if (isDark()) Color.rgb(245, 247, 250) else Color.rgb(32, 39, 48)
    private fun shape(fill: Int, radius: Float) = GradientDrawable().apply { setColor(fill); cornerRadius = radius * scale }
    private fun label(value: String, size: Float) = TextView(activity).apply { text = value; includeFontPadding = false; setTextSize(TypedValue.COMPLEX_UNIT_PX, size * scale); setTextColor(ink()); maxLines = 1 }
    private fun button(value: String, action: () -> Unit) = Button(activity).apply {
        text = value; isAllCaps = false; isFocusable = false; includeFontPadding = false; minHeight = 0; minWidth = 0
        maxLines = 1; maxWidth = v(170); ellipsize = android.text.TextUtils.TruncateAt.END
        setTextColor(ink()); setTextSize(TypedValue.COMPLEX_UNIT_PX, 14f * scale); setPadding(v(13), v(6), v(13), v(6))
        background = android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_selected), shape(if (isDark()) Color.rgb(77, 95, 117) else Color.WHITE, 19f))
            addState(intArrayOf(), shape(if (isDark()) Color.argb(90, 100, 115, 135) else Color.argb(160, 218, 226, 237), 19f))
        }; setOnClickListener { action() }
    }
}
