package org.hometv.launcher

import android.os.Handler
import android.os.SystemClock
import android.os.Process
import android.util.Log
import org.webrtc.VideoFrame
import java.io.File
import java.util.concurrent.atomic.AtomicLong

/** Reference adapter also exercised with the actual SDK's VideoFrame/I420Buffer. */
internal class NativePacerFrameReference(val frame: VideoFrame, val traceSequence: Long = 0) : NativePacedFrame {
    override val timestampNs = frame.timestampNs
    override val isI420 = frame.buffer is VideoFrame.I420Buffer
    override val byteSize = (frame.buffer as? VideoFrame.I420Buffer)?.let { buffer ->
        runCatching {
            require(buffer.width > 0 && buffer.height > 0 && buffer.strideY >= buffer.width &&
                buffer.strideU.toLong() >= (buffer.width.toLong() + 1) / 2 && buffer.strideV.toLong() >= (buffer.width.toLong() + 1) / 2)
            val y = Math.multiplyExact(buffer.strideY.toLong(), buffer.height.toLong())
            val uv = Math.multiplyExact(buffer.strideU.toLong() + buffer.strideV, (buffer.height.toLong() + 1) / 2)
            Math.addExact(y, uv)
        }.getOrDefault(Long.MAX_VALUE)
    } ?: 0L
    @Volatile var wasRetained = false
        private set
    override fun retain() { frame.retain(); wasRetained = true }
    override fun release() = frame.release()
}

/**
 * SDK timestamps are bridged independently into Handler uptime; no first frame
 * defines the time origin. Debug timing holds no image references and exports
 * only on close, outside the measurement window.
 */
/** Experimental absolute-clock playback candidate; offline tests do not establish physical TV acceptance. */
internal class NativeFramePacer(private val worker: Handler, private val present: (VideoFrame) -> Unit,
    delayMs: Long = 500, private val traceDirectory: File? = null) {
    private val trace = if (BuildConfig.DEBUG) NativePacerTimingTrace(nextTraceSession.incrementAndGet()) else null
    private val traceSequence = AtomicLong()
    private val scheduler = object : NativePacerScheduler {
        override fun nowNs() = SystemClock.uptimeMillis() * 1_000_000
        override fun schedule(atNs: Long, task: Runnable): Boolean =
            worker.postAtTime(task, atNs / 1_000_000 + if (atNs % 1_000_000 == 0L) 0 else 1)
        override fun cancel(task: Runnable) = worker.removeCallbacks(task)
    }
    private val timedScheduler = if (trace == null) scheduler else NativePacerTraceScheduler(scheduler) { atNs ->
        val recorder = trace
        if (recorder.beginObservation()) {
            try {
                val nano = System.nanoTime(); val uptime = scheduler.nowNs()
                record(3, 0, 0, nano, uptime, atNs, 0, -1)
            } finally { recorder.endObservation() }
        }
    }
    private val queue = NativeAbsoluteFramePacerPolicy(timedScheduler, ::submit, System::nanoTime, delayMs)

    private fun record(event: Long, sequence: Long, timestamp: Long, nano: Long, uptime: Long,
        due: Long, callbackNs: Long, retained: Long) {
        val recorder = trace ?: return
        // This is a wrapper observation, not an atomic policy decision trace.
        // Only fields common to .5.15 and .5.16 Stats are used intentionally.
        val s = queue.snapshot()
        recorder.record(event, sequence, timestamp, nano, uptime, due, s.queued.toLong(), s.queuedBytes,
            s.headAheadMs, s.tailAheadMs, s.correctionMs, s.offered, s.presented, s.overflowDrops,
            s.lateDrops, s.resets, s.bypassed, s.renderErrors, callbackNs, retained)
    }

    private fun submit(reference: NativePacerFrameReference) {
        // Frames entering after the close admission cutoff have no observation
        // lease/sequence. They still follow the policy but cannot create an
        // unpaired submit outside the declared observation boundary.
        if (trace == null || reference.traceSequence == 0L) { present(reference.frame); return }
        val nano = System.nanoTime(); val uptime = SystemClock.uptimeMillis() * 1_000_000
        var succeeded = false
        try { present(reference.frame); succeeded = true }
        finally {
            record(2, reference.traceSequence, reference.timestampNs, nano, uptime, Long.MIN_VALUE,
                (System.nanoTime() - nano).coerceAtLeast(0), if (succeeded) 1 else -2)
        }
    }

    fun offer(frame: VideoFrame) {
        val recorder = trace
        if (recorder == null || !recorder.beginObservation()) { queue.offer(NativePacerFrameReference(frame)); return }
        // No observer monitor is held across the policy. close can export
        // without waiting; an unfinished post-offer observation then makes
        // schema2's frozen pendingObservations nonzero instead of false-complete.
        try {
            val reference = NativePacerFrameReference(frame, traceSequence.incrementAndGet())
            val nano = System.nanoTime(); val uptime = SystemClock.uptimeMillis() * 1_000_000
            try { queue.offer(reference) }
            finally {
                record(1, reference.traceSequence, reference.timestampNs, nano, uptime, Long.MIN_VALUE,
                    0, if (reference.wasRetained) 1 else 0)
            }
        } finally { recorder.endObservation() }
    }
    fun reset() = queue.reset()
    fun close() {
        // Seal only admissions, not existing records: submit callbacks already
        // inside the policy must finish recording before queue.close returns.
        trace?.sealAdmissions()
        queue.close()
        trace?.let { recorder ->
            if (traceDirectory != null) {
                val result = NativePacerTraceFileExporter().export(recorder, traceDirectory, Process.myPid())
                Log.d("HomeTVPacerTrace", "stage=pacer_trace_file session=${result.session} success=${if (result.success) 1 else 0} bytes=${result.bytes} sha256=${result.sha256 ?: "none"} file=${result.fileName ?: "none"} error=${result.errorCode ?: "none"}")
            } else {
                // Legacy diagnostic callers have no Context/file directory.
                // Never silently accept a negative Android logging return.
                recorder.export { line ->
                    check(Log.d("HomeTVPacerTrace", line) >= 0) { "Trace log write failed" }
                    Thread.sleep(2) // Bounded after-close export only; no frame-path I/O.
                }
            }
        }
    }
    fun snapshot() = queue.snapshot()

    companion object { private val nextTraceSession = AtomicLong() }
}
