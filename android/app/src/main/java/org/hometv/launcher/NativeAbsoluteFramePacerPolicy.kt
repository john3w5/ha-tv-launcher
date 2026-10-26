package org.hometv.launcher

import java.util.ArrayDeque

/**
 * Bounded I420 pacing from SDK render deadlines in the source clock's domain.
 *
 * The clock bridge is sampled independently of frame timestamps, once at
 * construction and on explicit reset. No first-frame PTS becomes a time origin.
 * The scheduler must enqueue work, never invoke it inline. The two clock readers
 * must be short local monotonic-clock calls, not I/O or callbacks into this queue.
 */
internal class NativeAbsoluteFramePacerPolicy<F : NativePacedFrame>(
    private val scheduler: NativePacerScheduler,
    private val present: (F) -> Unit,
    private val sourceNowNs: () -> Long,
    delayMs: Long = 500,
    private val maxFrames: Int = 10,
    private val maxBytes: Long = 32L * 1024 * 1024,
) {
    /** Presented means renderer callback submissions, not physical display scans. */
    data class Stats(
        val offered: Long, val presented: Long, val bypassed: Long,
        val overflowDrops: Long, val lateDrops: Long, val flushDrops: Long, val resets: Long,
        val fallbackFrames: Long, val renderErrors: Long, val releaseErrors: Long,
        val scheduleErrors: Long, val queued: Int, val queuedBytes: Long,
        val maxPresentedGapMs: Long, val gapsOver250Ms: Long,
        val gapsOver500Ms: Long, val gapsOver1000Ms: Long,
        val headAheadMs: Long, val tailAheadMs: Long, val maxDueAheadMs: Long,
        val sourceSpanMs: Long, val arrivalSpanMs: Long,
        // Compatibility only: absolute scheduling performs no phase estimation or slew.
        val correctionMs: Long, val correctionCount: Long, val correctionSkipReason: Int,
        val phaseEstimateMs: Long, val phaseSpreadMs: Long, val phaseWindowMs: Long,
        val correctionTargetMs: Long, val maxCorrectionStepUs: Long,
        val maxQueued: Int, val maxQueuedBytes: Long,
        val phaseSamples: Int, val stableWindows: Long, val unstableWindows: Long, val shortWindows: Long,
        val invalidClockFrames: Long, val expiredAtOffer: Long, val absoluteFrames: Long,
        val bridgeValid: Boolean, val bridgeOffsetNs: Long, val bridgeSampleWidthNs: Long,
        val bridgeSamples: Long, val bridgeFailures: Long,
        // Long.MIN_VALUE means no successfully subtracted source lead was observed.
        val lastRawLeadNs: Long, val minRawLeadNs: Long, val maxRawLeadNs: Long,
        val maxDueAheadNs: Long,
    )

    private data class Entry<F>(val frame: F, val dueNs: Long, val bytes: Long)
    private val delayNs = delayMs.also { require(it in 500..600) } * 1_000_000
    private val minimumLeadNs = -2_000_000_000L
    private val maximumLeadNs = 1_500_000_000L
    private val maximumBridgeWidthNs = 5_000_000L
    private val discontinuityNs = 2_000_000_000L
    private val queue = ArrayDeque<Entry<F>>()
    private val task = Runnable { drain() }
    private var scheduledAtNs = Long.MIN_VALUE
    private var closed = false
    private var queuedBytes = 0L
    private var mode = -1 // 1: absolute SDK deadlines; 0: explicit arrival fallback.
    private var firstTimestampNs = 0L // Spans are diagnostics only, never deadline inputs.
    private var firstArrivalNs = 0L
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
    private var maxQueued = 0
    private var maxQueuedBytes = 0L
    private var invalidClockFrames = 0L
    private var expiredAtOffer = 0L
    private var absoluteFrames = 0L
    private var bridgeValid = false
    private var bridgeOffsetNs = 0L // scheduler uptime minus source midpoint.
    private var bridgeSampleWidthNs = -1L
    private var bridgeSamples = 0L
    private var bridgeFailures = 0L
    private var observedLeads = 0L
    private var lastRawLeadNs = Long.MIN_VALUE
    private var minRawLeadNs = Long.MAX_VALUE
    private var maxRawLeadNs = Long.MIN_VALUE

    init {
        require(maxFrames in 1..10 && maxBytes in 1..32L * 1024 * 1024)
        sampleBridge()
    }

    /** The caller keeps its original reference on every path. */
    @Synchronized fun offer(frame: F) {
        if (closed) return
        offered++
        val now = scheduler.nowNs()
        if (!frame.isI420 || frame.byteSize <= 0 || frame.byteSize > maxBytes) {
            flush(); clearTimeline()
            bypassed++
            deliver(frame, now, owned = false)
            return
        }

        val sourceNow = readSourceClock()
        val rawLead = sourceNow?.let { subtract(frame.timestampNs, it) }
        if (rawLead != null) {
            observedLeads++
            lastRawLeadNs = rawLead
            minRawLeadNs = minOf(minRawLeadNs, rawLead)
            maxRawLeadNs = maxOf(maxRawLeadNs, rawLead)
        }
        val timestampDelta = subtract(frame.timestampNs, lastTimestampNs)
        val backwardsOrDuplicate = lastArrivalNs != Long.MIN_VALUE && lastTimestampNs > 0 &&
            frame.timestampNs > 0 && (timestampDelta == null || timestampDelta <= 0)
        val arrivalDelta = if (lastArrivalNs == Long.MIN_VALUE) 0L else subtract(now, lastArrivalNs)
        val backwardsArrival = arrivalDelta == null || arrivalDelta < 0
        val mapped = if (bridgeValid) add(frame.timestampNs, bridgeOffsetNs) else null
        val requestedDue = mapped?.let { add(it, delayNs) }
        val mappedAhead = requestedDue?.let { subtract(it, now) }
        // Clock-domain validity is distinct from capacity feasibility. A valid
        // +1500 ms lead can still exceed ten buffers; any such loss is reported.
        // Midpoint sampling can differ from the actual paired-clock offset by
        // half its bracket, plus one millisecond for the uptime clock resolution.
        // Allow that uncertainty only on the expired side: the future deadline
        // ceiling remains exact, and no valid late frame gains a fresh reserve.
        val bridgeUncertaintyNs = bridgeSampleWidthNs.coerceAtLeast(0) / 2 + 1_000_000
        val valid = bridgeValid && frame.timestampNs > 0 && rawLead != null &&
            rawLead in minimumLeadNs..maximumLeadNs && !backwardsOrDuplicate && !backwardsArrival &&
            requestedDue != null && mappedAhead != null &&
            mappedAhead in (delayNs + minimumLeadNs - bridgeUncertaintyNs)..(delayNs + maximumLeadNs)
        val nextMode = if (valid) 1 else 0
        if (!valid) invalidClockFrames++
        val discontinuity = mode != -1 && (mode != nextMode || backwardsArrival ||
            arrivalDelta > discontinuityNs)
        if (discontinuity) { flush(); clearTimeline(); resets++ }
        if (mode == -1) {
            firstTimestampNs = frame.timestampNs; firstArrivalNs = now
        }
        mode = nextMode; lastTimestampNs = frame.timestampNs; lastArrivalNs = now

        val due: Long
        if (valid) {
            absoluteFrames++
            val requested = requestedDue!!
            // Valid but expired render deadlines never receive a fresh reserve.
            // Their decoder-startup gap remains visible instead of being hidden
            // by frame-specific +500 ms padding or a new first-frame anchor.
            if (requested < now) expiredAtOffer++
            due = maxOf(now, requested)
        } else {
            fallbackFrames++
            val fallback = add(now, delayNs)
            if (fallback == null) {
                // No representable future deadline exists. Preserve accounting
                // and ownership with an explicit immediate bypass, not wraparound.
                flush(); clearTimeline(); resets++; bypassed++
                deliver(frame, now, owned = false)
                return
            }
            due = fallback
        }
        subtract(due, now)?.let { maxDueAheadNs = maxOf(maxDueAheadNs, it.coerceAtLeast(0)) }
        if (queue.size >= maxFrames || queuedBytes + frame.byteSize > maxBytes) {
            // Preserve ready heads too: evicting one before its equal-time worker
            // can cancel presentation indefinitely while input keeps arriving.
            overflowDrops++; scheduleHead(); return
        }
        frame.retain()
        queue.addLast(Entry(frame, due, frame.byteSize)); queuedBytes += frame.byteSize
        maxQueued = maxOf(maxQueued, queue.size); maxQueuedBytes = maxOf(maxQueuedBytes, queuedBytes)
        scheduleHead()
    }

    /** Sample only local clocks; SDK frame timestamps have no role in this bridge. */
    private fun sampleBridge() {
        bridgeSamples++
        bridgeValid = false; bridgeOffsetNs = 0; bridgeSampleWidthNs = -1
        val before = readSourceClock()
        val uptime = scheduler.nowNs()
        val after = readSourceClock()
        val width = if (before != null && after != null) subtract(after, before) else null
        if (width != null) bridgeSampleWidthNs = width
        if (before == null || width == null || width !in 0..maximumBridgeWidthNs) {
            bridgeFailures++; return
        }
        val midpoint = add(before, width / 2)
        val offset = midpoint?.let { subtract(uptime, it) }
        if (offset == null) { bridgeFailures++; return }
        bridgeOffsetNs = offset
        bridgeValid = true
    }

    private fun readSourceClock(): Long? = try { sourceNowNs() } catch (_: RuntimeException) { null }

    /** One worker submits the newest due frame; every superseded due frame is counted. */
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
        scheduleHead()
    }

    private fun deliver(frame: F, now: Long, owned: Boolean) {
        try {
            present(frame)
            if (lastPresentedNs != Long.MIN_VALUE) {
                subtract(now, lastPresentedNs)?.takeIf { it >= 0 }?.let { gap ->
                    maxPresentedGapNs = maxOf(maxPresentedGapNs, gap)
                    if (gap > 250_000_000) gapsOver250Ms++
                    if (gap > 500_000_000) gapsOver500Ms++
                    if (gap > 1_000_000_000) gapsOver1000Ms++
                }
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
            if (!scheduler.schedule(due, task)) {
                scheduledAtNs = Long.MIN_VALUE; closed = true; scheduleErrors++; flush()
            }
        }
    }

    private fun release(frame: F) { try { frame.release() } catch (_: RuntimeException) { releaseErrors++ } }
    private fun flush() {
        scheduler.cancel(task); scheduledAtNs = Long.MIN_VALUE
        while (queue.isNotEmpty()) { flushDrops++; release(queue.removeFirst().frame) }
        queuedBytes = 0
    }
    private fun clearTimeline() { mode = -1; lastArrivalNs = Long.MIN_VALUE }

    /** Waits for the short renderer callback before releasing queued references. */
    @Synchronized fun close() { if (!closed) { closed = true; flush() } }
    @Synchronized fun reset() {
        if (closed) return
        flush(); clearTimeline(); lastPresentedNs = Long.MIN_VALUE; resets++
        sampleBridge()
    }
    @Synchronized fun snapshot(): Stats {
        val now = scheduler.nowNs()
        fun ahead(entry: Entry<F>?) = entry?.let { subtract(it.dueNs, now)?.div(1_000_000) } ?: 0L
        fun span(end: Long, start: Long) = subtract(end, start)?.takeIf { it >= 0 }?.div(1_000_000) ?: -1L
        return Stats(
            offered, presented, bypassed, overflowDrops, lateDrops, flushDrops, resets,
            fallbackFrames, renderErrors, releaseErrors, scheduleErrors, queue.size, queuedBytes,
            maxPresentedGapNs / 1_000_000, gapsOver250Ms, gapsOver500Ms, gapsOver1000Ms,
            ahead(queue.peekFirst()), ahead(queue.peekLast()), maxDueAheadNs / 1_000_000,
            if (mode == 1) span(lastTimestampNs, firstTimestampNs) else -1,
            if (mode != -1 && lastArrivalNs != Long.MIN_VALUE) span(lastArrivalNs, firstArrivalNs) else -1,
            0, 0, 0, 0, 0, 0, 0, 0,
            maxQueued, maxQueuedBytes, 0, 0, 0, 0,
            invalidClockFrames, expiredAtOffer, absoluteFrames, bridgeValid, bridgeOffsetNs,
            bridgeSampleWidthNs, bridgeSamples, bridgeFailures, lastRawLeadNs,
            if (observedLeads == 0L) Long.MIN_VALUE else minRawLeadNs,
            if (observedLeads == 0L) Long.MIN_VALUE else maxRawLeadNs, maxDueAheadNs,
        )
    }
    private fun add(a: Long, b: Long): Long? = try { Math.addExact(a, b) } catch (_: ArithmeticException) { null }
    private fun subtract(a: Long, b: Long): Long? = try { Math.subtractExact(a, b) } catch (_: ArithmeticException) { null }
}
