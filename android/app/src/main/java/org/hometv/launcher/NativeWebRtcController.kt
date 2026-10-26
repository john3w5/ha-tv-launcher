package org.hometv.launcher

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.AddIceObserver
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RendererCommon
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoSink
import org.webrtc.VideoTrack
import kotlin.math.roundToInt

/** Receive-only native camera. HA credentials never reach this controller or libwebrtc. */
class NativeWebRtcController(
    private val activity: Activity,
    private val baseUrl: String = BuildConfig.DASHBOARD_URL,
    private val isDark: () -> Boolean = { true },
    private val onClosed: (() -> Unit)? = null,
    private val cameraPoster: ((String) -> Bitmap?)? = null,
) {
    private val ui = Handler(Looper.getMainLooper())
    private val scale get() = activity.resources.displayMetrics.widthPixels / 1440f
    private var overlay: FrameLayout? = null
    private var frame: FrameLayout? = null
    private var poster: ImageView? = null
    private var ownedPoster: Bitmap? = null
    private var spinner: ProgressBar? = null
    private var status: TextView? = null
    private var retry: Button? = null
    private val buttons = ArrayList<Button>()
    private var selectedDown = false
    private var cameraId = ""
    private var quality = "smooth"
    private val autoQuality = NativeAutoQualityPolicy()
    private val recovery = NativeCameraRecoveryPolicy()
    private var reconnect: Runnable? = null
    private var launchGeneration = 0L
    private var pendingStart: Long? = null
    private var closingSessions = 0
    private var title = "Kamera"
    private var destroyed = false
    private var serial = 0L
    private var current: Session? = null
    private var watch: Runnable? = null
    private var timeout: Runnable? = null
    private var disconnect: Runnable? = null
    private var debugCount = 0

    private class Session(
        val serial: Long,
        val cameraId: String,
        val quality: String,
        val mode: String,
        val renderer: SurfaceViewRenderer,
        val egl: EglBase,
        val thread: HandlerThread,
        val transport: NativeWebRtcTransport,
    ) {
        val worker = Handler(thread.looper)
        @Volatile var closed = false
        // HD decoding uses copied I420 output on this TCL. A bounded 500 ms
        // reserve smooths short decoder-output bursts without retaining a
        // SurfaceTexture (which would stall the decoder's one-texture queue).
        val pacer = if (quality == "hd") NativeFramePacer(worker, { frame ->
            if (!closed) renderer.onFrame(frame)
        }, traceDirectory = java.io.File(renderer.context.filesDir, "pacer-trace")) else null
        @Volatile var expectFrames = false
        var factory: PeerConnectionFactory? = null
        var peer: PeerConnection? = null
        var track: VideoTrack? = null
        var sink: VideoSink? = null
        var offerSent = false
        var remoteReady = false
        var remoteMedia = emptyList<NativeIceCandidatePolicy.Target>()
        var acceptedCandidates = 0L
        var rejectedCandidates = 0L
        val localCandidates = ArrayList<JSONObject>()
        val remoteCandidates = ArrayList<JSONObject>()
        val frameLock = Any()
        var decodedFrames = 0L
        var lastFrameNs = 0L
        var maxFrameGapNs = 0L
        var gapsOver500Ms = 0L
        var gapsOver1000Ms = 0L
        var rendered = false // Application thread only.
        var videoWidth = 0 // Application thread only.
        var videoHeight = 0
        var videoRotation = 0
        var layoutHost: FrameLayout? = null
        var layoutListener: View.OnLayoutChangeListener? = null
    }

    fun isOpen(): Boolean = overlay?.parent != null

    fun openCamera(id: String, name: String, quality: String = "smooth") = main {
        if (destroyed || activity.isFinishing || activity.isDestroyed || !NativeMediaPolicy.cameraId(id) || !NativeAutoQualityPolicy.validMode(quality)) return@main
        closeNow(false)
        cameraId = id; title = name.take(100); this.quality = quality
        autoQuality.select(quality); recovery.resetAll(SystemClock.elapsedRealtime())
        buildOverlay(); begin()
    }

    fun handleKey(event: KeyEvent): Boolean {
        if (!isOpen()) return false
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> { if (event.action == KeyEvent.ACTION_UP) close(); return true }
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN && !event.isCanceled) {
                    val choices = buttons.filter { it.isEnabled && it.visibility == View.VISIBLE }
                    val index = choices.indexOfFirst { it.hasFocus() }
                    val step = if (event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_UP)) -1 else 1
                    if (choices.isNotEmpty()) choices[if (index < 0) 0 else (index + step + choices.size) % choices.size].requestFocus()
                }
                return true
            }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) selectedDown = true
                if (event.action == KeyEvent.ACTION_UP) {
                    if (selectedDown && !event.isCanceled) buttons.firstOrNull { it.hasFocus() && it.isEnabled && it.visibility == View.VISIBLE }?.performClick()
                    selectedDown = false
                }
                return true
            }
        }
        return false
    }

    private fun buildOverlay() {
        val host = activity.findViewById<ViewGroup>(android.R.id.content)
        val cover = FrameLayout(activity).apply { setBackgroundColor(Color.argb(if (isDark()) 95 else 55, 0, 0, 0)); isClickable = true; isFocusable = true }
        val body = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(v(24), v(18), v(24), v(18))
            background = shape(if (isDark()) Color.argb(248, 35, 38, 45) else Color.argb(248, 241, 243, 246), 26f)
        }
        val header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        header.addView(TextView(activity).apply { text = title; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END; font(this, 22f); setTextColor(ink()) }, LinearLayout.LayoutParams(0, -2, 1f))
        for ((id, label) in listOf("auto" to "Auto", "smooth" to "Plynulé", "hd" to "HD")) header.addView(button(label) {
            if (quality != id) { quality = id; autoQuality.select(id); recovery.resetAll(SystemClock.elapsedRealtime()); begin() }
            updateQualityButtons()
        }.apply { tag = id; isSelected = quality == id }, LinearLayout.LayoutParams(-2, -2).apply { marginEnd = v(8) })
        header.addView(button("Zavřít") { close() }); body.addView(header)
        val videoFrame = FrameLayout(activity).apply { background = shape(Color.BLACK, 18f); clipToOutline = true }
        val still = ImageView(activity).apply { scaleType = ImageView.ScaleType.FIT_CENTER; setBackgroundColor(Color.BLACK); isFocusable = false }
        videoFrame.addView(still, FrameLayout.LayoutParams(-1, -1))
        val waiting = ProgressBar(activity); videoFrame.addView(waiting, FrameLayout.LayoutParams(v(36), v(36), Gravity.CENTER))
        body.addView(videoFrame, LinearLayout.LayoutParams(-1, 0, 1f).apply { topMargin = v(14); bottomMargin = v(12) })
        val footer = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        val line = TextView(activity).apply { font(this, 14f); setTextColor(muted()) }
        footer.addView(line, LinearLayout.LayoutParams(0, -2, 1f))
        val again = button("Zkusit znovu") { recovery.resetAll(SystemClock.elapsedRealtime()); begin() }.apply { visibility = View.GONE }; footer.addView(again); body.addView(footer)
        val availableWidth = host.width.takeIf { it > 0 } ?: activity.resources.displayMetrics.widthPixels
        val availableHeight = host.height.takeIf { it > 0 } ?: activity.resources.displayMetrics.heightPixels
        val panelWidth = minOf(v(1120), (availableWidth * .78f).roundToInt())
        val panelHeight = minOf(v(680), (availableHeight * .75f).roundToInt())
        cover.addView(body, FrameLayout.LayoutParams(panelWidth, panelHeight, Gravity.CENTER))
        overlay = cover; frame = videoFrame; poster = still; spinner = waiting; status = line; retry = again
        host.addView(cover, ViewGroup.LayoutParams(-1, -1)); buttons.firstOrNull()?.requestFocus()
    }

    private fun begin() {
        clearReconnect()
        pendingStart = ++launchGeneration
        releaseSession()
        if (!isOpen() || destroyed) { pendingStart = null; return }
        status?.text = "Připojuji · ${qualityLabel(autoQuality.profile())}…"
        spinner?.visibility = View.VISIBLE; retry?.visibility = View.GONE; showPoster(); updateQualityButtons()
        startWhenReleased()
    }

    /** A replacement peer is created only after its predecessor and renderer are disposed. */
    private fun startWhenReleased() {
        val ticket = pendingStart ?: return
        if (closingSessions != 0) return
        pendingStart = null
        if (ticket != launchGeneration || !isOpen() || destroyed) return
        resetDebug(); autoQuality.sessionStarted(SystemClock.elapsedRealtime()); recovery.resetProgress(SystemClock.elapsedRealtime())
        startSession()
    }

    private fun startSession() {
        var unownedEgl: EglBase? = null
        var unownedRenderer: SurfaceViewRenderer? = null
        var unownedThread: HandlerThread? = null
        try {
            initialize(activity.applicationContext)
            val egl = EglBase.create(); unownedEgl = egl
            var rendererSession: Session? = null
            val renderer = object : SurfaceViewRenderer(activity) {
                override fun onVisibilityAggregated(visible: Boolean) {
                    super.onVisibilityAggregated(visible)
                    rendererSession?.let { session -> main {
                        if (!active(session)) return@main
                        session.expectFrames = visible && session.rendered
                        synchronized(session.frameLock) { session.lastFrameNs = if (session.expectFrames) System.nanoTime() else 0 }
                    } }
                }
            }.apply {
                isFocusable = false
                if (Build.VERSION.SDK_INT >= 34) setSurfaceLifecycle(SurfaceView.SURFACE_LIFECYCLE_FOLLOWS_ATTACHMENT)
            }
            unownedRenderer = renderer
            val thread = HandlerThread("TV-camera-WebRTC").apply { start() }; unownedThread = thread
            lateinit var session: Session
            val transport = NativeWebRtcTransport(baseUrl,
                onCandidate = { candidate -> rtc(session) { receiveCandidate(session, candidate) } },
                onClosed = { _ -> failure(session, "Přímé spojení kamery skončilo. Zkus připojení znovu.") })
            session = Session(++serial, cameraId, autoQuality.profile(), quality, renderer, egl, thread, transport); current = session; rendererSession = session
            unownedEgl = null; unownedRenderer = null; unownedThread = null
            renderer.init(egl.eglBaseContext, object : RendererCommon.RendererEvents {
                override fun onFirstFrameRendered() = main {
                    if (!active(session)) return@main
                    session.rendered = true; session.expectFrames = renderer.isShown && renderer.windowVisibility == View.VISIBLE
                    synchronized(session.frameLock) { session.lastFrameNs = if (session.expectFrames) System.nanoTime() else 0 }
                    timeout?.let(ui::removeCallbacks); timeout = null
                    clearPoster(); spinner?.visibility = View.GONE
                    status?.text = "Živě · ${qualityLabel(session.quality)} · přímý přenos bez zvuku"
                    updateQualityButtons(); debug("stage=rendering ${sessionLabel(session)}")
                }
                override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) = main {
                    if (!active(session)) return@main
                    session.videoWidth = width; session.videoHeight = height; session.videoRotation = rotation
                    fitRenderer(session)
                }
            })
            renderer.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT); renderer.setEnableHardwareScaler(true)
            val videoHost = frame ?: throw IllegalStateException("Camera frame missing")
            session.layoutHost = videoHost
            session.layoutListener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> fitRenderer(session) }.also(videoHost::addOnLayoutChangeListener)
            videoHost.addView(renderer, 0, FrameLayout.LayoutParams(1, 1, Gravity.CENTER))
            val timer = Runnable { failure(session, "Kamera zatím neposlala živý obraz. Zkus připojení znovu.") }
            timeout = timer; ui.postDelayed(timer, 22000)
            rtc(session) { createPeer(session) }; startWatch(session)
        } catch (_: Throwable) {
            releaseSession(); runCatching { unownedRenderer?.release() }; runCatching { unownedEgl?.release() }; unownedThread?.quitSafely()
            failedUi("Přímý přehrávač se nepodařilo připravit.")
        }
    }

    private fun createPeer(session: Session) {
        try {
            val factory = PeerConnectionFactory.builder()
                // M150 RtpVideoStreamReceiver2 applies these limits to encoded-frame
                // timing before decode. Never queue/retain decoder texture frames.
                .setFieldTrials("WebRTC-ForcePlayoutDelay/min_ms:1000,max_ms:1500/")
                // This TCL drops 1080p outputs on the shared-texture path. The
                // measured HD path copies I420 while keeping platform codec selection.
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(if (session.quality == "hd") null else session.egl.eglBaseContext))
                .createPeerConnectionFactory()
            session.factory = factory
            val config = PeerConnection.RTCConfiguration(emptyList()).apply { sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN }
            val peer = factory.createPeerConnection(config, object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) { }
                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    if (state == PeerConnection.IceConnectionState.FAILED) failure(session, "Přímé spojení se přerušilo.")
                }
                override fun onConnectionChange(state: PeerConnection.PeerConnectionState) = main {
                    if (!active(session)) return@main
                    if (state == PeerConnection.PeerConnectionState.CONNECTED) { disconnect?.let(ui::removeCallbacks); disconnect = null; debug("stage=connected") }
                    else if (state == PeerConnection.PeerConnectionState.FAILED) failure(session, "Přímé spojení se přerušilo.")
                    else if (state == PeerConnection.PeerConnectionState.DISCONNECTED) {
                        disconnect?.let(ui::removeCallbacks)
                        val task = Runnable { failure(session, "Spojení kamery se přerušilo.") }; disconnect = task; ui.postDelayed(task, 5000)
                    }
                }
                override fun onIceConnectionReceivingChange(receiving: Boolean) { }
                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if (state == PeerConnection.IceGatheringState.COMPLETE) rtc(session) { sendOffer(session) } }
                override fun onIceCandidate(candidate: IceCandidate) = rtc(session) {
                    if (!session.offerSent) return@rtc // Already included in the local SDP gathered before POST.
                    val json = candidateJson(candidate)
                    if (session.remoteReady) session.transport.sendCandidate(json)
                    else if (session.localCandidates.size < 128) session.localCandidates.add(json)
                    else failure(session, "Kamera vrátila příliš mnoho síťových adres.")
                }
                override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) { }
                override fun onAddStream(stream: MediaStream) { }
                override fun onRemoveStream(stream: MediaStream) { }
                override fun onDataChannel(channel: DataChannel) { channel.close() }
                override fun onRenegotiationNeeded() { }
                override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = rtc(session) { bindTrack(session, receiver) }
                override fun onTrack(transceiver: RtpTransceiver) = rtc(session) { bindTrack(session, transceiver.receiver) }
            }) ?: throw IllegalStateException("No peer")
            session.peer = peer
            peer.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO, RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.RECV_ONLY))
            peer.createOffer(object : SdpResult() {
                override fun onCreateSuccess(description: SessionDescription) = rtc(session) {
                    peer.setLocalDescription(object : SdpResult() {
                        override fun onSetSuccess() { session.worker.postDelayed({ if (!session.closed) sendOffer(session) }, 1500) }
                        override fun onSetFailure(error: String) { failure(session, "Nabídku přenosu nelze připravit.") }
                    }, description)
                }
                override fun onCreateFailure(error: String) { failure(session, "Nabídku přenosu nelze připravit.") }
            }, MediaConstraints())
        } catch (_: Throwable) { failure(session, "Přímé spojení kamery nelze připravit.") }
    }

    private fun sendOffer(session: Session) {
        if (session.closed || session.offerSent) return
        val offer = session.peer?.localDescription?.description ?: return
        session.offerSent = true
        session.transport.open(session.cameraId, session.quality, offer) { result -> rtc(session) {
            val answer = result.getOrNull()
            if (answer == null) { failure(session, "Kamera přímý přenos nepotvrdila. Zkus připojení znovu."); return@rtc }
            session.remoteMedia = NativeIceCandidatePolicy.mediaSections(answer.sdp)
            if (session.remoteMedia.isEmpty()) { failure(session, "Kamera nevrátila platný videopřenos."); return@rtc }
            session.peer?.setRemoteDescription(object : SdpResult() {
                override fun onSetSuccess() = rtc(session) {
                    session.remoteReady = true
                    answer.candidates.forEach { receiveCandidate(session, it) }
                    session.remoteCandidates.toList().forEach { receiveCandidate(session, it) }; session.remoteCandidates.clear()
                    session.localCandidates.forEach(session.transport::sendCandidate); session.localCandidates.clear()
                    session.transport.startEvents()
                    debug("stage=answer")
                }
                override fun onSetFailure(error: String) { failure(session, "Odpověď kamery nelze použít.") }
            }, SessionDescription(SessionDescription.Type.ANSWER, answer.sdp))
        } }
    }

    private fun receiveCandidate(session: Session, value: JSONObject) {
        if (!session.remoteReady) { if (session.remoteCandidates.size < 128) session.remoteCandidates.add(JSONObject(value.toString())); return }
        val text = value.optString("candidate"); if (text.isEmpty()) return
        val mid = if (value.isNull("sdpMid")) null else value.optString("sdpMid")
        val index: Int? = if (value.isNull("sdpMLineIndex")) null else value.optInt("sdpMLineIndex", -1)
        val target = NativeIceCandidatePolicy.resolve(session.remoteMedia, mid, index)
        if (target == null) { session.rejectedCandidates++; return }
        // The browser allows an omitted/null sdpMid. The Android JNI string converter
        // does not. Resolve the actual answer's MID and use the asynchronous API.
        runCatching { session.peer?.addIceCandidate(IceCandidate(target.mid, target.index, text), object : AddIceObserver {
            override fun onAddSuccess() = rtc(session) { session.acceptedCandidates++ }
            override fun onAddFailure(error: String) = rtc(session) { session.rejectedCandidates++ }
        }) }.onFailure { session.rejectedCandidates++ }
    }

    private fun bindTrack(session: Session, receiver: RtpReceiver) {
        val track = receiver.track() as? VideoTrack ?: return
        if (session.track === track || session.track?.id() == track.id()) return
        session.sink?.let { sink -> session.track?.removeSink(sink) }
        session.pacer?.reset()
        val sink = VideoSink { frame ->
            if (!session.closed) {
                val now = System.nanoTime()
                if (session.expectFrames) synchronized(session.frameLock) {
                    if (session.expectFrames && !session.closed) {
                        if (session.lastFrameNs > 0) {
                            val gap = (now - session.lastFrameNs).coerceAtLeast(0); session.maxFrameGapNs = maxOf(session.maxFrameGapNs, gap)
                            if (gap > 500_000_000L) session.gapsOver500Ms++
                            if (gap > 1_000_000_000L) session.gapsOver1000Ms++
                        }
                        session.lastFrameNs = now; session.decodedFrames++
                    }
                }
                session.pacer?.offer(frame) ?: session.renderer.onFrame(frame)
            }
        }
        session.track = track; session.sink = sink; track.addSink(sink)
    }

    private fun startWatch(session: Session) {
        var ticks = 0
        val task = object : Runnable {
            override fun run() {
                if (!active(session)) return
                val previouslyExpected = session.expectFrames
                session.expectFrames = session.rendered && session.renderer.isShown && session.renderer.windowVisibility == View.VISIBLE && session.renderer.isAttachedToWindow
                if (!session.expectFrames || !previouslyExpected) synchronized(session.frameLock) { session.lastFrameNs = if (session.expectFrames) System.nanoTime() else 0 }
                val decoded = synchronized(session.frameLock) { session.decodedFrames }
                if (recovery.observe(SystemClock.elapsedRealtime(), decoded, session.expectFrames)) { failure(session, "Živý obraz se zastavil. Zkus připojení znovu."); return }
                if (++ticks % 10 == 0) {
                    val fields = synchronized(session.frameLock) { "decodedFrames=${session.decodedFrames} maxDecodedGapMs=${session.maxFrameGapNs / 1_000_000} decodedGapOver500Ms=${session.gapsOver500Ms} decodedGapOver1000Ms=${session.gapsOver1000Ms}" }
                    val pacing = session.pacer?.snapshot()?.let { p ->
                        " pacerOffered=${p.offered} pacerSubmitted=${p.presented} pacerMaxSubmittedGapMs=${p.maxPresentedGapMs} pacerGapOver250Ms=${p.gapsOver250Ms} pacerGapOver500Ms=${p.gapsOver500Ms} pacerGapOver1000Ms=${p.gapsOver1000Ms} pacerQueued=${p.queued} pacerQueuedBytes=${p.queuedBytes} pacerOverflowDrops=${p.overflowDrops} pacerLateDrops=${p.lateDrops} pacerFlushDrops=${p.flushDrops} pacerResets=${p.resets} pacerFallbackFrames=${p.fallbackFrames} pacerBypassed=${p.bypassed} pacerRenderErrors=${p.renderErrors} pacerReleaseErrors=${p.releaseErrors} pacerScheduleErrors=${p.scheduleErrors} pacerHeadAheadMs=${p.headAheadMs} pacerTailAheadMs=${p.tailAheadMs} pacerMaxDueAheadMs=${p.maxDueAheadMs} pacerSourceSpanMs=${p.sourceSpanMs} pacerArrivalSpanMs=${p.arrivalSpanMs} pacerCorrectionMs=${p.correctionMs} pacerCorrectionCount=${p.correctionCount} pacerCorrectionSkipReason=${p.correctionSkipReason}" +
                            " pacerPhaseEstimateMs=${p.phaseEstimateMs} pacerPhaseSpreadMs=${p.phaseSpreadMs} pacerPhaseWindowMs=${p.phaseWindowMs} pacerPhaseSamples=${p.phaseSamples} pacerCorrectionTargetMs=${p.correctionTargetMs} pacerMaxCorrectionStepUs=${p.maxCorrectionStepUs} pacerMaxQueued=${p.maxQueued} pacerMaxQueuedBytes=${p.maxQueuedBytes} pacerStableWindows=${p.stableWindows} pacerUnstableWindows=${p.unstableWindows} pacerShortWindows=${p.shortWindows}" +
                            " pacerAbsoluteFrames=${p.absoluteFrames} pacerInvalidClockFrames=${p.invalidClockFrames} pacerExpiredAtOffer=${p.expiredAtOffer} pacerBridgeValid=${if (p.bridgeValid) 1 else 0} pacerBridgeOffsetNs=${p.bridgeOffsetNs} pacerBridgeSampleWidthNs=${p.bridgeSampleWidthNs} pacerBridgeSamples=${p.bridgeSamples} pacerBridgeFailures=${p.bridgeFailures} pacerLastRawLeadNs=${p.lastRawLeadNs} pacerMinRawLeadNs=${p.minRawLeadNs} pacerMaxRawLeadNs=${p.maxRawLeadNs} pacerMaxDueAheadNs=${p.maxDueAheadNs}"
                    }.orEmpty()
                    debug("stage=sample ${sessionLabel(session)} $fields$pacing")
                    rtc(session) { debug("stage=ice ${sessionLabel(session)} accepted=${session.acceptedCandidates} rejected=${session.rejectedCandidates}"); collectStats(session) }
                }
                ui.postDelayed(this, 1000)
            }
        }
        watch = task; ui.postDelayed(task, 1000)
    }

    /** Bounded camera labels and numeric diagnostics; never SDP, ICE addresses, URLs or cookies. */
    private fun collectStats(session: Session) {
        runCatching { session.peer?.getStats { report ->
            if (session.closed) return@getStats
            val incoming = report.statsMap.values.firstOrNull { row ->
                row.type == "inbound-rtp" && (row.members["kind"] == "video" || row.members["mediaType"] == "video" || row.members.containsKey("framesDecoded"))
            } ?: return@getStats
            val keys = listOf("frameWidth", "frameHeight", "framesReceived", "framesDecoded", "framesDropped", "framesPerSecond", "freezeCount", "totalFreezesDuration", "packetsLost", "packetsReceived", "bytesReceived", "jitter", "jitterBufferDelay", "jitterBufferTargetDelay", "jitterBufferEmittedCount", "totalDecodeTime", "totalProcessingDelay", "keyFramesDecoded", "nackCount", "pliCount", "firCount", "rtxPacketsReceived", "retransmittedPacketsReceived", "totalInterFrameDelay", "totalSquaredInterFrameDelay", "jitterBufferMinimumDelay")
            val fields = keys.joinToString(" ") { key ->
                val value = incoming.members[key] as? Number
                "$key=${value?.takeIf { it.toDouble().isFinite() }?.toString() ?: "-1"}"
            }
            val transport = (incoming.members["transportId"] as? String)?.let { report.statsMap[it] }
            val pair = (transport?.members?.get("selectedCandidatePairId") as? String)?.let { report.statsMap[it] }
            val remote = if (pair?.type == "candidate-pair") (pair.members["remoteCandidateId"] as? String)?.let { report.statsMap[it] } else null
            // Use only the selected pair linked to this inbound stream. Do not infer
            // the route from arbitrary host candidates or resolve mDNS names.
            val privateRemote = if (remote?.type == "remote-candidate") privateAddress(remote.members["address"] ?: remote.members["ip"]) else -1
            val remoteHost = when (if (remote?.type == "remote-candidate") remote.members["candidateType"] else null) {
                "host" -> 1
                "srflx", "prflx", "relay" -> 0
                else -> -1
            }
            // Preserve the SDK claim separately: the M150 Java wrapper can report
            // accelerated=true even for a platform-software MediaCodec fallback.
            val decoderHw = when (incoming.members["powerEfficientDecoder"]) { true -> 1; false -> 0; else -> -1 }
            val decoder = NativeDecoderEvidence.read(incoming.members["decoderImplementation"])
            debug("stage=rtcstats ${sessionLabel(session)} $fields decoderHw=$decoderHw decoderCodecMatched=${decoder.matched} decoderCodecHw=${decoder.hardware} decoderCodecSoftware=${decoder.software} remotePrivate=$privateRemote remoteTypeHost=$remoteHost")
            val decoded = (incoming.members["framesDecoded"] as? Number)?.toLong() ?: -1L
            val dropped = (incoming.members["framesDropped"] as? Number)?.toLong() ?: -1L
            val freezes = (incoming.members["freezeCount"] as? Number)?.toLong() ?: -1L
            val freezeMs = (incoming.members["totalFreezesDuration"] as? Number)?.toDouble()?.times(1000) ?: -1.0
            val largeGaps = synchronized(session.frameLock) { session.gapsOver500Ms }
            val lost = (incoming.members["packetsLost"] as? Number)?.toLong() ?: -1L
            val received = (incoming.members["packetsReceived"] as? Number)?.toLong() ?: -1L
            main {
                if (active(session) && session.expectFrames && autoQuality.observe(SystemClock.elapsedRealtime(), decoded, dropped, freezes, freezeMs, largeGaps, lost, received)) {
                    debug("stage=quality ${sessionLabel(session)} next=${autoQuality.profile()}")
                    begin()
                }
            }
        } }
    }

    private fun failure(session: Session, message: String) = main {
        if (!active(session)) return@main
        val delay = recovery.reserveRetry(SystemClock.elapsedRealtime())
        autoQuality.failed(SystemClock.elapsedRealtime())
        pendingStart = null; val ticket = ++launchGeneration
        releaseSession(); clearReconnect(); updateQualityButtons()
        if (delay < 0) { failedUi(message); return@main }
        showPoster(); spinner?.visibility = View.VISIBLE; retry?.visibility = View.GONE
        status?.text = "Obnovuji spojení · ${qualityLabel(autoQuality.profile())}…"
        val task = Runnable { if (ticket == launchGeneration && isOpen() && !destroyed) { reconnect = null; begin() } }
        reconnect = task; ui.postDelayed(task, delay)
    }
    private fun clearReconnect() { reconnect?.let(ui::removeCallbacks); reconnect = null }
    private fun qualityLabel(profile: String): String = (if (quality == "auto") "Auto · " else "") + if (profile == "hd") "HD" else "Plynulé"
    private fun updateQualityButtons() { buttons.forEach { button ->
        button.isSelected = button.tag == quality
        if (button.tag == "auto") button.text = "Auto · ${if (autoQuality.profile() == "hd") "HD" else "Plynulé"}"
    } }
    private fun failedUi(message: String) { spinner?.visibility = View.GONE; retry?.visibility = View.VISIBLE; val hasPoster = showPoster(); status?.text = (if (hasPoster) "Snímek · " else "") + message }
    private fun showPoster(): Boolean {
        clearPoster()
        val cached = runCatching { cameraPoster?.invoke(cameraId) }.getOrNull()
        if (cached != null && !cached.isRecycled && cached.width.toLong() * cached.height <= 4_000_000) ownedPoster = runCatching { cached.copy(Bitmap.Config.ARGB_8888, false) }.getOrNull()
        poster?.setImageBitmap(ownedPoster); poster?.visibility = View.VISIBLE
        return ownedPoster != null
    }
    private fun clearPoster() { poster?.setImageDrawable(null); poster?.visibility = View.GONE; ownedPoster?.let { if (!it.isRecycled) it.recycle() }; ownedPoster = null }

    private fun fitRenderer(session: Session) {
        if (!active(session)) return
        val host = session.layoutHost ?: return
        val size = fitVideoSize(session.videoWidth, session.videoHeight, session.videoRotation,
            host.width - host.paddingLeft - host.paddingRight, host.height - host.paddingTop - host.paddingBottom) ?: return
        val previous = session.renderer.layoutParams as? FrameLayout.LayoutParams
        if (previous?.width == size.first && previous.height == size.second && previous.gravity == Gravity.CENTER) return
        session.renderer.layoutParams = FrameLayout.LayoutParams(size.first, size.second, Gravity.CENTER)
    }

    /** Explicit SurfaceView bounds preserve the full rotated source, independently of GPU scaling. */
    private fun fitVideoSize(width: Int, height: Int, rotation: Int, boundWidth: Int, boundHeight: Int): Pair<Int, Int>? {
        if (width !in 1..16384 || height !in 1..16384 || boundWidth <= 0 || boundHeight <= 0) return null
        val angle = (rotation % 360 + 360) % 360
        if (angle !in listOf(0, 90, 180, 270)) return null
        val sourceWidth = if (angle == 90 || angle == 270) height else width
        val sourceHeight = if (angle == 90 || angle == 270) width else height
        val factor = minOf(boundWidth.toDouble() / sourceWidth, boundHeight.toDouble() / sourceHeight)
        return (sourceWidth * factor).toInt().coerceIn(1, boundWidth) to (sourceHeight * factor).toInt().coerceIn(1, boundHeight)
    }

    private fun releaseSession() {
        watch?.let(ui::removeCallbacks); watch = null; timeout?.let(ui::removeCallbacks); timeout = null; disconnect?.let(ui::removeCallbacks); disconnect = null
        val session = current ?: return
        current = null; session.closed = true; session.expectFrames = false; serial++; closingSessions++
        session.transport.destroy()
        session.layoutListener?.let { session.layoutHost?.removeOnLayoutChangeListener(it) }
        session.layoutListener = null; session.layoutHost = null
        (session.renderer.parent as? ViewGroup)?.removeView(session.renderer)
        session.worker.removeCallbacksAndMessages(null)
        val cleanup = Runnable {
            // Flush retained raw buffers before disposing their decoder/factory.
            // Debug trace file export also finishes here, after playback stops.
            // It does not hold the policy lock or wait for UI work.
            session.pacer?.close()
            runCatching { session.sink?.let { session.track?.removeSink(it) } }
            runCatching { session.peer?.close() }; runCatching { session.peer?.dispose() }; session.peer = null
            runCatching { session.factory?.dispose() }; session.factory = null; session.track = null; session.sink = null
            ui.post {
                runCatching { session.renderer.release() }; runCatching { session.egl.release() }; session.thread.quitSafely()
                closingSessions = (closingSessions - 1).coerceAtLeast(0)
                startWhenReleased()
            }
        }
        if (!session.worker.post(cleanup)) cleanup.run()
    }

    fun close() = main { closeNow(true) }
    fun onPause() = main { closeNow(false) }
    fun onDestroy() = main { destroyed = true; closeNow(false) }
    private fun closeNow(notify: Boolean) {
        pendingStart = null; launchGeneration++; clearReconnect()
        val old = overlay; releaseSession(); clearPoster()
        overlay = null; frame = null; poster = null; status = null; spinner = null; retry = null; cameraId = ""; selectedDown = false; buttons.clear()
        if (old != null) (old.parent as? ViewGroup)?.removeView(old)
        if (notify && old != null) onClosed?.invoke()
    }
    private fun active(session: Session) = !destroyed && !session.closed && current === session && isOpen()
    private fun sessionLabel(session: Session) = "camera=${session.cameraId} quality=${session.quality} mode=${session.mode}"
    private fun privateAddress(value: Any?): Int {
        val address = (value as? String)?.trim()?.lowercase()?.takeIf { it.length in 1..128 } ?: return -1
        val parts = address.split('.')
        if (parts.size == 4 && parts.all { it.isNotEmpty() && it.length <= 3 && it.all { c -> c in '0'..'9' } }) {
            val octets = parts.map { it.toIntOrNull() ?: return -1 }
            if (octets.any { it !in 0..255 }) return -1
            return if (octets[0] == 10 || octets[0] == 172 && octets[1] in 16..31 || octets[0] == 192 && octets[1] == 168 || octets[0] == 169 && octets[1] == 254) 1 else 0
        }
        // Only numeric IPv6 is eligible; no DNS, endpoint or candidate logging.
        val ipv6 = address.removePrefix("[").removeSuffix("]").substringBefore('%')
        if (!ipv6.contains(':') || ipv6.any { it !in "0123456789abcdef:" }) return -1
        // A colon plus the restricted numeric alphabet forces literal IPv6
        // parsing, never a hostname lookup. Reject malformed compressed forms.
        val parsed = runCatching { java.net.InetAddress.getByName(ipv6) as? java.net.Inet6Address }.getOrNull() ?: return -1
        val bytes = parsed.address
        val prefix = ((bytes[0].toInt() and 255) shl 8) or (bytes[1].toInt() and 255)
        return if (prefix in 0xfc00..0xfdff || prefix in 0xfe80..0xfebf) 1 else 0
    }
    private fun rtc(session: Session, action: () -> Unit) { if (!session.closed) session.worker.post { if (!session.closed) action() } }
    private fun main(action: () -> Unit) { if (Looper.myLooper() == Looper.getMainLooper()) action() else ui.post { action() } }
    private fun candidateJson(value: IceCandidate) = JSONObject().put("candidate", value.sdp).put("sdpMLineIndex", value.sdpMLineIndex).apply { value.sdpMid?.let { put("sdpMid", it) } }
    private fun v(value: Int) = (value * scale).roundToInt()
    private fun font(view: TextView, size: Float) { view.setTextSize(TypedValue.COMPLEX_UNIT_PX, size * scale); view.includeFontPadding = false }
    private fun ink() = if (isDark()) Color.rgb(246, 247, 250) else Color.rgb(36, 40, 47)
    private fun muted() = if (isDark()) Color.rgb(195, 199, 208) else Color.rgb(91, 98, 110)
    private fun shape(color: Int, radius: Float = 20f) = GradientDrawable().apply { setColor(color); cornerRadius = radius * scale }
    private fun button(label: String, action: () -> Unit): Button = Button(activity).apply {
        text = label; isAllCaps = false; font(this, 14f); setTextColor(ink()); setPadding(v(16), v(8), v(16), v(8)); minHeight = v(38); minimumHeight = v(38); minWidth = v(74)
        background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), shape(if (isDark()) Color.rgb(73, 78, 88) else Color.rgb(217, 223, 232)))
            addState(intArrayOf(android.R.attr.state_selected), shape(if (isDark()) Color.rgb(61, 66, 76) else Color.rgb(221, 227, 236)))
            addState(intArrayOf(), shape(if (isDark()) Color.rgb(48, 52, 60) else Color.rgb(231, 234, 239)))
        }
        stateListAnimator = null; if (Build.VERSION.SDK_INT >= 26) defaultFocusHighlightEnabled = false
        setOnClickListener { action() }; buttons.add(this)
    }
    @Synchronized private fun resetDebug() { debugCount = 0 }
    @Synchronized private fun debug(message: String) { if (BuildConfig.DEBUG && debugCount++ < 80) Log.d("HomeTVRTC", message) }
    private open class SdpResult : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) { }
        override fun onSetSuccess() { }
        override fun onCreateFailure(error: String) { }
        override fun onSetFailure(error: String) { }
    }
    companion object {
        @Volatile private var initialized = false
        @Synchronized private fun initialize(context: Context) {
            if (!initialized) { PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions()); initialized = true }
        }
    }
}
