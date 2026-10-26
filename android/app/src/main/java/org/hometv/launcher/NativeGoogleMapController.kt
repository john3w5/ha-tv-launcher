package org.hometv.launcher

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.RectF
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.GeolocationPermissions
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.net.http.SslError
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import org.json.JSONArray
import java.io.ByteArrayInputStream
import kotlin.math.roundToInt

/** Native framing with one isolated Google map. It never accesses the HA bridge or a JavaScript bridge. */
class NativeGoogleMapController(
    private val activity: Activity,
    private val isDark: () -> Boolean,
    private val onClosed: () -> Unit,
) {
    private data class Position(val id: String, val name: String, val latitude: Double, val longitude: Double)
    private var positions = emptyList<Position>()
    private var deferredPositions: List<Position>? = null
    private var awaitingConsentReturn = false
    private var selected = 0
    private var zoom = 14
    private var embeddedBounds: RectF? = null
    private var embedded: FrameLayout? = null
    private var embeddedPaused = false
    private var embeddedDisposal: Runnable? = null
    private var embeddedGeneration = 0L
    private var expanded: FrameLayout? = null
    @Volatile private var web: WebView? = null
    private var caption: TextView? = null
    private var message: TextView? = null
    private var pills: LinearLayout? = null
    @Volatile private var lastUrl: String? = null
    @Volatile private var currentPageUrl: String? = null
    @Volatile private var wrapperHtml: ByteArray? = null
    @Volatile private var consentActive = false
    private var pageEpoch = 0L
    private var diagnostics = 0
    private var allowedResources = 0
    private var blockedResources = 0
    private var userAgentBeforeFlags = 0
    private var userAgentAfterFlags = 0
    private var desktopUserAgentApplied = false
    private val blockedClasses = mutableSetOf<Int>()
    @Volatile private var standardPage = false
    private var loadFailed = false
    @Volatile private var destroyed = false
    private val handler = Handler(Looper.getMainLooper())
    private var timeout: Runnable? = null
    private var readiness: Runnable? = null
    private var layoutWait: View.OnLayoutChangeListener? = null
    private val scale get() = activity.resources.displayMetrics.widthPixels / 1440f

    fun bind(household: JSONObject) = ui {
        if (destroyed) return@ui
        val updated = mutableListOf<Position>()
        val people = household.optJSONArray("people")
        for (index in 0 until minOf(people?.length() ?: 0, 8)) {
            val item = people?.optJSONObject(index) ?: continue
            if (!item.optBoolean("available") || !item.optBoolean("locationAvailable")) continue
            position(item, "person-${item.optString("id")}", item.optString("name", "Člen rodiny"))?.let(updated::add)
        }
        val zones = household.optJSONArray("zones")
        for (index in 0 until minOf(zones?.length() ?: 0, 32)) {
            val item = zones?.optJSONObject(index) ?: continue
            if (item.optString("id") == "home" && item.optBoolean("available")) position(item, "home", "Domov")?.let(updated::add)
        }
        if (consentActive || awaitingConsentReturn) { deferredPositions = updated; return@ui }
        replacePositions(updated)
        refreshControls()
        if (embedded != null || expanded != null) loadSelected()
    }

    private fun replacePositions(updated: List<Position>) {
        val previous = positions.getOrNull(selected)?.id
        positions = updated
        selected = updated.indexOfFirst { it.id == previous }.takeIf { it >= 0 } ?: 0
    }

    private fun position(item: JSONObject, id: String, name: String): Position? {
        if (item.isNull("latitude") || item.isNull("longitude")) return null
        val latitude = (item.opt("latitude") as? Number)?.toDouble() ?: return null
        val longitude = (item.opt("longitude") as? Number)?.toDouble() ?: return null
        if (!NativeGoogleMapPolicy.coordinates(latitude, longitude)) return null
        return Position(id.take(80), name.replace(Regex("[\\p{Cntrl}]"), " ").take(40), latitude, longitude)
    }

    /** Bounds are SCREEN pixels supplied by the dashboard Canvas, not virtual coordinates. */
    fun showEmbedded(bounds: RectF?) = ui {
        if (destroyed) return@ui
        val previousBounds = embeddedBounds
        embeddedBounds = bounds?.let(::RectF)
        if (expanded != null) return@ui
        if (bounds == null || bounds.width() < 1 || bounds.height() < 1) { hideEmbedded(); return@ui }
        val wasPaused = embeddedPaused
        cancelEmbeddedDisposal(); embeddedPaused = false
        val host = activity.findViewById<ViewGroup>(android.R.id.content)
        val created = embedded == null
        val frame = embedded ?: FrameLayout(activity).apply {
            background = shape(if (isDark()) Color.rgb(34, 39, 46) else Color.rgb(237, 241, 246), 16f)
            clipToOutline = true; isFocusable = false
            embedded = this; host.addView(this)
        }
        frame.visibility = View.VISIBLE
        if (created || previousBounds != bounds) frame.layoutParams = FrameLayout.LayoutParams(bounds.width().roundToInt(), bounds.height().roundToInt()).apply {
            leftMargin = bounds.left.roundToInt(); topMargin = bounds.top.roundToInt()
        }
        if (frame.childCount == 0) buildMapBody(frame, false)
        if (created || wasPaused) web?.onResume()
        if (wasPaused) resumePage()
        loadSelected()
    }

    fun openExpanded() = ui {
        if (destroyed || expanded != null) return@ui
        removeEmbedded(preserveMap = true)
        val cover = FrameLayout(activity).apply { setBackgroundColor(Color.argb(100, 0, 0, 0)); isClickable = true; isFocusable = false }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(v(24), v(18), v(24), v(18))
            background = shape(if (isDark()) Color.rgb(34, 38, 45) else Color.rgb(242, 244, 247), 26f)
        }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(label("Kde jsme", 24f), LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("Zavřít") { close() }); body.addView(header)
        val profiles = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, v(12), 0, v(12)) }
        pills = profiles; body.addView(profiles, LinearLayout.LayoutParams(-1, v(64)))
        val mapFrame = FrameLayout(activity).apply { background = shape(Color.rgb(227, 232, 237), 18f); clipToOutline = true }
        buildMapBody(mapFrame, true)
        body.addView(mapFrame, LinearLayout.LayoutParams(-1, 0, 1f))
        val footer = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; setPadding(0, v(12), 0, 0) }
        footer.addView(label("← → osoba   ·   ↑ ↓ přiblížení   ·   Zpět zavřít", 13f), LinearLayout.LayoutParams(0, -2, 1f))
        footer.addView(button("−") { changeZoom(-1) }, LinearLayout.LayoutParams(v(48), v(38)).apply { marginEnd = v(8) })
        footer.addView(button("+") { changeZoom(1) }, LinearLayout.LayoutParams(v(48), v(38)))
        body.addView(footer)
        cover.addView(body, FrameLayout.LayoutParams(-1, -1).apply { setMargins(v(22), v(22), v(22), v(22)) })
        expanded = cover
        activity.findViewById<ViewGroup>(android.R.id.content).addView(cover, ViewGroup.LayoutParams(-1, -1))
        web?.onResume(); refreshControls(); syncConsentFocus()
        val view = web
        if (view != null && loadFailed && !standardPage) useStandardPage(view) else { resumePage(); loadSelected() }
    }

    fun isOpen(): Boolean = expanded?.parent != null

    fun handleKey(event: KeyEvent): Boolean {
        if (!isOpen()) return false
        if (consentActive && event.keyCode in listOf(KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_PAGE_DOWN, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN)) {
            if (event.action == KeyEvent.ACTION_DOWN) {
                if (event.keyCode in listOf(KeyEvent.KEYCODE_PAGE_UP, KeyEvent.KEYCODE_CHANNEL_UP)) web?.pageUp(false) else web?.pageDown(false)
            }
            return true
        }
        if (consentActive && event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_TAB)) {
            // Consent choices belong to Google's actual page; never preselect or submit one.
            web?.dispatchKeyEvent(event)
            return true
        }
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> { if (event.action == KeyEvent.ACTION_UP) close(); return true }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                if (event.action == KeyEvent.ACTION_DOWN) changePerson(if (event.keyCode == KeyEvent.KEYCODE_DPAD_LEFT) -1 else 1)
                return true
            }
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_CHANNEL_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN) changeZoom(if (event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_CHANNEL_UP)) 1 else -1)
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> return true
        }
        return false
    }

    private fun changePerson(step: Int) {
        if (positions.isEmpty() || consentActive || awaitingConsentReturn) return
        selected = (selected + step + positions.size) % positions.size
        refreshControls(); loadSelected()
    }

    private fun changeZoom(step: Int) { if (consentActive || awaitingConsentReturn) return; val next = (zoom + step).coerceIn(3, 19); if (next != zoom) { zoom = next; loadSelected() } }

    private fun refreshControls() {
        val current = positions.getOrNull(selected)
        caption?.text = if (consentActive) "Google Mapy · potvrzení souhlasu" else current?.let { "${it.name} · ${if (standardPage) "střed mapy" else "jedna poloha na mapě"}" } ?: "Poloha není dostupná"
        pills?.let { row ->
            row.removeAllViews()
            positions.forEachIndexed { index, item ->
                row.addView(button(item.name) { if (!consentActive && !awaitingConsentReturn) { selected = index; refreshControls(); loadSelected() } }.apply {
                    isSelected = index == selected; isEnabled = !consentActive && !awaitingConsentReturn
                },
                    LinearLayout.LayoutParams(-2, v(38)).apply { marginEnd = v(10) })
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildMapBody(frame: FrameLayout, full: Boolean) {
        web?.let { attachMapBody(frame, full, it); return }
        val view = WebView(activity).apply {
            isFocusable = false; isFocusableInTouchMode = false; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            setBackgroundColor(Color.TRANSPARENT)
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = false
                useWideViewPort = true; loadWithOverviewMode = true
                // Request the desktop Maps surface before the first navigation.
                // Changing UA during a load would itself restart Google's document.
                val actualDefault = userAgentString
                val desktop = NativeGoogleMapPolicy.desktopUserAgent(actualDefault)
                userAgentBeforeFlags = NativeGoogleMapPolicy.userAgentFlags(actualDefault)
                if (desktop != null) userAgentString = desktop
                userAgentAfterFlags = NativeGoogleMapPolicy.userAgentFlags(userAgentString)
                desktopUserAgentApplied = desktop != null
                allowFileAccess = false; allowContentAccess = false
                allowFileAccessFromFileURLs = false; allowUniversalAccessFromFileURLs = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false); setGeolocationEnabled(false)
                mediaPlaybackRequiresUserGesture = true; builtInZoomControls = false; displayZoomControls = false
                if (Build.VERSION.SDK_INT >= 26) safeBrowsingEnabled = true
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            val owner = this
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
                override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    // Consume Google's diagnostics without recording URLs, keys or family coordinates.
                    if (message.message().contains("Google Maps JavaScript API error:", ignoreCase = true)) {
                        diagnostic("google_error", NativeGoogleMapPolicy.googleErrorCode(message.message()), currentPageUrl, false)
                    } else {
                        val code = NativeGoogleMapPolicy.consoleErrorCode(message.message())
                        if (code != 0 && owner === web) diagnostic("console_error", code, currentPageUrl, false)
                    }
                    // A late console message is not evidence about the current main document.
                    // Only its epoch-bound DOM probe or main request may change page state.
                    return true
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val raw = request.url.toString()
                    val allowed = view === web && NativeGoogleMapPolicy.navigation(raw)
                    if (allowed && !standardPage && !request.isForMainFrame && NativeGoogleMapPolicy.wrapperPage(currentPageUrl)) {
                        if (NativeGoogleMapPolicy.consentPage(raw)) {
                            clearTimeout(); consentActive = true; awaitingConsentReturn = true
                            refreshControls(); syncConsentFocus(); diagnostic("frame_consent", 0, raw, false)
                        } else if (consentActive && NativeGoogleMapPolicy.embedDocument(raw)) {
                            consentActive = false; refreshControls(); syncConsentFocus(); resumePage()
                        }
                    }
                    if (!allowed) diagnostic("blocked_navigation", 0, raw, request.isForMainFrame)
                    return !allowed
                }
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    val raw = request.url.toString()
                    if (!destroyed && view === web && request.isForMainFrame && request.method == "GET" && NativeGoogleMapPolicy.wrapperPage(raw)) {
                        val body = wrapperHtml
                        if (body != null) {
                            recordResource(raw, request.method, true, true)
                            return WebResourceResponse("text/html", "UTF-8", 200, "OK", mapOf(
                                "Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
                                "Content-Security-Policy" to "default-src 'none'; frame-src https://www.google.com https://maps.google.com https://consent.google.com; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
                            ), ByteArrayInputStream(body))
                        }
                    }
                    val allowed = !destroyed && view === web && when (request.method) {
                        "GET" -> NativeGoogleMapPolicy.resource(raw)
                        "POST" -> NativeGoogleMapPolicy.postResource(raw) || consentActive && NativeGoogleMapPolicy.consentPostResource(raw)
                        "OPTIONS" -> NativeGoogleMapPolicy.preflightResource(raw)
                        else -> false
                    }
                    // Chromium owns compression, CORS, actual redirect URLs, referrers
                    // and origin-scoped Google cookies. No HA/local origin is allowed.
                    recordResource(raw, request.method, request.isForMainFrame, allowed)
                    if (allowed) return null
                    return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
                override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                    if (view !== web || destroyed || !NativeGoogleMapPolicy.navigation(url)) return
                    // The start callback owns this navigation. getUrl() can still
                    // identify the former page while a consent redirect commits.
                    clearTimeout(); val ticket = ++pageEpoch; loadFailed = false
                    val wasConsent = consentActive
                    currentPageUrl = url; consentActive = NativeGoogleMapPolicy.consentPage(url)
                    if (consentActive || wasConsent) awaitingConsentReturn = true
                    refreshControls(); syncConsentFocus()
                    if (!consentActive) { message?.text = "Načítám Google Mapy…"; message?.visibility = View.VISIBLE; armTimeout(view, ticket) }
                    diagnostic("main_start", 0, url, true)
                }
                override fun onPageFinished(view: WebView, url: String?) {
                    if (view === web && !embeddedPaused && NativeGoogleMapPolicy.samePage(currentPageUrl, url) && NativeGoogleMapPolicy.samePage(view.url, url) && !loadFailed) {
                        diagnostic("main_finished", 0, url, true)
                        if (consentActive) {
                            clearTimeout(); syncConsentFocus()
                        } else checkReadiness(view, pageEpoch)
                    }
                }
                override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame || !standardPage && NativeGoogleMapPolicy.embedDocument(request.url.toString())) { diagnostic("web_error", error.errorCode, request.url.toString(), request.isForMainFrame); unavailable(view, request.url.toString()) }
                    else diagnostic("resource_error", error.errorCode, request.url.toString(), false,
                        resourceClass = NativeGoogleMapPolicy.resourceClass(request.url.toString()))
                }
                override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    diagnostic("http_error", response.statusCode, request.url.toString(), request.isForMainFrame)
                    if (response.statusCode >= 400 && (request.isForMainFrame || !standardPage && NativeGoogleMapPolicy.embedDocument(request.url.toString()))) unavailable(view, request.url.toString())
                }
                override fun onReceivedSslError(view: WebView, ssl: SslErrorHandler, error: SslError) { ssl.cancel(); diagnostic("ssl_error", error.primaryError, error.url, true); unavailable(view, error.url) }
            }
        }
        // Try Google's clean embed with the actual desktop engine first. No
        // consumer search/login chrome is silently substituted into a small card.
        web = view; lastUrl = null; currentPageUrl = null; consentActive = false; standardPage = false
        val captionView = label("Google Mapy", if (full) 14f else 12f).apply { setPadding(v(10), v(7), 0, 0) }
        caption = captionView
        val loading = label("Načítám Google Mapy…", 15f).apply { gravity = Gravity.CENTER; setBackgroundColor(if (isDark()) Color.rgb(34, 39, 46) else Color.rgb(237, 241, 246)) }
        message = loading
        attachMapBody(frame, full, view)
    }

    /** Move the native WebView, retaining Google's document, cookies, focus and scroll. */
    private fun attachMapBody(frame: FrameLayout, full: Boolean, view: WebView) {
        val headerHeight = if (full) 30 else 32
        listOfNotNull<View>(view, caption, message).forEach { child -> (child.parent as? ViewGroup)?.removeView(child) }
        frame.addView(view, FrameLayout.LayoutParams(-1, -1).apply { topMargin = v(headerHeight) })
        caption?.let { frame.addView(it, FrameLayout.LayoutParams(-1, v(headerHeight), Gravity.TOP)) }
        message?.let { frame.addView(it, FrameLayout.LayoutParams(-1, -1).apply { topMargin = v(headerHeight) }) }
        if (!full) {
            // The embedded web content cannot take keyboard/touch focus from the native dashboard.
            frame.addView(View(activity).apply { isFocusable = false; setOnClickListener { openExpanded() } }, FrameLayout.LayoutParams(-1, -1))
        }
        refreshControls()
    }

    private fun syncConsentFocus() {
        val view = web ?: return
        val interactive = consentActive && expanded != null
        view.isFocusable = interactive; view.isFocusableInTouchMode = interactive
        view.importantForAccessibility = if (interactive) View.IMPORTANT_FOR_ACCESSIBILITY_YES else View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        if (consentActive) {
            if (interactive) { message?.visibility = View.GONE; view.requestFocus() }
            else { message?.text = "Google Mapy potřebují potvrdit volbu cookies. Otevři mapu."; message?.visibility = View.VISIBLE }
        } else view.clearFocus()
    }

    private fun loadSelected() {
        val view = web ?: return
        if (embeddedPaused || consentActive || awaitingConsentReturn) return
        val position = positions.getOrNull(selected)
        if (position == null) { clearTimeout(); pageEpoch++; view.stopLoading(); lastUrl = null; currentPageUrl = null; consentActive = false; message?.text = "Poloha z Home Assistantu není dostupná."; message?.visibility = View.VISIBLE; return }
        val url = if (standardPage) NativeGoogleMapPolicy.standardMapUrl(position.latitude, position.longitude, zoom)
            else NativeGoogleMapPolicy.mapUrl(position.latitude, position.longitude, zoom)
        if (url == lastUrl) return
        // Maps measures its container during asynchronous initialization. Do not
        // initialize it before the newly attached native panel has a real viewport.
        if (!view.isAttachedToWindow || view.width < 1 || view.height < 1) {
            if (layoutWait == null) {
                layoutWait = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
                    if (view === web && view.isAttachedToWindow && view.width > 0 && view.height > 0) {
                        layoutWait?.let(view::removeOnLayoutChangeListener); layoutWait = null
                        loadSelected()
                    }
                }.also(view::addOnLayoutChangeListener)
            }
            return
        }
        layoutWait?.let(view::removeOnLayoutChangeListener); layoutWait = null
        // Apply only before navigation, never by editing Google's DOM/CSS. The
        // Android initial-scale API uses physical pixels, independently of density.
        // Let overview mode fit the owned 960 CSS px wrapper to the actual TV card.
        view.setInitialScale(0)
        val pageUrl = if (standardPage) url else NativeGoogleMapPolicy.WRAPPER_URL
        wrapperHtml = if (standardPage) null else NativeGoogleMapPolicy.mapWrapperHtml(url).toByteArray(Charsets.UTF_8)
        lastUrl = url; currentPageUrl = pageUrl; consentActive = false; loadFailed = false; clearTimeout(); resetDiagnostics()
        message?.text = "Načítám Google Mapy…"; message?.visibility = View.VISIBLE
        val ticket = ++pageEpoch
        diagnostic("load", 0, pageUrl, true); view.loadUrl(pageUrl)
        armTimeout(view, ticket)
    }

    private fun armTimeout(view: WebView, ticket: Long) {
        if (view !== web || ticket != pageEpoch || consentActive || embeddedPaused || destroyed) return
        timeout?.let(handler::removeCallbacks); timeout = null
        timeout = Runnable { if (view === web && ticket == pageEpoch && !consentActive && !embeddedPaused) { diagnostic("timeout", 0, currentPageUrl, true); unavailable(view, currentPageUrl) } }.also { handler.postDelayed(it, 20000) }
    }

    private fun resumePage() {
        val view = web ?: return
        if (embeddedPaused || destroyed) return
        if (consentActive) { syncConsentFocus(); return }
        if (loadFailed || lastUrl == null || !NativeGoogleMapPolicy.navigation(currentPageUrl)) return
        clearTimeout(); val ticket = ++pageEpoch
        armTimeout(view, ticket); checkReadiness(view, ticket)
    }

    /** Read-only geometry/resource counts; no page text, coordinates, URLs or JS bridge. */
    private fun checkReadiness(view: WebView, ticket: Long) {
        readiness?.let(handler::removeCallbacks)
        val task = Runnable {
            if (view !== web || ticket != pageEpoch || destroyed || embeddedPaused || loadFailed || consentActive) return@Runnable
            view.evaluateJavascript(if (standardPage) NativeGoogleMapPolicy.readinessScript() else NativeGoogleMapPolicy.wrapperReadinessScript()) { raw ->
                if (view !== web || ticket != pageEpoch || destroyed || embeddedPaused || loadFailed || consentActive) return@evaluateJavascript
                val result = runCatching { JSONArray(raw) }.getOrNull()
                val flags = result?.optInt(0, 0) ?: 0
                val dom = IntArray(9) { index -> (result?.optInt(index + 3, 0) ?: 0).coerceIn(0, 4095) }
                diagnostic("map_probe", flags, currentPageUrl, true, view.width, view.height,
                    (result?.optInt(1, 0) ?: 0).coerceIn(0, 8192), (result?.optInt(2, 0) ?: 0).coerceIn(0, 8192), dom = dom)
                if (flags and 16 != 0) unavailable(view, currentPageUrl)
                else if (flags and 64 != 0 || flags and 15 == 15) {
                    clearTimeout(); awaitingConsentReturn = false; message?.visibility = View.GONE
                    diagnostic(if (flags and 64 != 0) "frame_loaded" else "map_ready", flags, currentPageUrl, true)
                    deferredPositions?.let { updated -> deferredPositions = null; replacePositions(updated); refreshControls(); loadSelected() }
                    syncConsentFocus()
                }
                else checkReadiness(view, ticket)
            }
        }
        readiness = task; handler.postDelayed(task, 750)
    }

    @Synchronized private fun resetDiagnostics() {
        diagnostics = 0; allowedResources = 0; blockedResources = 0; blockedClasses.clear()
        if (BuildConfig.DEBUG && diagnostics++ < 64) Log.d("HomeTVMap", "stage=user_agent beforeFlags=$userAgentBeforeFlags afterFlags=$userAgentAfterFlags applied=${if (desktopUserAgentApplied) 1 else 0}")
    }
    @Synchronized private fun recordResource(url: String, method: String, mainFrame: Boolean, allowed: Boolean) {
        if (allowed) { allowedResources = (allowedResources + 1).coerceAtMost(4095); return }
        blockedResources = (blockedResources + 1).coerceAtMost(4095)
        val hostClass = NativeGoogleMapPolicy.hostClass(url)
        val resourceClass = NativeGoogleMapPolicy.resourceClass(url)
        val methodClass = when (method) { "GET" -> 1; "POST" -> 2; "OPTIONS" -> 3; else -> 9 }
        val reason = NativeGoogleMapPolicy.blockedReason(url, method, consentActive)
        val key = hostClass * 1000 + resourceClass * 100 + methodClass * 10 + reason
        if (blockedClasses.size < 16 && blockedClasses.add(key)) diagnostic("blocked_resource", 403, url, mainFrame,
            resourceClass = resourceClass, methodClass = methodClass, reason = reason)
    }
    @Synchronized private fun diagnostic(stage: String, code: Int, url: String?, mainFrame: Boolean, viewWidth: Int = -1, viewHeight: Int = -1,
        mapWidth: Int = -1, mapHeight: Int = -1, resourceClass: Int = 0, methodClass: Int = 0, reason: Int = 0, dom: IntArray? = null) {
        if (BuildConfig.DEBUG && diagnostics++ < 64) {
            val counts = dom?.let { " domState=${it[0]} bodyChildren=${it[1]} images=${it[2]} loadedImages=${it[3]} canvases=${it[4]} scripts=${it[5]} iframes=${it[6]} resourceCount=${it[7]} probeError=${it[8]}" } ?: ""
            Log.d("HomeTVMap", "stage=$stage mode=${if (standardPage) 1 else 0} code=$code hostClass=${NativeGoogleMapPolicy.hostClass(url)} main=${if (mainFrame) 1 else 0} viewWidth=$viewWidth viewHeight=$viewHeight mapWidth=$mapWidth mapHeight=$mapHeight resourceClass=$resourceClass methodClass=$methodClass reason=$reason allowedRequests=$allowedResources blockedRequests=$blockedResources$counts")
        }
    }

    private fun useStandardPage(view: WebView) {
        if (view !== web || standardPage || destroyed || expanded == null) return
        diagnostic("fallback", 0, currentPageUrl, true)
        clearTimeout(); pageEpoch++; consentActive = false; awaitingConsentReturn = false; loadFailed = false
        standardPage = true; lastUrl = null; refreshControls(); syncConsentFocus(); loadSelected()
    }

    private fun unavailable(view: WebView, requestedUrl: String?) { ui { if (view === web && (NativeGoogleMapPolicy.samePage(currentPageUrl, requestedUrl) ||
        !standardPage && NativeGoogleMapPolicy.wrapperPage(currentPageUrl) && NativeGoogleMapPolicy.embedDocument(requestedUrl))) {
        if (!standardPage && expanded != null) { useStandardPage(view); return@ui }
        loadFailed = true; awaitingConsentReturn = false; consentActive = false; clearTimeout()
        deferredPositions?.let { replacePositions(it); deferredPositions = null }; refreshControls(); syncConsentFocus()
        message?.text = if (!standardPage) "Mapu se nepodařilo načíst. Otevřít mapu · OK" else "Google Mapy se nepodařilo načíst. Zkus znovu změnit osobu nebo přiblížení."
        message?.visibility = View.VISIBLE
    } } }
    private fun clearTimeout() { timeout?.let(handler::removeCallbacks); timeout = null; readiness?.let(handler::removeCallbacks); readiness = null }
    private fun disposeWeb() {
        cancelEmbeddedDisposal(); embeddedPaused = false
        clearTimeout(); pageEpoch++; consentActive = false; awaitingConsentReturn = false
        web?.let { view -> layoutWait?.let(view::removeOnLayoutChangeListener); view.stopLoading(); view.onPause(); (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
        layoutWait = null
        web = null; caption = null; message = null; lastUrl = null; currentPageUrl = null; wrapperHtml = null
        deferredPositions?.let { replacePositions(it); deferredPositions = null }
    }
    private fun cancelEmbeddedDisposal() { embeddedGeneration++; embeddedDisposal?.let(handler::removeCallbacks); embeddedDisposal = null }
    private fun hideEmbedded() {
        val frame = embedded ?: return
        if (embeddedPaused) return
        embeddedPaused = true; frame.visibility = View.GONE
        clearTimeout(); pageEpoch++; web?.onPause()
        cancelEmbeddedDisposal(); val generation = embeddedGeneration; val view = web
        embeddedDisposal = Runnable {
            if (generation == embeddedGeneration && embeddedPaused && expanded == null && frame === embedded && view === web) removeEmbedded()
        }.also { handler.postDelayed(it, 30000) }
    }
    private fun removeEmbedded(preserveMap: Boolean = false) {
        cancelEmbeddedDisposal(); embeddedPaused = false
        if (!preserveMap) disposeWeb()
        embedded?.let { (it.parent as? ViewGroup)?.removeView(it) }; embedded = null
    }
    fun close() = ui {
        val wasExpanded = expanded != null
        disposeWeb(); expanded?.let { (it.parent as? ViewGroup)?.removeView(it) }; expanded = null; pills = null
        embedded?.let { (it.parent as? ViewGroup)?.removeView(it) }; embedded = null
        if (wasExpanded) onClosed()
    }
    fun onPause() = close()
    fun onDestroy() = ui { destroyed = true; close(); positions = emptyList(); embeddedBounds = null }
    private fun ui(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else activity.runOnUiThread(action) }
    private fun v(value: Int) = (value * scale).roundToInt()
    private fun ink() = if (isDark()) Color.rgb(245, 246, 249) else Color.rgb(28, 30, 35)
    private fun shape(fill: Int, radius: Float) = GradientDrawable().apply { setColor(fill); cornerRadius = radius * scale }
    private fun label(value: String, size: Float) = TextView(activity).apply { text = value; includeFontPadding = false; setTextSize(TypedValue.COMPLEX_UNIT_PX, size * scale); setTextColor(ink()) }
    private fun button(value: String, action: () -> Unit) = Button(activity).apply {
        text = value; isAllCaps = false; isFocusable = false; includeFontPadding = false; minHeight = 0; minWidth = 0
        setTextColor(ink()); setTextSize(TypedValue.COMPLEX_UNIT_PX, 14f * scale); setPadding(v(16), v(7), v(16), v(7))
        background = android.graphics.drawable.StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_selected), shape(if (isDark()) Color.rgb(82, 95, 112) else Color.WHITE, 19f))
            addState(intArrayOf(), shape(if (isDark()) Color.argb(90, 105, 114, 128) else Color.argb(150, 221, 227, 235), 19f))
        }
        setOnClickListener { action() }
    }
}
