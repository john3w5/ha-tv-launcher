package org.hometv.launcher

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private class AbsoluteClock(private val ceilToMillis: Boolean = true) : NativePacerScheduler {
    var now = 0L
    var sourceOriginNs = 10_000_000_000L
    var reject = false
    var maxTasks = 0
    private val tasks = ArrayList<Pair<Long, Runnable>>()
    override fun nowNs() = now
    fun sourceNow() = Math.addExact(sourceOriginNs, now)
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        if (reject) return false
        val at = if (ceilToMillis) (atNs / 1_000_000 + if (atNs % 1_000_000 == 0L) 0 else 1) * 1_000_000 else atNs
        tasks.add(at to task); maxTasks = maxOf(maxTasks, tasks.size)
        return true
    }
    override fun cancel(task: Runnable) { tasks.removeAll { it.second === task } }
    fun advanceMs(ms: Long, inclusive: Boolean = true) = advanceNs(ms * 1_000_000, inclusive)
    fun advanceNs(target: Long, inclusive: Boolean = true) {
        check(target >= now)
        while (true) {
            val next = tasks.minByOrNull { it.first } ?: break
            if (next.first > target || !inclusive && next.first == target) break
            tasks.remove(next); now = maxOf(now, next.first); next.second.run()
        }
        now = target
    }
    fun taskCount() = tasks.size
}

private class AbsoluteRef(val id: Int, override val timestampNs: Long,
    override val byteSize: Long = 3_110_400,
    override val isI420: Boolean = true, private var failRelease: Boolean = false) : NativePacedFrame {
    var references = 1
    var retains = 0
    var releases = 0
    override fun retain() { check(references > 0); references++; retains++ }
    override fun release() {
        check(references > 1); references--; releases++
        if (failRelease) { failRelease = false; throw IllegalStateException("Consumed release fixture") }
    }
}

fun main() {
    var checks = 0
    fun expect(value: Boolean) { check(value) { "Absolute pacer invariant failed at assertion ${checks + 1}" }; checks++ }
    fun settled(vararg frames: AbsoluteRef) {
        frames.forEach { expect(it.references == 1 && it.retains == it.releases) }
    }
    fun bounded(p: NativeAbsoluteFramePacerPolicy<AbsoluteRef>) {
        val s = p.snapshot()
        expect(s.queued <= 10 && s.queuedBytes <= 32L * 1024 * 1024)
        expect(s.maxDueAheadNs <= 2_000_000_000L)
    }

    // Historical D1 STARTUP SHAPE only, not a replay or physical-TV evidence.
    // The first valid SDK render deadline is 864 ms late. Decoder output then
    // pauses for 588 ms, catches up, and reaches a normal ~9 ms future lead.
    // Expired frames get NOW, not a fresh reserve; all future deadlines keep
    // their SDK intervals. The real startup pause must stay visible.
    run {
        val clock = AbsoluteClock(); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id to clock.now) }, clock::sourceNow)
        val arrivals = listOf(0L, 588, 674, 694, 706, 719, 729, 760, 770, 796, 814, 828, 836, 849, 863, 889)
        val sdkTimes = listOf(-864L, -150, -1, 128, 234, 286, 359, 407, 454, 550, 602, 650, 698, 746, 803, 898)
        val frames = ArrayList<AbsoluteRef>()
        for (index in arrivals.indices) {
            val f = AbsoluteRef(index, clock.sourceOriginNs + sdkTimes[index] * 1_000_000)
            frames.add(f); clock.advanceMs(arrivals[index]); p.offer(f); clock.advanceMs(arrivals[index]); bounded(p)
        }
        for (index in 16 until 180) {
            val arrival = 959L + (index - 16) * 70
            clock.advanceMs(arrival)
            val f = AbsoluteRef(index, clock.sourceNow() + 9_000_000)
            frames.add(f); p.offer(f); bounded(p)
        }
        clock.advanceMs(14000)
        val s = p.snapshot()
        expect(shown.map { it.first } == frames.map { it.id })
        expect(shown[0].second == 0L && shown[1].second == 588_000_000L)
        expect(s.maxPresentedGapMs == 588L && s.gapsOver500Ms == 1L)
        expect(s.expiredAtOffer == 4L && s.invalidClockFrames == 0L && s.fallbackFrames == 0L)
        expect(s.overflowDrops == 0L && s.lateDrops == 0L && s.flushDrops == 0L && s.resets == 0L)
        expect(s.maxQueued <= 10 && s.maxDueAheadMs <= 510)
        expect(s.correctionMs == 0L && s.correctionCount == 0L && s.phaseSamples == 0)
        expect(shown.filter { it.first >= 16 }.zipWithNext().all { (a, b) -> b.second - a.second == 70_000_000L })
        expect(clock.maxTasks == 1 && s.bridgeSamples == 1L && s.bridgeValid)
        p.close(); settled(*frames.toTypedArray())
    }

    // Sustainable 60/120 MS source cadences keep every planned interval,
    // including a fractional-nanosecond deadline rounded by the Handler model.
    for (cadence in listOf(60L, 120L)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id to clock.now) }, clock::sourceNow)
        val frames = ArrayList<AbsoluteRef>()
        for (index in 0 until 160) {
            clock.advanceMs(index * cadence)
            val f = AbsoluteRef(index, clock.sourceNow() + 9_123_457)
            frames.add(f); p.offer(f); bounded(p)
        }
        clock.advanceMs(20000)
        val s = p.snapshot()
        expect(shown.map { it.first } == frames.map { it.id })
        expect(shown.first().second == 510_000_000L)
        expect(shown.zipWithNext().all { (a, b) -> b.second - a.second == cadence * 1_000_000 })
        expect(s.overflowDrops == 0L && s.lateDrops == 0L && s.flushDrops == 0L)
        expect(s.sourceSpanMs == (frames.size - 1) * cadence && s.arrivalSpanMs == (frames.size - 1) * cadence)
        expect(s.bridgeOffsetNs == -clock.sourceOriginNs && s.bridgeSampleWidthNs == 0L)
        p.close(); settled(*frames.toTypedArray())
    }

    // Clock-domain offsets, including a large absolute source-clock origin,
    // are bridged from local clock samples rather than the first frame PTS.
    for (origin in listOf(3_000_000_000L, 1_700_000_000_000_000_000L)) run {
        val clock = AbsoluteClock().apply { sourceOriginNs = origin; now = 300_000_000 }
        val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, clock::sourceNow)
        val f = AbsoluteRef(1, clock.sourceNow() + 10_000_000)
        p.offer(f); clock.advanceMs(809); expect(shown.isEmpty())
        clock.advanceMs(810); expect(shown == listOf(810_000_000L))
        expect(p.snapshot().bridgeOffsetNs == -origin && p.snapshot().invalidClockFrames == 0L)
        p.close(); settled(f)
    }
    run {
        val clock = AbsoluteClock().apply { now = 500_000_000 }
        var reads = 0
        val read = {
            when (reads++) { 0 -> clock.sourceOriginNs + 498_000_000; 1 -> clock.sourceOriginNs + 502_000_000; else -> clock.sourceNow() }
        }
        val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, read)
        expect(p.snapshot().bridgeValid && p.snapshot().bridgeSampleWidthNs == 4_000_000L)
        expect(p.snapshot().bridgeOffsetNs == -clock.sourceOriginNs)
        val f = AbsoluteRef(1, clock.sourceNow() + 10_000_000)
        p.offer(f); clock.advanceMs(1010); expect(shown == listOf(1_010_000_000L))
        p.close(); settled(f)
    }

    // An asymmetric but admitted bridge bracket and millisecond uptime
    // quantization cannot turn a valid expired -2 s raw lead into a new reserve.
    // The strict future-horizon ceiling still reports a borderline +1.5 s lead
    // as clock-invalid when midpoint uncertainty maps it beyond two seconds.
    for (sampleSkew in listOf(-2_500_000L, 2_500_000L)) run {
        val clock = AbsoluteClock().apply { now = 100_000_000 }
        var reads = 0
        val read = {
            when (reads++) {
                0 -> clock.sourceNow() + sampleSkew - 2_500_000
                1 -> clock.sourceNow() + sampleSkew + 2_500_000
                else -> clock.sourceNow()
            }
        }
        val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, read)
        expect(p.snapshot().bridgeValid && p.snapshot().bridgeSampleWidthNs == 5_000_000L)
        val late = AbsoluteRef(1, clock.sourceNow() - 2_000_000_000L)
        p.offer(late); clock.advanceMs(100)
        expect(shown == listOf(100_000_000L))
        expect(p.snapshot().expiredAtOffer == 1L && p.snapshot().invalidClockFrames == 0L)
        val future = AbsoluteRef(2, clock.sourceNow() + 1_500_000_000L)
        p.offer(future)
        expect(p.snapshot().invalidClockFrames == if (sampleSkew < 0) 1L else 0L)
        bounded(p); p.close(); settled(late, future)
    }

    // A slow or backwards bridge sample is invalid, not silently accepted or
    // re-sampled against successive frames. Explicit reset obtains a new bridge.
    for (sampleWidth in listOf(6_000_000L, -1L)) run {
        val clock = AbsoluteClock(); var reads = 0
        val read = { when (reads++) { 0 -> clock.sourceOriginNs; 1 -> clock.sourceOriginNs + sampleWidth; else -> clock.sourceNow() } }
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, read)
        val a = AbsoluteRef(1, clock.sourceNow()); p.offer(a)
        expect(!p.snapshot().bridgeValid && p.snapshot().bridgeFailures == 1L)
        expect(p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L)
        expect(p.snapshot().bridgeSamples == 1L && p.snapshot().headAheadMs == 500L)
        clock.advanceMs(100); p.reset()
        expect(p.snapshot().bridgeValid && p.snapshot().bridgeSamples == 2L && p.snapshot().flushDrops == 1L)
        val b = AbsoluteRef(2, clock.sourceNow()); p.offer(b); clock.advanceMs(600)
        expect(p.snapshot().presented == 1L && p.snapshot().resets == 1L)
        p.close(); settled(a, b)
    }

    // Inclusive raw-lead boundaries. Already expired VALID times are submitted
    // immediately; exactly-NOW deadlines are not counted as already expired.
    for (lead in listOf(-2_000_000_000L, -600_000_000L, -500_000_000L, -499_000_000L, 1_500_000_000L)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, clock::sourceNow)
        val f = AbsoluteRef(1, clock.sourceNow() + lead)
        p.offer(f)
        val due = maxOf(0, 500_000_000L + lead)
        clock.advanceNs(due)
        expect(shown == listOf(due))
        val s = p.snapshot()
        expect(s.invalidClockFrames == 0L && s.absoluteFrames == 1L && s.fallbackFrames == 0L)
        expect(s.expiredAtOffer == if (lead < -500_000_000L) 1L else 0L)
        expect(s.lastRawLeadNs == lead && s.minRawLeadNs == lead && s.maxRawLeadNs == lead)
        bounded(p); p.close(); settled(f)
    }
    for (lead in listOf(-2_000_000_001L, 1_500_000_001L)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, clock::sourceNow)
        val f = AbsoluteRef(1, clock.sourceNow() + lead)
        p.offer(f); clock.advanceMs(499); expect(shown.isEmpty())
        clock.advanceMs(500); expect(shown == listOf(500_000_000L))
        expect(p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L && p.snapshot().expiredAtOffer == 0L)
        p.close(); settled(f)
    }

    // Duplicate/backwards source clocks cause one counted mode transition,
    // remain in explicit arrival fallback while stuck, and account for every flush.
    for (secondTimestampDelta in listOf(0L, -20_000_000L)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Int>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id) }, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceOriginNs + 100_000_000)
        val b = AbsoluteRef(2, a.timestampNs + secondTimestampDelta)
        val c = AbsoluteRef(3, b.timestampNs)
        val d = AbsoluteRef(4, clock.sourceOriginNs + 150_000_000)
        p.offer(a); clock.advanceMs(50); p.offer(b); clock.advanceMs(100); p.offer(c)
        expect(p.snapshot().resets == 1L && p.snapshot().flushDrops == 1L)
        expect(p.snapshot().fallbackFrames == 2L && p.snapshot().invalidClockFrames == 2L)
        clock.advanceMs(150); p.offer(d); clock.advanceMs(650)
        expect(shown == listOf(4) && p.snapshot().resets == 2L && p.snapshot().flushDrops == 3L)
        expect(p.snapshot().sourceSpanMs == 0L && p.snapshot().arrivalSpanMs == 0L)
        p.close(); settled(a, b, c, d)
    }
    run {
        val clock = AbsoluteClock(); val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, clock::sourceNow)
        val a = AbsoluteRef(1, 0); val b = AbsoluteRef(2, 0)
        p.offer(a); clock.advanceMs(137); p.offer(b); clock.advanceMs(1000)
        expect(shown == listOf(500_000_000L, 637_000_000L))
        expect(p.snapshot().fallbackFrames == 2L && p.snapshot().invalidClockFrames == 2L && p.snapshot().sourceSpanMs == -1L)
        p.close(); settled(a, b)
    }

    // A long input pause resets spans but must not turn a valid expired SDK
    // timestamp into a fresh arrival+500 ms deadline.
    run {
        val clock = AbsoluteClock(); val shown = ArrayList<Long>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(clock.now) }, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceNow()); p.offer(a); clock.advanceMs(3000)
        val b = AbsoluteRef(2, clock.sourceNow() - 864_000_000); p.offer(b); clock.advanceMs(3000)
        expect(shown == listOf(500_000_000L, 3_000_000_000L))
        expect(p.snapshot().resets == 1L && p.snapshot().expiredAtOffer == 1L && p.snapshot().fallbackFrames == 0L)
        expect(p.snapshot().gapsOver1000Ms == 1L)
        p.close(); settled(a, b)
    }
    run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceNow()); p.offer(a)
        clock.sourceOriginNs += 5_000_000_000
        val b = AbsoluteRef(2, clock.sourceNow()); p.offer(b)
        expect(p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L)
        expect(p.snapshot().flushDrops == 1L && p.snapshot().bridgeSamples == 1L)
        p.reset()
        expect(p.snapshot().bridgeSamples == 2L && p.snapshot().bridgeOffsetNs == -clock.sourceOriginNs)
        val c = AbsoluteRef(3, clock.sourceNow()); p.offer(c); clock.advanceMs(500)
        expect(p.snapshot().presented == 1L && p.snapshot().absoluteFrames == 2L)
        p.close(); settled(a, b, c)
    }

    // Exact count and byte ceilings; only successful admission retains a frame.
    run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val frames = (0..10).map { AbsoluteRef(it, clock.sourceOriginNs + it * 10_000_000L) }
        frames.forEach { p.offer(it); bounded(p) }
        expect(p.snapshot().queued == 10 && p.snapshot().queuedBytes == 31_104_000L)
        expect(p.snapshot().overflowDrops == 1L && frames.last().retains == 0)
        p.close(); p.close(); expect(p.snapshot().flushDrops == 10L && clock.taskCount() == 0)
        settled(*frames.toTypedArray())
    }
    run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val frames = (0 until 20).map { AbsoluteRef(it, clock.sourceOriginNs + it * 5_000_000L, 4L * 1024 * 1024) }
        frames.forEach { p.offer(it); bounded(p) }
        expect(p.snapshot().queued == 8 && p.snapshot().queuedBytes == 32L * 1024 * 1024)
        expect(p.snapshot().overflowDrops == 12L)
        p.close(); settled(*frames.toTypedArray())
    }
    for (format in listOf(0, 1, 2)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Int>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id) }, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceNow())
        val bypass = when (format) {
            0 -> AbsoluteRef(2, clock.sourceNow(), isI420 = false)
            1 -> AbsoluteRef(2, clock.sourceNow(), byteSize = 0)
            else -> AbsoluteRef(2, clock.sourceNow(), byteSize = 32L * 1024 * 1024 + 1)
        }
        p.offer(a); p.offer(bypass)
        expect(shown == listOf(2) && bypass.retains == 0 && p.snapshot().bypassed == 1L)
        expect(p.snapshot().flushDrops == 1L && p.snapshot().queuedBytes == 0L && clock.taskCount() == 0)
        p.close(); settled(a, bypass)
    }

    // At 60/120 FPS, half a second cannot fit ten frames. Report real capacity
    // loss rather than claiming smoothness or changing the reserve/memory bound.
    for (fps in listOf(60L, 120L)) run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val frames = ArrayList<AbsoluteRef>()
        for (index in 0 until 240) {
            clock.advanceNs(index * 1_000_000_000L / fps)
            val f = AbsoluteRef(index, clock.sourceNow()); frames.add(f); p.offer(f); bounded(p)
        }
        clock.advanceMs(5000)
        val s = p.snapshot()
        expect(s.overflowDrops > 0L && s.maxQueued == 10)
        expect(s.presented + s.overflowDrops + s.lateDrops + s.flushDrops == frames.size.toLong())
        expect(s.fallbackFrames == 0L && s.invalidClockFrames == 0L)
        p.close(); settled(*frames.toTypedArray())
    }
    // Ready-head preservation when native input wins every equal-time race.
    run {
        val clock = AbsoluteClock(); val shown = ArrayList<Int>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id) }, clock::sourceNow, maxFrames = 5)
        val frames = ArrayList<AbsoluteRef>()
        for (index in 0 until 40) {
            clock.advanceMs(index * 100L, inclusive = false)
            val f = AbsoluteRef(index, clock.sourceNow()); frames.add(f); p.offer(f)
            clock.advanceMs(index * 100L)
        }
        val s = p.snapshot()
        expect(shown.first() == 0 && shown.last() >= 30 && s.presented >= 20)
        expect(s.overflowDrops > 0L && s.presented + s.overflowDrops + s.queued == frames.size.toLong())
        expect(clock.maxTasks == 1 && s.maxQueued == 5)
        p.close(); settled(*frames.toTypedArray())
    }

    // A late worker coalesces due frames once, and accounts for every lost
    // frame. An expired input burst follows the same honest accounting.
    for (expiredBurst in listOf(false, true)) run {
        val clock = AbsoluteClock(); val shown = ArrayList<Int>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id) }, clock::sourceNow)
        val frames = (0..4).map { AbsoluteRef(it, clock.sourceOriginNs + if (expiredBurst) -1_000_000_000L + it * 1_000_000 else it * 50_000_000L) }
        frames.forEach(p::offer)
        if (!expiredBurst) clock.now = 800_000_000
        clock.advanceNs(clock.now)
        expect(shown == listOf(4) && p.snapshot().lateDrops == 4L)
        expect(p.snapshot().expiredAtOffer == if (expiredBurst) 5L else 0L)
        expect(p.snapshot().queued == 0 && p.snapshot().queuedBytes == 0L)
        p.close(); settled(*frames.toTypedArray())
    }

    // Rejected initial scheduling and rejection after a successful submission
    // both close the gate and release every already-owned reference.
    for (initially in listOf(true, false)) run {
        val clock = AbsoluteClock().apply { reject = initially }
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceNow()); val b = AbsoluteRef(2, clock.sourceNow() + 70_000_000)
        p.offer(a)
        if (!initially) { p.offer(b); clock.reject = true; clock.advanceMs(500) }
        expect(p.snapshot().scheduleErrors == 1L && p.snapshot().queued == 0 && clock.taskCount() == 0)
        expect(p.snapshot().flushDrops == 1L)
        val after = AbsoluteRef(3, clock.sourceNow()); p.offer(after); expect(after.retains == 0)
        p.close(); settled(a, b, after)
    }
    run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock,
            { throw IllegalStateException("Renderer fixture") }, clock::sourceNow)
        val f = AbsoluteRef(1, clock.sourceNow()); p.offer(f); clock.advanceMs(500)
        expect(p.snapshot().renderErrors == 1L && p.snapshot().presented == 0L && p.snapshot().queuedBytes == 0L)
        p.close(); settled(f)
    }
    run {
        val clock = AbsoluteClock(); val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, clock::sourceNow)
        val a = AbsoluteRef(1, clock.sourceNow(), failRelease = true)
        val b = AbsoluteRef(2, clock.sourceNow() + 70_000_000)
        p.offer(a); p.offer(b); p.close()
        expect(p.snapshot().releaseErrors == 1L && p.snapshot().flushDrops == 2L)
        settled(a, b)
    }

    // Checked arithmetic: a source-domain subtraction overflow becomes explicit
    // fallback. A scheduler time with no representable reserve is an immediate
    // unowned bypass rather than a wrapped or effectively unbounded deadline.
    run {
        val clock = AbsoluteClock()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, { Long.MIN_VALUE + 100_000_000 })
        val f = AbsoluteRef(1, Long.MAX_VALUE); p.offer(f)
        expect(p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L)
        expect(p.snapshot().lastRawLeadNs == Long.MIN_VALUE && p.snapshot().headAheadMs == 500L)
        clock.advanceMs(500); p.close(); settled(f)
    }
    run {
        val clock = AbsoluteClock(ceilToMillis = false).apply { now = Long.MAX_VALUE - 100_000_000 }
        val shown = ArrayList<Int>()
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, { shown.add(it.id) }, { clock.now })
        val f = AbsoluteRef(1, clock.now); p.offer(f)
        expect(shown == listOf(1) && f.retains == 0 && clock.taskCount() == 0)
        expect(p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L && p.snapshot().bypassed == 1L)
        p.close(); settled(f)
    }
    run {
        val clock = AbsoluteClock(); var calls = 0
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {}, {
            if (calls++ < 2) clock.sourceNow() else throw IllegalStateException("Clock fixture")
        })
        val f = AbsoluteRef(1, clock.sourceNow()); p.offer(f)
        expect(p.snapshot().bridgeValid && p.snapshot().invalidClockFrames == 1L && p.snapshot().fallbackFrames == 1L)
        p.close(); settled(f)
    }

    // close cannot return while a short renderer callback holds the queue lock.
    run {
        val clock = AbsoluteClock(); val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val closeStarted = CountDownLatch(1); val closeDone = CountDownLatch(1)
        val p = NativeAbsoluteFramePacerPolicy<AbsoluteRef>(clock, {
            entered.countDown(); check(resume.await(2, TimeUnit.SECONDS))
        }, clock::sourceNow)
        val f = AbsoluteRef(1, clock.sourceNow()); p.offer(f)
        val presenter = Thread { clock.advanceMs(500) }.apply { start() }
        expect(entered.await(1, TimeUnit.SECONDS))
        val closer = Thread { closeStarted.countDown(); p.close(); closeDone.countDown() }.apply { start() }
        expect(closeStarted.await(1, TimeUnit.SECONDS)); expect(!closeDone.await(30, TimeUnit.MILLISECONDS))
        resume.countDown(); presenter.join(1000); closer.join(1000)
        expect(!presenter.isAlive && !closer.isAlive && closeDone.count == 0L)
        expect(p.snapshot().queued == 0); settled(f)
    }

    println("NativeAbsoluteFramePacerTest: $checks assertions PASS (clock/queue model; no native rendering)")
}
