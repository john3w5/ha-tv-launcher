package org.hometv.launcher

import android.content.Context
import android.media.AudioAttributes
import android.media.SoundPool
import android.os.SystemClock
import android.webkit.WebView
import android.util.Log
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/** Preloaded original ticks. Only reads one fixed boolean; exposes no inbound native bridge. */
class NativeAudio(context: Context) : AutoCloseable {
    private val policy = NativeAudioPolicy()
    private val loaded = ConcurrentHashMap.newKeySet<Int>()
    private val samples = ConcurrentHashMap<NativeAudioPolicy.Kind, Int>()
    private val streams = ArrayDeque<Int>(2)
    private val warmupExecutor = Executors.newSingleThreadExecutor()
    private val warmupBusy = AtomicBoolean(false)
    private val warmupRequested = AtomicBoolean(false)
    private val warmupGeneration = AtomicLong(0)
    @Volatile private var released = false
    @Volatile private var foreground = false
    @Volatile private var warmupReady = false
    private var lastDiagnosticAt = Long.MIN_VALUE
    private var diagnosticLines = 0
    private var scheduledCount = 0L
    @Volatile private var pool: SoundPool? = runCatching {
        SoundPool.Builder().setMaxStreams(2).setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        ).build()
    }.getOrNull()

    init {
        pool?.let { sounds ->
            sounds.setOnLoadCompleteListener { _, sampleId, status ->
                if (!released && status == 0) { loaded.add(sampleId); prewarm() }
            }
            samples[NativeAudioPolicy.Kind.MOVE] = runCatching { sounds.load(context.applicationContext, R.raw.nav_move, 1) }.getOrDefault(0)
            samples[NativeAudioPolicy.Kind.SELECT] = runCatching { sounds.load(context.applicationContext, R.raw.nav_select, 1) }.getOrDefault(0)
        }
    }

    /** Must be called after dispatching an actual navigation key, on the UI thread. */
    fun requestNative(kind: NativeAudioPolicy.Kind, keyEventTimeMs: Long, enabled: Boolean) {
        if (released || !foreground || !warmupReady || !enabled) return
        val now = SystemClock.uptimeMillis()
        if (now < keyEventTimeMs || now - keyEventTimeMs > NativeAudioPolicy.MAX_CALLBACK_AGE_MS) return
        val sample = samples[kind] ?: return
        if (sample == 0 || !loaded.contains(sample)) return
        val ticket = policy.request(kind, keyEventTimeMs) ?: return
        if (!policy.authorize(ticket, "true", now)) return
        val stream = runCatching { pool?.play(sample, .15f, .15f, 1, 0, 1f) ?: 0 }.getOrDefault(0)
        if (stream != 0) {
            if (streams.size >= 2) runCatching { pool?.stop(streams.removeFirst()) }
            streams.addLast(stream)
            if (BuildConfig.DEBUG) scheduledCount++
        }
        diagnostic(kind, SystemClock.uptimeMillis() - keyEventTimeMs, if (stream != 0) "scheduled_native" else "pool_refused", stream != 0)
    }

    fun request(kind: NativeAudioPolicy.Kind, webView: WebView, keyEventTimeMs: Long, stillAllowed: () -> Boolean) {
        if (released || !warmupReady || !stillAllowed()) return
        val inputAge = SystemClock.uptimeMillis() - keyEventTimeMs
        if (inputAge < 0 || inputAge > NativeAudioPolicy.MAX_CALLBACK_AGE_MS) return
        val sample = samples[kind] ?: return
        if (sample == 0 || !loaded.contains(sample)) return
        val ticket = policy.request(kind, keyEventTimeMs) ?: return
        try {
            webView.evaluateJavascript("window.HomeTVSoundEnabled===true") { exactBoolean ->
                val allowed = !released && stillAllowed()
                val callbackAt = SystemClock.uptimeMillis()
                val ageMs = callbackAt - ticket.issuedAtMs()
                if (policy.authorize(ticket, if (allowed) exactBoolean else "false", callbackAt)) {
                    val playStartedAt = SystemClock.uptimeMillis()
                    val stream = runCatching { pool?.play(sample, .15f, .15f, 1, 0, 1f) ?: 0 }.getOrDefault(0)
                    val playFinishedAt = SystemClock.uptimeMillis()
                    if (stream != 0) {
                        if (BuildConfig.DEBUG) scheduledCount++
                        if (streams.size >= 2) runCatching { pool?.stop(streams.removeFirst()) }
                        streams.addLast(stream)
                    }
                    // JNI/output setup can still cost time after the 80ms callback gate; report it separately.
                    diagnostic(kind, playFinishedAt - ticket.issuedAtMs(), if (stream != 0) "scheduled" else "pool_refused", stream != 0,
                        readAgeMs = ageMs, playDurationMs = playFinishedAt - playStartedAt)
                } else {
                    val reason = when {
                        !allowed -> "inactive"
                        ageMs < 0 || ageMs > NativeAudioPolicy.MAX_CALLBACK_AGE_MS -> "late"
                        exactBoolean != "true" -> "disabled"
                        else -> "rate_or_invalidated"
                    }
                    diagnostic(kind, ageMs, reason, false)
                }
            }
        } catch (_: Exception) {
            policy.authorize(ticket, "false", SystemClock.uptimeMillis())
            diagnostic(kind, SystemClock.uptimeMillis() - ticket.issuedAtMs(), "read_failed", false)
        }
    }

    /** At most one bounded DEBUG line per second and 120 lines per Activity lifetime. */
    private fun diagnostic(kind: NativeAudioPolicy.Kind, ageMs: Long, result: String, success: Boolean,
                           readAgeMs: Long = ageMs, playDurationMs: Long = 0) {
        if (!BuildConfig.DEBUG || diagnosticLines >= 120) return
        val time = SystemClock.uptimeMillis()
        if (lastDiagnosticAt != Long.MIN_VALUE && time >= lastDiagnosticAt && time - lastDiagnosticAt < 1000) return
        lastDiagnosticAt = time; diagnosticLines++
        Log.d("HomeTVNavAudio", "kind=${kind.name} ageMs=${ageMs.coerceIn(-1, 60000)} readAgeMs=${readAgeMs.coerceIn(-1, 60000)} playDurationMs=${playDurationMs.coerceIn(0, 60000)} result=$result streamSuccess=$success scheduledCount=$scheduledCount")
    }

    /** One muted, non-looping clip warms native output off the UI thread; never a silent keepalive loop. */
    fun prewarm() {
        if (released || !foreground || warmupReady) return
        val sample = samples[NativeAudioPolicy.Kind.MOVE] ?: return
        if (sample == 0 || !loaded.contains(sample) || pool == null) return
        warmupRequested.set(true)
        if (!warmupBusy.compareAndSet(false, true)) return
        try {
            warmupExecutor.execute {
                warmupRequested.set(false)
                val generation = warmupGeneration.get()
                val sounds = pool
                try {
                    if (!released && foreground && sounds != null) {
                        val stream = runCatching { sounds.play(sample, 0f, 0f, 0, 0, 1f) }.getOrDefault(0)
                        if (!released && foreground && generation == warmupGeneration.get() && sounds === pool) warmupReady = stream != 0
                    }
                } finally {
                    warmupBusy.set(false)
                    if (warmupRequested.get() && !released && foreground) prewarm()
                }
            }
        } catch (_: Exception) { warmupBusy.set(false); warmupRequested.set(false) }
    }

    fun resume() {
        if (released) return
        foreground = true; warmupReady = false; warmupGeneration.incrementAndGet()
        policy.setActive(true); prewarm()
    }
    fun pause() {
        foreground = false; warmupReady = false; warmupGeneration.incrementAndGet()
        policy.setActive(false); stopStreams()
    }
    fun invalidate() { policy.invalidate(); stopStreams() }
    private fun stopStreams() {
        while (streams.isNotEmpty()) runCatching { pool?.stop(streams.removeFirst()) }
    }
    override fun close() {
        if (released) return
        released = true; foreground = false; warmupReady = false; warmupGeneration.incrementAndGet()
        warmupRequested.set(false); warmupExecutor.shutdownNow(); policy.setActive(false); stopStreams()
        runCatching { pool?.setOnLoadCompleteListener(null) }
        runCatching { pool?.release() }
        pool = null; loaded.clear(); samples.clear()
    }
}
