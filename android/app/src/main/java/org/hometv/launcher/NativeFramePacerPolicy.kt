package org.hometv.launcher

import java.util.ArrayDeque

internal interface NativePacedFrame {
    val timestampNs: Long
    val byteSize: Long
    val isI420: Boolean
    fun retain()
    fun release()
}

internal interface NativePacerScheduler {
    fun nowNs(): Long
    fun schedule(atNs: Long, task: Runnable): Boolean
    fun cancel(task: Runnable)
}

/** Bounded reference-owning queue. The scheduler must enqueue tasks, never invoke them inline. */
internal class NativeFramePacerPolicy<F : NativePacedFrame>(
    private val scheduler: NativePacerScheduler,
    private val present: (F) -> Unit,
    delayMs: Long = 500,
    private val maxFrames: Int = 10,
    private val maxBytes: Long = 32L * 1024 * 1024,
) {
    /** 'Presented' counts submissions to the renderer callback, not physical display scans. */
    data class Stats(
        val offered: Long, val presented: Long, val bypassed: Long,
        val overflowDrops: Long, val lateDrops: Long, val flushDrops: Long, val resets: Long,
        val fallbackFrames: Long, val renderErrors: Long, val releaseErrors: Long,
        val scheduleErrors: Long, val queued: Int, val queuedBytes: Long,
        val maxPresentedGapMs: Long, val gapsOver250Ms: Long,
        val gapsOver500Ms: Long, val gapsOver1000Ms: Long,
        val headAheadMs: Long, val tailAheadMs: Long, val maxDueAheadMs: Long,
        val sourceSpanMs: Long, val arrivalSpanMs: Long,
        val correctionMs: Long, val correctionCount: Long, val correctionSkipReason: Int,
        val phaseEstimateMs: Long, val phaseSpreadMs: Long, val phaseWindowMs: Long,
        val correctionTargetMs: Long, val maxCorrectionStepUs: Long,
        val maxQueued: Int, val maxQueuedBytes: Long,
        val phaseSamples: Int, val stableWindows: Long, val unstableWindows: Long, val shortWindows: Long,
    )
    private data class Entry<F>(val frame: F, var dueNs: Long, val bytes: Long)
    private data class PhaseSample(val arrivalNs: Long, val phaseNs: Long)
    private val delayNs = delayMs.also { require(it in 500..600) } * 1_000_000
    private val discontinuityNs = 2_000_000_000L
    private val queue = ArrayDeque<Entry<F>>()
    private val task = Runnable { drain() }
    private var scheduledAtNs = Long.MIN_VALUE
    private var closed = false
    private var queuedBytes = 0L
    private var mode = -1 // 1: source timestamps; 0: monotonic arrival fallback.
    private var anchorTimestampNs = 0L
    private var anchorDueNs = 0L
    private var anchorArrivalNs = 0L
    private var lastTimestampNs = 0L
    private var lastArrivalNs = Long.MIN_VALUE
    private var lastPresentedNs = Long.MIN_VALUE
    private var offered = 0L
    private var presented = 0L
    private var bypassed = 0L
    private var overflowDrops = 0L
    private var lateDrops = 0L
    private var flushDrops = 0L
    private var resets = 0L
    private var fallbackFrames = 0L
    private var renderErrors = 0L
    private var releaseErrors = 0L
    private var scheduleErrors = 0L
    private var maxPresentedGapNs = 0L
    private var gapsOver250Ms = 0L
    private var gapsOver500Ms = 0L
    private var gapsOver1000Ms = 0L
    private var maxDueAheadNs = 0L
    private val phaseSamples = ArrayDeque<PhaseSample>()
    private var correctionNs = 0L
    private var correctionCount = 0L
    private var correctionSkipReason = 0
    private var phaseEstimateNs = Long.MIN_VALUE
    private var phaseSpreadNs = 0L
    private var phaseWindowNs = 0L
    private var correctionTargetNs = 0L
    private var stablePhase = false
    private var lastCalibrationNs = Long.MIN_VALUE
    private var maxCorrectionStepNs = 0L
    private var maxQueued = 0
    private var maxQueuedBytes = 0L
    private var stableWindows = 0L
    private var unstableWindows = 0L
    private var shortWindows = 0L

    init { require(maxFrames in 1..10 && maxBytes in 1..32L * 1024 * 1024) }

    /** The caller retains ownership of its original frame on every path. */
    @Synchronized fun offer(frame: F) {
        if (closed) return
        offered++
        val now = scheduler.nowNs()
        if (!frame.isI420 || frame.byteSize <= 0 || frame.byteSize > maxBytes) {
            // Never retain textures. A format switch also cannot leave older raw
            // frames scheduled to overwrite a more recent bypassed frame.
            flush(); mode = -1; lastArrivalNs = Long.MIN_VALUE; beginCalibration(0)
            bypassed++; deliver(frame, now, owned = false)
            return
        }
        val timestampDelta = subtract(frame.timestampNs, lastTimestampNs)
        // A stuck/backwards positive timestamp is also invalid. Stay on arrival
        // timing until it advances, rather than resetting every frame forever.
        val nextMode = if (frame.timestampNs > 0 && (lastArrivalNs == Long.MIN_VALUE || lastTimestampNs <= 0 || timestampDelta != null && timestampDelta > 0)) 1 else 0
        val arrivalDelta = if (lastArrivalNs == Long.MIN_VALUE) 0 else subtract(now, lastArrivalNs)
        val reset = mode != -1 && (mode != nextMode || arrivalDelta == null || arrivalDelta < 0 || arrivalDelta > discontinuityNs ||
            nextMode == 1 && (timestampDelta == null || timestampDelta <= 0 || timestampDelta > discontinuityNs))
        if (reset) { flush(); mode = -1; resets++ }
        if (mode == -1) anchor(frame.timestampNs, now, nextMode)
        var due = if (nextMode == 1) subtract(frame.timestampNs, anchorTimestampNs)?.let { add(anchorDueNs, it) } else add(now, delayNs)
        // Reject a drifting/corrupt source clock without guessing any frame rate.
        val ahead = due?.let { subtract(it, now) }
        if (due == null || ahead == null || ahead > delayNs + discontinuityNs || ahead < -discontinuityNs) {
            flush(); resets++; anchor(frame.timestampNs, now, nextMode); due = anchorDueNs
        }
        mode = nextMode; lastTimestampNs = frame.timestampNs; lastArrivalNs = now
        if (nextMode == 0) fallbackFrames++
        // Observe EVERY decoded frame before capacity rejection. Learning only
        // from admitted frames would bias the estimate precisely during overflow.
        val shift = calibrate(now, frame.timestampNs, due)
        due -= shift
        subtract(due, now)?.let { maxDueAheadNs = maxOf(maxDueAheadNs, it.coerceAtLeast(0)) }
        if (queue.size >= maxFrames || queuedBytes + frame.byteSize > maxBytes) {
            // Preserve even an already-ready head and its queued worker. If the
            // decoder wins an equal-time race, evicting that head and replacing
            // its task with a future one can starve presentation indefinitely.
            // Only drain removes due frames; genuine capacity loss stays visible.
            overflowDrops++; scheduleHead(); return
        }
        frame.retain()
        queue.addLast(Entry(frame, due, frame.byteSize)); queuedBytes += frame.byteSize
        maxQueued = maxOf(maxQueued, queue.size); maxQueuedBytes = maxOf(maxQueuedBytes, queuedBytes)
        scheduleHead()
    }

    private fun anchor(timestamp: Long, now: Long, nextMode: Int) {
        anchorTimestampNs = timestamp; anchorDueNs = add(now, delayNs) ?: Long.MAX_VALUE
        anchorArrivalNs = now
        mode = nextMode
        beginCalibration(nextMode)
    }

    private fun beginCalibration(nextMode: Int) {
        phaseSamples.clear(); correctionNs = 0
        phaseEstimateNs = Long.MIN_VALUE; phaseSpreadNs = 0; phaseWindowNs = 0; correctionTargetNs = 0
        stablePhase = false
        lastCalibrationNs = Long.MIN_VALUE
        correctionSkipReason = if (nextMode == 0) 3 else 1
    }

    /**
     * SDK timestamps follow receiver render_time, whose phase can keep moving
     * AFTER the first output. Track its persistent phase, not each arrival gap.
     *
     * A bounded 1 s /64-sample window and central-half spread reject short
     * pauses/bursts. Slew with a <=5% elapsed-time budget, <=5 ms per step,
     * in either direction, within +/- one 500..600 ms reserve.
     * Held deadlines move together; this slightly changes playback speed while
     * converging, never adds references or flushes frames as a phase correction.
     */
    private fun calibrate(now: Long, timestamp: Long, currentDue: Long): Long {
        if (mode != 1) return 0
        if (lastCalibrationNs == Long.MIN_VALUE) lastCalibrationNs = now
        val sourceSpan = subtract(timestamp, anchorTimestampNs) ?: return 0
        val arrivalSpan = subtract(now, anchorArrivalNs) ?: return 0
        val phase = subtract(sourceSpan, arrivalSpan) ?: return 0
        // A decoder burst at one clock tick is one timing observation, not
        // many independent votes for a new phase. Keep the latest frame there.
        if (phaseSamples.peekLast()?.arrivalNs == now) phaseSamples.removeLast()
        phaseSamples.addLast(PhaseSample(now, phase))
        while (phaseSamples.size > 64 || now - (phaseSamples.peekFirst()?.arrivalNs ?: now) > 1_000_000_000) phaseSamples.removeFirst()
        phaseWindowNs = now - (phaseSamples.peekFirst()?.arrivalNs ?: now)
        if (phaseSamples.size < 8 || phaseWindowNs < 800_000_000) {
            stablePhase = false; lastCalibrationNs = now; shortWindows++; correctionSkipReason = 1; return 0
        }
        val phases = phaseSamples.map { it.phaseNs }.sorted()
        phaseEstimateNs = phases[phases.size / 2]
        phaseSpreadNs = phases[phases.size * 3 / 4] - phases[phases.size / 4]
        if (phaseSpreadNs > 50_000_000) {
            stablePhase = false; lastCalibrationNs = now; unstableWindows++; correctionSkipReason = 2; return 0
        }
        stablePhase = true
        stableWindows++
        correctionTargetNs = phaseEstimateNs.coerceIn(-delayNs, delayNs)
        return applyPhaseShift(now, currentDue)
    }

    /** Also runs after drain, so equal-time decoder/worker ordering cannot lock phase. */
    private fun applyPhaseShift(now: Long, currentDue: Long? = null): Long {
        // A worker may consume the current observation's budget just after a
        // ready frame was delivered. Never use it to chase a decoder pause.
        if (!stablePhase || lastArrivalNs == Long.MIN_VALUE ||
            (subtract(now, lastArrivalNs) ?: Long.MAX_VALUE) !in 0..100_000_000) {
            lastCalibrationNs = now; return 0
        }
        val elapsed = if (lastCalibrationNs == Long.MIN_VALUE) 0L else
            (subtract(now, lastCalibrationNs) ?: 0L).coerceIn(0, 100_000_000)
        val error = correctionTargetNs - correctionNs
        correctionSkipReason = 0
        if (error in -5_000_000..5_000_000) { lastCalibrationNs = now; return 0 }
        var shift = error.coerceIn(-elapsed / 20, elapsed / 20)
        val first = queue.peekFirst()
        if (first != null) {
            // Do not postpone an overdue worker task or compress a head into a
            // catch-up burst. Let drain account for genuine worker lateness.
            if (first.dueNs <= now) { correctionSkipReason = 4; return 0 }
            if (shift > 0) {
                // Reaching 'now' is safe: the worker enqueues one submission.
                // A fixed future guard here can phase-lock a regular stream
                // forever a few ms before each arrival, preventing convergence.
                val earliest = maxOf(now,
                    if (lastPresentedNs == Long.MIN_VALUE) Long.MIN_VALUE else add(lastPresentedNs, 5_000_000) ?: Long.MAX_VALUE)
                shift = minOf(shift, (subtract(first.dueNs, earliest) ?: 0L).coerceAtLeast(0))
                if (shift == 0L) correctionSkipReason = 4
            }
        }
        if (shift == 0L) return 0
        if (subtract(anchorDueNs, shift) == null || currentDue != null && subtract(currentDue, shift) == null ||
            queue.any { subtract(it.dueNs, shift) == null }) { correctionSkipReason = 4; return 0 }
        for (entry in queue) entry.dueNs -= shift
        anchorDueNs -= shift
        correctionNs += shift; correctionCount++
        lastCalibrationNs = now
        maxCorrectionStepNs = maxOf(maxCorrectionStepNs, if (shift < 0) -shift else shift)
        return shift
    }

    /** One worker task presents the newest due frame, never a catch-up burst. */
    @Synchronized private fun drain() {
        scheduledAtNs = Long.MIN_VALUE
        if (closed) return
        val now = scheduler.nowNs()
        var next: Entry<F>? = null
        while (true) {
            val head = queue.peekFirst() ?: break
            if (head.dueNs > now) break
            next?.let { lateDrops++; release(it.frame) }
            next = queue.removeFirst().also { queuedBytes -= it.bytes }
        }
        next?.let { deliver(it.frame, now, owned = true) }
        // If offer arrived before this ready worker at the same tick, its
        // bounded budget is still available. No overdue frame is postponed.
        applyPhaseShift(now)
        scheduleHead()
    }

    private fun deliver(frame: F, now: Long, owned: Boolean) {
        try {
            present(frame)
            if (lastPresentedNs != Long.MIN_VALUE && now >= lastPresentedNs) {
                val gap = now - lastPresentedNs
                maxPresentedGapNs = maxOf(maxPresentedGapNs, gap)
                if (gap > 250_000_000) gapsOver250Ms++
                if (gap > 500_000_000) gapsOver500Ms++
                if (gap > 1_000_000_000) gapsOver1000Ms++
            }
            lastPresentedNs = now; presented++
        } catch (_: RuntimeException) { renderErrors++ }
        finally { if (owned) release(frame) }
    }

    private fun scheduleHead() {
        val due = queue.peekFirst()?.dueNs
        if (due != null && scheduledAtNs == due) return
        scheduler.cancel(task); scheduledAtNs = Long.MIN_VALUE
        if (due != null) {
            scheduledAtNs = due
            if (!scheduler.schedule(due, task)) { scheduledAtNs = Long.MIN_VALUE; closed = true; scheduleErrors++; flush() }
        }
    }

    private fun release(frame: F) { try { frame.release() } catch (_: RuntimeException) { releaseErrors++ } }
    private fun flush() {
        scheduler.cancel(task); scheduledAtNs = Long.MIN_VALUE
        while (queue.isNotEmpty()) { flushDrops++; release(queue.removeFirst().frame) }
        queuedBytes = 0
    }

    /** Waits for any short present callback under this lock; safe before renderer release. */
    @Synchronized fun close() { if (!closed) { closed = true; flush() } }
    @Synchronized fun reset() { if (!closed) { flush(); mode = -1; lastArrivalNs = Long.MIN_VALUE; lastPresentedNs = Long.MIN_VALUE; beginCalibration(-1); resets++ } }
    @Synchronized fun snapshot(): Stats {
        val now = scheduler.nowNs()
        fun ahead(entry: Entry<F>?) = entry?.let { subtract(it.dueNs, now)?.div(1_000_000)?.coerceIn(-2500, 2500) } ?: 0L
        fun span(end: Long, start: Long) = subtract(end, start)?.takeIf { it >= 0 }?.div(1_000_000) ?: -1L
        return Stats(offered, presented, bypassed, overflowDrops, lateDrops, flushDrops, resets, fallbackFrames,
            renderErrors, releaseErrors, scheduleErrors, queue.size, queuedBytes, maxPresentedGapNs / 1_000_000,
            gapsOver250Ms, gapsOver500Ms, gapsOver1000Ms, ahead(queue.peekFirst()), ahead(queue.peekLast()),
            (maxDueAheadNs / 1_000_000).coerceIn(0, 2500),
            if (mode == 1) span(lastTimestampNs, anchorTimestampNs) else -1,
            if (mode != -1 && lastArrivalNs != Long.MIN_VALUE) span(lastArrivalNs, anchorArrivalNs) else -1,
            correctionNs / 1_000_000, correctionCount, correctionSkipReason,
            if (phaseEstimateNs == Long.MIN_VALUE) -2501 else (phaseEstimateNs / 1_000_000).coerceIn(-2500, 2500),
            phaseSpreadNs / 1_000_000, phaseWindowNs / 1_000_000,
            correctionTargetNs / 1_000_000, maxCorrectionStepNs / 1000, maxQueued, maxQueuedBytes,
            phaseSamples.size, stableWindows, unstableWindows, shortWindows)
    }
    private fun add(a: Long, b: Long): Long? = try { Math.addExact(a, b) } catch (_: ArithmeticException) { null }
    private fun subtract(a: Long, b: Long): Long? = try { Math.subtractExact(a, b) } catch (_: ArithmeticException) { null }
}
