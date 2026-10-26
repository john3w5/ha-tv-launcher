package org.hometv.launcher

import android.app.Activity
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.Outline
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.ViewOutlineProvider
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.video.VideoFrameMetadataListener
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import kotlin.math.roundToInt

/** One native player in the dashboard's own window. Coordinates share the Canvas's 1440px design space. */
class NativeMediaController(
    private val activity: Activity,
    private val baseUrl: String,
    private val requestStream: (String, String, (Result<String>) -> Unit) -> Unit,
    private val cancelStreamRequest: (() -> Unit)? = null,
    private val isDark: () -> Boolean = { true },
    private val onClosed: (() -> Unit)? = null,
    private val cameraPoster: ((String) -> Bitmap?)? = null,
) {
    private data class Source(val ticket: Long, val uri: URI, val cookie: String?, val audio: Boolean, val camera: Boolean, val hls: Boolean)
    private val handler = Handler(Looper.getMainLooper())
    private val policy = NativeMediaPolicy()
    private val recoveryPolicy = NativeCameraRecoveryPolicy()
    private val scale get() = activity.resources.displayMetrics.widthPixels / 1440f
    private var overlay: FrameLayout? = null
    private var videoSurface: SurfaceView? = null
    private var videoFrame: FrameLayout? = null
    private var poster: ImageView? = null
    private var posterBitmap: Bitmap? = null
    private var player: ExoPlayer? = null
    private var playerTicket = -1L
    private var source: Source? = null
    private var status: TextView? = null
    private var spinner: ProgressBar? = null
    private var retryButton: Button? = null
    private var pauseButton: Button? = null
    private val buttons = ArrayList<Button>()
    private var cameraId: String? = null
    private var quality = "smooth"
    private var destroyed = false
    private var timeout: Runnable? = null
    private var videoWidth = 0
    private var videoHeight = 0
    private var rendered = false
    private var selectDown = false
    private var debugLines = 0
    private var lastDebugAt = 0L
    private var metrics: Runnable? = null
    private var recovery: Runnable? = null
    private var recoveryGeneration = 0L
    private val submissionLock = Any()
    @Volatile private var submissionEpoch = 0L
    @Volatile private var submissionExpected = false
    private var submittedFrames = 0L
    private var lastSubmissionAtNs = 0L
    private var lastReleaseNs = 0L
    private var lastPresentationUs = -1L
    private var maxSubmittedGapNs = 0L
    private var maxMetadataGapNs = 0L
    private var submittedGapOver500Ms = 0L
    private var submittedGapOver1000Ms = 0L

    fun isOpen(): Boolean = overlay?.parent != null

    fun openCamera(id: String, name: String, quality: String = "smooth"): Unit = ui {
        if (!usable() || !NativeMediaPolicy.cameraId(id) || !NativeMediaPolicy.quality(quality)) return@ui
        closeNow(false)
        debugLines = 0
        recoveryPolicy.resetAll(SystemClock.elapsedRealtime())
        cameraId = id; this.quality = quality
        buildOverlay(name.take(100), true) { beginCamera() }
        beginCamera()
    }

    fun openMedia(url: String, type: String, title: String = "Přehrávání"): Unit = ui {
        if (!usable()) return@ui
        val uri = runCatching { NativeMediaPolicy.mediaUrl(baseUrl, url) }.getOrNull()
        val kind = NativeMediaPolicy.mediaKind(type)
        if (uri == null || kind == null) { message("Toto médium nelze otevřít."); return@ui }
        val own = NativeMediaPolicy.sameOrigin(baseUrl, uri)
        val cookie = if (own) sessionCookie() else null
        if (own && cookie == null) { message("Televize není připojená k domácímu mostu."); return@ui }
        closeNow(false)
        buildOverlay(title.take(160), false, audio = kind == "audio") { openMedia(url, type, title) }
        val ticket = policy.begin()
        setLoading(ticket, "Připojuji médium…")
        val hls = type.equals("hls", true) || type.substringBefore(';').lowercase() in listOf("application/vnd.apple.mpegurl", "application/x-mpegurl") || uri.path.orEmpty().endsWith(".m3u8", true)
        queueSource(Source(ticket, uri, cookie, kind == "audio", false, hls))
    }

    /** MainActivity routes keys here before its dashboard Canvas while the player is open. */
    fun handleKey(event: KeyEvent): Boolean {
        if (!isOpen()) return false
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> { if (event.action == KeyEvent.ACTION_UP) close(); return true }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN && !event.isCanceled) {
                    val choices = buttons.filter { it.isEnabled && it.visibility == View.VISIBLE }
                    val current = choices.indexOfFirst { it.hasFocus() }
                    val step = if (event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP)) -1 else 1
                    if (choices.isNotEmpty()) choices[if (current < 0) 0 else (current + step + choices.size) % choices.size].requestFocus()
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) selectDown = true
                if (event.action == KeyEvent.ACTION_UP) {
                    if (selectDown && !event.isCanceled) buttons.firstOrNull { it.hasFocus() && it.isEnabled && it.visibility == View.VISIBLE }?.performClick()
                    selectDown = false
                }
                return true
            }
        }
        return false
    }

    private fun buildOverlay(title: String, camera: Boolean, audio: Boolean = false, retry: () -> Unit) {
        val host = activity.findViewById<ViewGroup>(android.R.id.content)
        val cover = FrameLayout(activity).apply {
            setBackgroundColor(Color.argb(if (isDark()) 95 else 55, 0, 0, 0))
            isClickable = true; isFocusable = true
        }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(v(24), v(18), v(24), v(18))
            background = shape(if (isDark()) Color.argb(248, 35, 38, 45) else Color.argb(248, 241, 243, 246), 26f)
        }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(activity).apply { text = title; font(this, 22f); setTextColor(ink()) }, LinearLayout.LayoutParams(0, -2, 1f))
        if (camera) {
            for ((id, label) in listOf("smooth" to "Plynulé", "hd" to "HD")) {
                val choice = button(label) {
                    if (quality != id) { quality = id; beginCamera() }
                    buttons.forEach { it.isSelected = it.tag == quality }
                }.apply { tag = id; isSelected = id == quality }
                header.addView(choice, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = v(8) })
            }
        }
        header.addView(button("Zavřít") { close() }); body.addView(header)
        val frame = FrameLayout(activity).apply { background = shape(Color.BLACK, 18f); clipToOutline = true }
        val video = if (audio) null else object : SurfaceView(activity) {
            override fun onVisibilityAggregated(isVisible: Boolean) {
                super.onVisibilityAggregated(isVisible)
                if (!isVisible) { submissionExpected = false; resetSubmissionContinuity() }
                else updateSubmissionExpectation()
            }
        }.apply {
            isFocusable = false; holder.setFormat(PixelFormat.OPAQUE)
            if (Build.VERSION.SDK_INT >= 34) setSurfaceLifecycle(SurfaceView.SURFACE_LIFECYCLE_FOLLOWS_ATTACHMENT)
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, v(18).toFloat()) }
            }
        }
        if (video != null) frame.addView(video, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
        val still = ImageView(activity).apply { scaleType = ImageView.ScaleType.FIT_CENTER; setBackgroundColor(Color.BLACK); visibility = View.VISIBLE; isFocusable = false }
        frame.addView(still, FrameLayout.LayoutParams(-1, -1))
        val waiting = ProgressBar(activity)
        frame.addView(waiting, FrameLayout.LayoutParams(v(36), v(36), Gravity.CENTER))
        body.addView(frame, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = v(14); bottomMargin = v(12) })
        val footer = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        val line = TextView(activity).apply { font(this, 14f); setTextColor(mutedInk()) }
        footer.addView(line, LinearLayout.LayoutParams(0, -2, 1f))
        if (!camera) {
            val pause = button("Pozastavit") {
                player?.let { media -> runCatching {
                    if (media.playWhenReady) { media.pause(); pauseButton?.text = "Pokračovat"; status?.text = "Pozastaveno" }
                    else { media.play(); pauseButton?.text = "Pozastavit"; status?.text = "Přehrávač spuštěn" }
                } }
            }.apply { isEnabled = false }
            footer.addView(pause, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = v(8) }); pauseButton = pause
        }
        val retryView = button(if (camera) "Zkusit znovu" else "Přehrát znovu", retry).apply { visibility = View.GONE }
        footer.addView(retryView); body.addView(footer)
        cover.addView(body, FrameLayout.LayoutParams(-1, -1).apply { setMargins(v(22), v(22), v(22), v(22)) })
        overlay = cover; videoSurface = video; videoFrame = frame; poster = still; status = line; spinner = waiting; retryButton = retryView
        frame.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitVideo() }
        host.addView(cover, ViewGroup.LayoutParams(-1, -1))
        buttons.firstOrNull { it.isEnabled && it.visibility == View.VISIBLE }?.requestFocus()
    }

    private fun beginCamera() {
        val id = cameraId ?: return
        stopPlayback()
        val ticket = policy.begin()
        setLoading(ticket, "Připojuji ${if (quality == "hd") "HD" else "plynulý"} obraz…")
        try { requestStream(id, quality) { result -> ui callback@{
            if (!policy.current(ticket) || !isOpen()) return@callback
            val uri = runCatching { NativeMediaPolicy.streamUrl(baseUrl, result.getOrNull()) }.getOrNull()
            val cookie = sessionCookie()
            debug("stage=stream_response accepted=${uri != null} authenticated=${cookie != null} shape=${if (uri?.path?.endsWith(".m3u8") == true) "opaque_hls_alias" else "opaque_or_invalid"}")
            if (uri == null || cookie == null) { fail(ticket, if (cookie == null) "Televize není připojená k domácímu mostu." else "Živý obraz teď není dostupný."); return@callback }
            queueSource(Source(ticket, uri, cookie, false, true, true))
        } } } catch (_: Exception) { fail(ticket, "Živý obraz teď není dostupný.") }
    }

    private fun setLoading(ticket: Long, text: String) {
        rendered = false; status?.text = text; spinner?.visibility = View.VISIBLE; retryButton?.visibility = View.GONE; pauseButton?.isEnabled = false
        if (cameraId == null || !showPoster()) showShutter()
        val timer = Runnable { if (policy.current(ticket)) { debug("stage=timeout"); fail(ticket, "Médium se nepodařilo načíst. Zkus připojení znovu.") } }
        timeout = timer; handler.postDelayed(timer, 40000)
    }

    private fun queueSource(next: Source) { if (policy.current(next.ticket)) { source = next; preparePlayer(next) } }

    private fun preparePlayer(next: Source) {
        if (!policy.current(next.ticket) || !isOpen()) return
        if (player != null && playerTicket == next.ticket) return
        val target = videoSurface
        if (!next.audio && target == null) return
        releasePlayer()
        try {
            val factory = DataSource.Factory { NativeMediaDataSource(baseUrl, next.cookie, next.camera) }
            val loadControl = DefaultLoadControl.Builder().setBufferDurationsMs(1500, 8000, 500, 1000).setPrioritizeTimeOverSizeThresholds(true).build()
            val media = ExoPlayer.Builder(activity).setLoadControl(loadControl).setMediaSourceFactory(DefaultMediaSourceFactory(factory)).build()
            player = media; playerTicket = next.ticket
            // Media3 owns the holder callbacks, including a surface that appears after prepare.
            // We prepare once per ticket and never create a second decoder from a holder callback.
            if (!next.audio) media.setVideoSurfaceView(target)
            val epoch = submissionEpoch
            if (!next.audio) media.setVideoFrameMetadataListener(VideoFrameMetadataListener { presentationTimeUs, releaseTimeNs, _, _ ->
                recordSubmittedFrame(epoch, presentationTimeUs, releaseTimeNs)
            })
            media.setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(if (next.audio) C.AUDIO_CONTENT_TYPE_MUSIC else C.AUDIO_CONTENT_TYPE_MOVIE).build(), !next.camera)
            media.volume = if (next.camera) 0f else 1f
            media.addListener(object : Player.Listener {
                private var prepared = false
                private fun current() = policy.current(next.ticket) && player === media
                override fun onPlaybackStateChanged(state: Int) {
                    if (!current()) return
                    debug("stage=playback state=$state")
                    if (state == Player.STATE_READY) {
                        if (!prepared) { prepared = true; debug("stage=prepared audio=${next.audio}") }
                        pauseButton?.isEnabled = true
                        if (next.audio) markRendered(next)
                    } else if (state == Player.STATE_ENDED) {
                        stopPlayback(); spinner?.visibility = View.GONE; status?.text = "Přenos skončil"; retryButton?.visibility = View.VISIBLE
                    }
                    updateSubmissionExpectation()
                }
                override fun onVideoSizeChanged(size: VideoSize) {
                    if (!current()) return
                    videoWidth = (size.width * size.pixelWidthHeightRatio).roundToInt(); videoHeight = size.height; fitVideo()
                }
                override fun onRenderedFirstFrame() { if (current()) { debug("stage=rendering"); markRendered(next) } }
                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                    if (current()) updateSubmissionExpectation()
                }
                override fun onPlayerError(error: PlaybackException) {
                    if (!current()) return
                    debug("stage=error code=${error.errorCode}")
                    fail(next.ticket, "Živý obraz nebo médium nelze přehrát. Zkus připojení znovu.")
                }
            })
            val item = MediaItem.Builder().setUri(Uri.parse(next.uri.toString())).apply {
                if (next.hls) setMimeType(MimeTypes.APPLICATION_M3U8)
                if (next.camera) setLiveConfiguration(MediaItem.LiveConfiguration.Builder().setTargetOffsetMs(2500).setMinPlaybackSpeed(0.97f).setMaxPlaybackSpeed(1.03f).build())
            }.build()
            if (next.hls) media.setMediaSource(HlsMediaSource.Factory(factory).createMediaSource(item)) else media.setMediaItem(item)
            media.playWhenReady = true; media.prepare()
            startMetrics(next, media)
        } catch (_: Exception) { debug("stage=data_source_error"); fail(next.ticket, "Médium nelze načíst.") }
    }

    private fun startMetrics(next: Source, media: ExoPlayer) {
        var samples = 0
        var nextSampleAt = SystemClock.elapsedRealtime() + 10000
        recoveryPolicy.resetProgress(SystemClock.elapsedRealtime())
        val task = object : Runnable {
            override fun run() {
                if (!policy.current(next.ticket) || player !== media) return
                val now = SystemClock.elapsedRealtime()
                updateSubmissionExpectation()
                val counters = media.videoDecoderCounters
                counters?.let { count ->
                    count.ensureUpdated()
                    val expected = rendered && media.playWhenReady && media.playbackState in listOf(Player.STATE_READY, Player.STATE_BUFFERING)
                    if (next.camera && recoveryPolicy.observe(now, count.renderedOutputBufferCount.toLong(), expected)) {
                        debug("stage=stalled state=${media.playbackState} rendered=${count.renderedOutputBufferCount} positionMs=${media.currentPosition.coerceAtLeast(0)}")
                        recoverCamera(next); return
                    }
                    if (samples < 12 && now >= nextSampleAt) {
                        samples++; nextSampleAt = now + 10000
                        val offset = media.currentLiveOffset.takeUnless { it == C.TIME_UNSET } ?: -1
                        val formatRate = media.videoFormat?.frameRate?.takeIf { it.isFinite() && it > 0f }?.toDouble() ?: -1.0
                        debug("stage=sample state=${media.playbackState} rendered=${count.renderedOutputBufferCount} skipped=${count.skippedOutputBufferCount} skippedInput=${count.skippedInputBufferCount} dropped=${count.droppedBufferCount} bufferedMs=${media.totalBufferedDuration.coerceIn(0, 120000)} positionMs=${media.currentPosition.coerceAtLeast(0)} liveOffsetMs=$offset ${submissionFields()} formatFrameRate=$formatRate")
                    }
                }
                handler.postDelayed(this, 1000)
            }
        }
        metrics = task; handler.postDelayed(task, 1000)
    }

    private fun recoverCamera(next: Source) {
        if (!next.camera || !policy.current(next.ticket)) return
        val delay = recoveryPolicy.reserveRetry(SystemClock.elapsedRealtime())
        val oldOverlay = overlay; val id = cameraId; val oldQuality = quality
        stopPlayback()
        val hasPoster = showPoster()
        if (!hasPoster) showShutter()
        status?.text = if (delay < 0) {
            if (hasPoster) "Snímek · živý přenos se zastavil. Zkus připojení znovu." else "Živý přenos se zastavil. Zkus připojení znovu."
        } else if (hasPoster) "Snímek · obnovuji přerušený živý přenos…" else "Živý přenos se přerušil · obnovuji spojení…"
        spinner?.visibility = if (delay < 0) View.GONE else View.VISIBLE
        retryButton?.visibility = if (delay < 0) View.VISIBLE else View.GONE
        if (delay < 0) { debug("stage=recovery_exhausted"); return }
        val generation = recoveryGeneration
        val task = Runnable {
            if (generation == recoveryGeneration && overlay === oldOverlay && isOpen() && cameraId == id && quality == oldQuality && usable()) beginCamera()
        }
        recovery = task; handler.postDelayed(task, delay)
    }

    private fun showPoster(): Boolean {
        val id = cameraId ?: return false
        clearPoster()
        val cached = runCatching { cameraPoster?.invoke(id) }.getOrNull()
        if (cached == null || cached.isRecycled || cached.width.toLong() * cached.height > 4_000_000) return false
        val owned = runCatching { cached.copy(Bitmap.Config.ARGB_8888, false) }.getOrNull() ?: return false
        posterBitmap = owned; poster?.setImageBitmap(owned); poster?.visibility = View.VISIBLE
        return true
    }

    private fun clearPoster() {
        poster?.setImageDrawable(null); poster?.visibility = View.GONE
        posterBitmap?.let { if (!it.isRecycled) it.recycle() }; posterBitmap = null
    }

    private fun showShutter() {
        clearPoster()
        poster?.visibility = View.VISIBLE
    }

    private fun markRendered(next: Source) {
        if (!policy.current(next.ticket) || rendered) return
        rendered = true; timeout?.let(handler::removeCallbacks); timeout = null; spinner?.visibility = View.GONE
        clearPoster(); updateSubmissionExpectation()
        status?.text = if (next.camera) "Živý obraz · ${if (quality == "hd") "HD" else "Plynulé"} · bez zvuku" else if (next.audio) "Zvuk · přehrávač spuštěn" else "Přehrávání videa"
    }

    private fun fitVideo() {
        val view = videoSurface ?: return
        val frame = videoFrame ?: return
        if (frame.width <= 0 || frame.height <= 0 || videoWidth <= 0 || videoHeight <= 0) return
        val frameAspect = frame.width.toFloat() / frame.height; val videoAspect = videoWidth.toFloat() / videoHeight
        val width = if (videoAspect < frameAspect) (frame.height * videoAspect).roundToInt().coerceAtLeast(1) else frame.width
        val height = if (videoAspect > frameAspect) (frame.width / videoAspect).roundToInt().coerceAtLeast(1) else frame.height
        val previous = view.layoutParams as? FrameLayout.LayoutParams
        if (previous == null || previous.width != width || previous.height != height || previous.gravity != Gravity.CENTER)
            view.layoutParams = FrameLayout.LayoutParams(width, height, Gravity.CENTER)
    }

    private fun fail(ticket: Long, message: String) {
        if (!policy.current(ticket)) return
        stopPlayback()
        val hasPoster = showPoster()
        if (!hasPoster) showShutter()
        spinner?.visibility = View.GONE; status?.text = if (hasPoster) "Snímek · $message" else message; retryButton?.visibility = View.VISIBLE
    }
    private fun releasePlayer() {
        metrics?.let(handler::removeCallbacks); metrics = null
        resetSubmissions()
        val old = player; player = null; playerTicket = -1L
        old?.let { runCatching { it.clearVideoSurface(); it.release() } }
        videoWidth = 0; videoHeight = 0
    }
    private fun stopPlayback() {
        recoveryGeneration++; recovery?.let(handler::removeCallbacks); recovery = null
        policy.end(); timeout?.let(handler::removeCallbacks); timeout = null; source = null
        runCatching { cancelStreamRequest?.invoke() }; releasePlayer(); pauseButton?.isEnabled = false
    }
    fun close(): Unit = ui { closeNow(true) }
    fun onPause(): Unit = ui { closeNow(false) }
    fun onDestroy(): Unit = ui { destroyed = true; closeNow(false); handler.removeCallbacksAndMessages(null) }
    private fun closeNow(notify: Boolean) {
        val old = overlay; stopPlayback()
        clearPoster()
        overlay = null; videoSurface = null; videoFrame = null; poster = null; status = null; spinner = null; retryButton = null; pauseButton = null; cameraId = null; selectDown = false; buttons.clear()
        if (old != null) (old.parent as? ViewGroup)?.removeView(old)
        if (notify && old != null) onClosed?.invoke()
    }
    private fun usable() = !destroyed && !activity.isFinishing && !activity.isDestroyed
    private fun sessionCookie() = OverlayProtocol.sessionCookie(CookieManager.getInstance().getCookie(baseUrl))
    private fun ui(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else handler.post { action() } }
    private fun v(value: Int) = (value * scale).roundToInt()
    private fun font(view: TextView, value: Float) { view.setTextSize(TypedValue.COMPLEX_UNIT_PX, value * scale); view.includeFontPadding = false }
    private fun ink() = if (isDark()) Color.rgb(246, 247, 250) else Color.rgb(36, 40, 47)
    private fun mutedInk() = if (isDark()) Color.rgb(195, 199, 208) else Color.rgb(91, 98, 110)
    private fun shape(fill: Int, radius: Float = 20f) = GradientDrawable().apply { setColor(fill); cornerRadius = radius * scale }
    private fun button(label: String, action: () -> Unit): Button = Button(activity).apply {
        text = label; isAllCaps = false; font(this, 14f); setTextColor(ink()); setPadding(v(16), v(8), v(16), v(8))
        minHeight = v(38); minimumHeight = v(38); minWidth = v(74); minimumWidth = v(74)
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(if (isDark()) Color.rgb(73, 78, 88) else Color.rgb(217, 223, 232)))
            addState(intArrayOf(android.R.attr.state_selected), shape(if (isDark()) Color.rgb(61, 66, 76) else Color.rgb(221, 227, 236)))
            addState(intArrayOf(), shape(if (isDark()) Color.rgb(48, 52, 60) else Color.rgb(231, 234, 239)))
        }
        stateListAnimator = null
        if (Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
        setOnClickListener { action() }; buttons.add(this)
    }
    private fun message(text: String) { Toast.makeText(activity, text, Toast.LENGTH_SHORT).show() }
    /** Called only on the application thread. The playback-thread listener reads the volatile result. */
    private fun updateSubmissionExpectation() {
        val view = videoSurface
        val media = player
        val state = media?.playbackState
        submissionExpected = rendered && media?.playWhenReady == true && (state == Player.STATE_READY || state == Player.STATE_BUFFERING) &&
            isOpen() && view != null && view.isAttachedToWindow && view.isShown && view.windowVisibility == View.VISIBLE && view.holder.surface.isValid
        if (!submissionExpected) resetSubmissionContinuity()
    }
    /** Metadata means submitted/scheduled video, not proof of physical display. No per-frame allocation/log. */
    private fun recordSubmittedFrame(epoch: Long, presentationTimeUs: Long, releaseTimeNs: Long) {
        if (!submissionExpected || epoch != submissionEpoch) return
        val now = System.nanoTime() // Same monotonic timebase as Media3 releaseTimeNs.
        synchronized(submissionLock) {
            if (!submissionExpected || epoch != submissionEpoch) return
            if (lastSubmissionAtNs != 0L) maxMetadataGapNs = maxOf(maxMetadataGapNs, (now - lastSubmissionAtNs).coerceAtLeast(0))
            if (releaseTimeNs != C.TIME_UNSET && lastReleaseNs != 0L && releaseTimeNs > lastReleaseNs) {
                val gap = releaseTimeNs - lastReleaseNs
                maxSubmittedGapNs = maxOf(maxSubmittedGapNs, gap)
                if (gap > 500_000_000L) submittedGapOver500Ms++
                if (gap > 1_000_000_000L) submittedGapOver1000Ms++
            }
            lastSubmissionAtNs = now; lastReleaseNs = if (releaseTimeNs == C.TIME_UNSET) 0L else releaseTimeNs
            lastPresentationUs = presentationTimeUs; submittedFrames++
        }
    }
    private fun resetSubmissionContinuity() = synchronized(submissionLock) { lastSubmissionAtNs = 0L; lastReleaseNs = 0L }
    private fun resetSubmissions() {
        submissionExpected = false; submissionEpoch++
        synchronized(submissionLock) {
            submittedFrames = 0L; lastSubmissionAtNs = 0L; lastReleaseNs = 0L; lastPresentationUs = -1L
            maxSubmittedGapNs = 0L; maxMetadataGapNs = 0L; submittedGapOver500Ms = 0L; submittedGapOver1000Ms = 0L
        }
    }
    private fun submissionFields(): String = synchronized(submissionLock) {
        val pending = if (submissionExpected && lastSubmissionAtNs != 0L) (System.nanoTime() - lastSubmissionAtNs).coerceAtLeast(0) else 0L
        "submittedFrames=$submittedFrames maxSubmittedGapMs=${maxSubmittedGapNs / 1_000_000L} submittedGapOver500Ms=$submittedGapOver500Ms submittedGapOver1000Ms=$submittedGapOver1000Ms maxMetadataGapMs=${maxOf(maxMetadataGapNs, pending) / 1_000_000L} lastPresentationUs=$lastPresentationUs lastReleaseNs=$lastReleaseNs"
    }
    /** Fixed stage enums and numeric player codes only. Never a URL, cookie, opaque ID or exception message. */
    private fun debug(message: String) {
        val now = SystemClock.elapsedRealtime()
        if (BuildConfig.DEBUG && debugLines < 100 && (message.startsWith("stage=error") || message.startsWith("stage=data_source_error") || message.startsWith("stage=prepared") || message.startsWith("stage=rendering") || now - lastDebugAt >= 50)) { debugLines++; lastDebugAt = now; Log.d("HomeTVMedia", message) }
    }
}

/**
 * Media3's default HTTP source follows same-protocol redirects, including explicit
 * Cookie headers. This source instead rejects every redirect and validates each
 * HLS playlist, key and media request before attaching this TV's own cookie.
 */
private class NativeMediaDataSource(
    private val baseUrl: String,
    private val cookie: String?,
    private val camera: Boolean,
) : BaseDataSource(true) {
    private var connection: HttpURLConnection? = null
    private var input: InputStream? = null
    private var uri: Uri? = null
    private var remaining = C.LENGTH_UNSET.toLong()
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        if (dataSpec.httpMethod != DataSpec.HTTP_METHOD_GET) throw IOException("Unsupported media method")
        val allowed = NativeHlsRequestPolicy.requestUrl(baseUrl, dataSpec.uri.toString(), camera)
            ?: throw IOException("Media request rejected")
        try {
            val current = allowed.toURL().openConnection() as HttpURLConnection
            connection = current; uri = Uri.parse(allowed.toString())
            current.instanceFollowRedirects = false
            current.connectTimeout = 10000; current.readTimeout = 20000
            current.requestMethod = "GET"
            current.useCaches = false
            current.setRequestProperty("Cache-Control", "no-cache")
            current.setRequestProperty("User-Agent", "HomeTV/Media3")
            current.setRequestProperty("Accept-Encoding", "identity")
            if (cookie != null && NativeMediaPolicy.sameOrigin(baseUrl, allowed)) current.setRequestProperty("Cookie", cookie)
            if (dataSpec.position > 0 || dataSpec.length != C.LENGTH_UNSET.toLong()) {
                val end = if (dataSpec.length == C.LENGTH_UNSET.toLong()) "" else (dataSpec.position + dataSpec.length - 1).toString()
                current.setRequestProperty("Range", "bytes=${dataSpec.position}-$end")
            }
            val code = current.responseCode
            if (code != 200 && code != 206) throw IOException("Media HTTP status $code")
            input = current.inputStream
            val skip = if (code == 200) dataSpec.position else 0L
            // A server ignoring a large seek must not cause an unbounded discard/download.
            if (skip > 32L * 1024 * 1024) throw IOException("Media range unsupported")
            val length = current.contentLengthLong
            remaining = if (dataSpec.length != C.LENGTH_UNSET.toLong()) dataSpec.length else if (length >= 0) (length - skip).coerceAtLeast(0) else C.LENGTH_UNSET.toLong()
            opened = true; transferStarted(dataSpec)
            var discard = skip
            val buffer = ByteArray(4096)
            while (discard > 0) {
                val count = input!!.read(buffer, 0, minOf(discard, buffer.size.toLong()).toInt())
                if (count < 0) throw EOFException("Media seek unavailable")
                discard -= count; bytesTransferred(count)
            }
            return remaining
        } catch (error: Exception) {
            close()
            throw if (error is IOException) error else IOException("Media connection failed")
        }
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val wanted = if (remaining == C.LENGTH_UNSET.toLong()) length else minOf(length.toLong(), remaining).toInt()
        val count = input?.read(buffer, offset, wanted) ?: throw IOException("Media connection closed")
        if (count < 0) {
            if (remaining > 0) throw EOFException("Media response incomplete")
            return C.RESULT_END_OF_INPUT
        }
        if (remaining != C.LENGTH_UNSET.toLong()) remaining -= count
        bytesTransferred(count); return count
    }

    override fun getUri(): Uri? = uri
    override fun getResponseHeaders(): Map<String, List<String>> = connection?.headerFields?.filterKeys { it != null }?.mapKeys { it.key!! } ?: emptyMap()
    override fun close() {
        try { input?.close() } finally {
            input = null; connection?.disconnect(); connection = null; uri = null
            if (opened) { opened = false; transferEnded() }
        }
    }
}
