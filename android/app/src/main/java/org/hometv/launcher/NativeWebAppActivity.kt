package org.hometv.launcher

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout

/** Explicitly opened local miniapps only. The launcher never instantiates this WebView. */
class NativeWebAppActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var cursor: Cursor
    private var mouse = true
    private var px = 600f
    private var py = 300f
    private val origin = Uri.parse(BuildConfig.DASHBOARD_URL)

    private fun allowed(uri: Uri): Boolean = uri.scheme == origin.scheme && uri.host == origin.host &&
        uri.port == origin.port && uri.userInfo == null && uri.fragment == null &&
        uri.path.orEmpty().startsWith("/apps/") && !uri.path.orEmpty().contains("..")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val target = Uri.parse(intent.getStringExtra("url") ?: "")
        if (!allowed(target)) { finish(); return }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        val root = FrameLayout(this)
        web = WebView(this).apply {
            setBackgroundColor(Color.rgb(20, 24, 32))
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = true
                useWideViewPort = true; loadWithOverviewMode = true
                mediaPlaybackRequiresUserGesture = true
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                allowFileAccess = false; allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false); setSupportZoom(false)
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !allowed(request.url)
            }
        }
        root.addView(web, FrameLayout.LayoutParams(-1, -1))
        cursor = Cursor()
        root.addView(cursor, FrameLayout.LayoutParams(-1, -1))
        setContentView(root)
        web.loadUrl(target.toString())
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.action == KeyEvent.ACTION_UP) finish()
            return true
        }
        if (event.keyCode == KeyEvent.KEYCODE_MENU) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) { mouse = !mouse; cursor.visibility = if (mouse) View.VISIBLE else View.GONE }
            return true
        }
        if (!mouse) return super.dispatchKeyEvent(event)
        val arrows = event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN)
        val select = event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER)
        if (arrows && event.action == KeyEvent.ACTION_DOWN) {
            val step = (if (event.repeatCount > 5) 32f else 16f) * resources.displayMetrics.density
            when (event.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> px -= step
                KeyEvent.KEYCODE_DPAD_RIGHT -> px += step
                KeyEvent.KEYCODE_DPAD_UP -> py -= step
                KeyEvent.KEYCODE_DPAD_DOWN -> py += step
            }
            px = px.coerceIn(1f, (web.width - 1).coerceAtLeast(1).toFloat())
            py = py.coerceIn(1f, (web.height - 1).coerceAtLeast(1).toFloat())
            val move = MotionEvent.obtain(SystemClock.uptimeMillis(), SystemClock.uptimeMillis(), MotionEvent.ACTION_HOVER_MOVE, px, py, 0)
            web.dispatchGenericMotionEvent(move); move.recycle(); cursor.invalidate()
        }
        if (select && event.action == KeyEvent.ACTION_UP) {
            val now = SystemClock.uptimeMillis()
            listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP).forEach { action ->
                val click = MotionEvent.obtain(now, now, action, px, py, 0)
                web.dispatchTouchEvent(click); click.recycle()
            }
        }
        if (event.keyCode in listOf(KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_CHANNEL_DOWN)) {
            if (event.action == KeyEvent.ACTION_DOWN) web.scrollBy(0, if (event.keyCode == KeyEvent.KEYCODE_CHANNEL_UP) -160 else 160)
            return true
        }
        return arrows || select || super.dispatchKeyEvent(event)
    }

    override fun onPause() { web.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); if (::web.isInitialized) web.onResume() }
    override fun onDestroy() { if (::web.isInitialized) { web.stopLoading(); web.destroy() }; super.onDestroy() }

    private inner class Cursor : View(this@NativeWebAppActivity) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        override fun onDraw(canvas: Canvas) {
            paint.color = Color.argb(60, 0, 0, 0); canvas.drawCircle(px + 2, py + 3, 10f, paint)
            paint.color = Color.WHITE; canvas.drawCircle(px, py, 7f, paint)
            paint.color = Color.rgb(55, 60, 70); canvas.drawCircle(px, py, 2.5f, paint)
        }
    }
}
