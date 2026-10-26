package org.hometv.launcher

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private class Clock(private val millisecondCeil: Boolean = false) : NativePacerScheduler {
    var now = 0L
    var reject = false
    var maxTasks = 0
    private val tasks = ArrayList<Pair<Long, Runnable>>()
    override fun nowNs() = now
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        if (reject) return false
        val at = if (millisecondCeil) (atNs / 1_000_000 + if (atNs % 1_000_000 == 0L) 0 else 1) * 1_000_000 else atNs
        tasks.add(at to task); maxTasks = maxOf(maxTasks, tasks.size); return true
    }
    override fun cancel(task: Runnable) { tasks.removeAll { it.second === task } }
    fun advanceMs(ms: Long) = advanceTo(ms, inclusive = true)
    // Native decoder callbacks can acquire the queue lock before a worker task
    // scheduled at this same uptime tick. Leave those equal-time tasks pending.
    fun advanceBeforeMs(ms: Long) = advanceTo(ms, inclusive = false)
    private fun advanceTo(ms: Long, inclusive: Boolean) {
        val target = ms * 1_000_000
        check(target >= now)
        while (true) {
            val next = tasks.minByOrNull { it.first } ?: break
            if (next.first > target || !inclusive && next.first == target) break
            tasks.remove(next); now = maxOf(now, next.first); next.second.run()
        }
        now = target
    }
    fun stallMs(ms: Long) { now = ms * 1_000_000 }
    fun queuedTasks() = tasks.size
}

private class Ref(val id: Int, override val timestampNs: Long, override val byteSize: Long = 1024,
    override val isI420: Boolean = true) : NativePacedFrame {
    var references = 1
    var retains = 0
    var releases = 0
    override fun retain() { check(references > 0); references++; retains++ }
    override fun release() { check(references > 1); references--; releases++ }
}

fun main() {
    var checks = 0
    fun expect(value: Boolean) { check(value) { "Pacer invariant failed at assertion ${checks + 1}" }; checks++ }
    fun settled(vararg frames: Ref) { frames.forEach { expect(it.references == 1 && it.retains == it.releases) } }

    // Preserve capture cadence across a 485 ms decoder pause followed by a burst.
    run {
        val clock = Clock(); val shown = ArrayList<Pair<Int, Long>>()
        val pacer = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id to clock.now) })
        val frames = (0..11).map { Ref(it, 1_000_000_000L + it * 66_000_000L) }
        for (i in 0..4) { clock.advanceMs(i * 66L); pacer.offer(frames[i]) }
        clock.advanceMs(499); expect(shown.isEmpty())
        clock.advanceMs(749); for (i in 5..11) pacer.offer(frames[i])
        clock.advanceMs(1500)
        expect(shown.map { it.first } == (0..11).toList())
        expect(shown.first().second == 500_000_000L)
        expect(shown.zipWithNext().all { (a, b) -> b.second - a.second == 66_000_000L })
        expect(pacer.snapshot().overflowDrops == 0L && pacer.snapshot().lateDrops == 0L)
        expect(pacer.snapshot().maxPresentedGapMs == 66L && clock.maxTasks == 1)
        settled(*frames.toTypedArray()); pacer.close()
    }
    // Texture bypass retains nothing and flushes older buffered raw frames.
    run {
        val clock = Clock(); val shown = ArrayList<Int>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) })
        val a = Ref(1, 1); val texture = Ref(2, 2, isI420 = false)
        p.offer(a); p.offer(texture); expect(shown == listOf(2)); expect(texture.retains == 0)
        expect(clock.queuedTasks() == 0 && p.snapshot().queuedBytes == 0L)
        clock.advanceMs(1000); expect(shown == listOf(2)); p.close(); settled(a, texture)
    }
    // Count and bytes are independently bounded; rejected inputs are not retained.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0..19).map { Ref(it, 1L + it * 10_000_000L, 4L * 1024 * 1024) }
        frames.forEach { p.offer(it); expect(p.snapshot().queued <= 8 && p.snapshot().queuedBytes <= 32L * 1024 * 1024) }
        expect(p.snapshot().overflowDrops == 12L); p.close(); settled(*frames.toTypedArray())
        expect(clock.queuedTasks() == 0 && p.snapshot().queued == 0)
        val after = Ref(99, 1); p.offer(after); expect(after.retains == 0)
    }
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {}, maxBytes = 10)
        val a = Ref(1, 1, 6); val b = Ref(2, 2, 6); val large = Ref(3, 3, 11)
        p.offer(a); p.offer(b); expect(p.snapshot().queued == 1 && a.references == 2 && b.references == 1)
        p.offer(large); expect(large.retains == 0 && p.snapshot().queued == 0)
        p.close(); settled(a, b, large)
    }
    // Backwards/duplicate/large-forward source clocks reset instead of scheduling arbitrarily.
    run {
        val clock = Clock(); val shown = ArrayList<Int>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) }, delayMs = 600, maxFrames = 8)
        val frames = (0..19).map { Ref(it, 1L + it * 60_000_000L) }
        for (i in frames.indices) { clock.advanceMs(i * 60L); p.offer(frames[i]) }
        clock.advanceMs(2000)
        expect(shown.firstOrNull() == 0 && shown.isNotEmpty())
        expect(p.snapshot().overflowDrops > 0 && clock.maxTasks == 1)
        p.close(); settled(*frames.toTypedArray())
    }
    for (next in listOf(900_000_000L, 1_000_000_000L, 9_000_000_000L)) run {
        val clock = Clock(); val shown = ArrayList<Int>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) })
        val a = Ref(1, 1_000_000_000); val b = Ref(2, next)
        p.offer(a); clock.advanceMs(100); p.offer(b)
        expect(a.references == 1 && p.snapshot().resets == 1L)
        clock.advanceMs(599); expect(shown.isEmpty()); clock.advanceMs(600); expect(shown == listOf(2))
        p.close(); settled(a, b)
    }
    // Missing source timestamp uses each arrival, with no guessed FPS.
    run {
        val clock = Clock(); val shown = ArrayList<Long>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(clock.now) })
        val a = Ref(1, 0); val b = Ref(2, 0)
        p.offer(a); clock.advanceMs(137); p.offer(b); clock.advanceMs(1000)
        expect(shown == listOf(500_000_000L, 637_000_000L)); expect(p.snapshot().fallbackFrames == 2L)
        p.close(); settled(a, b)
    }
    // A blocked worker skips obsolete due frames, never floods the renderer to catch up.
    run {
        val clock = Clock(); val shown = ArrayList<Int>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) })
        val frames = (0..15).map { Ref(it, 1_000_000_000L) }
        for (i in frames.indices) { clock.advanceMs(i * 40L); p.offer(frames[i]) }
        clock.advanceMs(1500)
        expect(shown.isNotEmpty() && p.snapshot().fallbackFrames == 15L)
        expect(p.snapshot().resets == 1L); p.close(); settled(*frames.toTypedArray())
    }
    run {
        val clock = Clock(); val shown = ArrayList<Int>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) })
        val frames = (0..4).map { Ref(it, 1L + it * 50_000_000L) }; frames.forEach(p::offer)
        clock.stallMs(800); clock.advanceMs(800)
        expect(shown == listOf(4) && p.snapshot().lateDrops == 4L)
        p.close(); settled(*frames.toTypedArray())
    }
    // Shutdown/rejected scheduling/renderer exceptions cannot strand retained frames.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {}); val a = Ref(1, 1)
        p.offer(a); p.reset(); expect(p.snapshot().queued == 0 && clock.queuedTasks() == 0); settled(a)
        p.offer(a); p.close(); p.close(); clock.advanceMs(1000); settled(a)
    }
    run {
        val clock = Clock().apply { reject = true }; val p = NativeFramePacerPolicy<Ref>(clock, {}); val a = Ref(1, 1)
        p.offer(a); expect(p.snapshot().scheduleErrors == 1L && p.snapshot().queued == 0); p.close(); settled(a)
    }
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, { throw IllegalStateException("fixture") }); val a = Ref(1, 1)
        p.offer(a); clock.advanceMs(500); expect(p.snapshot().renderErrors == 1L); p.close(); settled(a)
    }
    // A long pause reanchors rather than flushing all overdue frames in a presentation burst.
    run {
        val clock = Clock(); val shown = ArrayList<Long>(); val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(clock.now) })
        val a = Ref(1, 1); val b = Ref(2, 2_500_000_001L)
        p.offer(a); clock.advanceMs(2500); p.offer(b); clock.advanceMs(3000)
        expect(shown == listOf(500_000_000L, 3_000_000_000L)); expect(p.snapshot().resets == 1L)
        expect(p.snapshot().gapsOver1000Ms == 1L); p.close(); settled(a, b)
    }
    // Close must not return while the renderer-submission callback is in flight.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0..10).map { Ref(it, 1L + it * 66_000_000L, 3_110_400) }
        frames.forEach(p::offer)
        expect(p.snapshot().queued == 10 && p.snapshot().queuedBytes == 31_104_000L)
        expect(p.snapshot().overflowDrops == 1L && frames.last().retains == 0)
        p.close(); settled(*frames.toTypedArray())
    }
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val a = Ref(1, 1_000_000_000); val b = Ref(2, 1_150_000_000)
        expect(p.snapshot().sourceSpanMs == -1L && p.snapshot().arrivalSpanMs == -1L)
        p.offer(a); expect(p.snapshot().headAheadMs == 500L && p.snapshot().tailAheadMs == 500L)
        clock.advanceMs(100); p.offer(b)
        val s = p.snapshot()
        expect(s.sourceSpanMs == 150L && s.arrivalSpanMs == 100L)
        expect(s.headAheadMs == 400L && s.tailAheadMs == 550L && s.maxDueAheadMs == 550L)
        clock.stallMs(5000); expect(p.snapshot().headAheadMs == -2500L && p.snapshot().tailAheadMs == -2500L)
        p.close(); expect(p.snapshot().headAheadMs == 0L && p.snapshot().tailAheadMs == 0L); settled(a, b)
    }
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val a = Ref(1, 0); val b = Ref(2, 0)
        p.offer(a); clock.advanceMs(123); p.offer(b)
        expect(p.snapshot().sourceSpanMs == -1L && p.snapshot().arrivalSpanMs == 123L)
        p.close(); settled(a, b)
    }
    run {
        val clock = Clock(); val entered = CountDownLatch(1); val resume = CountDownLatch(1)
        val closeStarted = CountDownLatch(1); val closeDone = CountDownLatch(1)
        val p = NativeFramePacerPolicy<Ref>(clock, { entered.countDown(); check(resume.await(2, TimeUnit.SECONDS)) })
        val a = Ref(1, 1); p.offer(a)
        val presenter = Thread { clock.advanceMs(500) }.apply { start() }
        expect(entered.await(1, TimeUnit.SECONDS))
        val closer = Thread { closeStarted.countDown(); p.close(); closeDone.countDown() }.apply { start() }
        expect(closeStarted.await(1, TimeUnit.SECONDS)); expect(!closeDone.await(30, TimeUnit.MILLISECONDS))
        resume.countDown(); presenter.join(1000); closer.join(1000)
        expect(!presenter.isAlive && !closer.isAlive && closeDone.count == 0L)
        expect(p.snapshot().queued == 0); settled(a)
    }
    // Regression SHAPE from .5.10, not a replay: the raw log samples only every
    // 10 s and does not contain individual frame arrivals. The early 30 ms
    // plateau must not lock out the later persistent +300 ms SDK phase.
    run {
        val clock = Clock(); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id to clock.now) })
        val frames = (0 until 900).map { i ->
            val phase = if (i == 0) 0 else if (i <= 3) 30 else minOf(300, 30 + (i - 3) * 10)
            Ref(i, 1_000_000_000L + (i * 70L + phase) * 1_000_000, 3_110_400)
        }
        var steadyDrops = 0L; var steadySubmissions = 0L
        for (i in frames.indices) {
            clock.advanceMs(i * 70L); p.offer(frames[i])
            if (i == 215) {
                val s = p.snapshot(); steadyDrops = s.overflowDrops + s.lateDrops; steadySubmissions = s.presented
                expect(s.correctionMs in 295..300 && s.correctionCount > 1)
            }
        }
        val beforeDrain = p.snapshot()
        expect(beforeDrain.overflowDrops + beforeDrain.lateDrops == steadyDrops)
        expect(beforeDrain.presented - steadySubmissions == 684L)
        expect(beforeDrain.tailAheadMs in 500..505 && beforeDrain.phaseEstimateMs == 300L)
        expect(beforeDrain.maxCorrectionStepUs <= 5000 && beforeDrain.maxQueued <= 10 && beforeDrain.maxQueuedBytes <= 32L * 1024 * 1024)
        clock.advanceMs(64000)
        val s = p.snapshot()
        expect(s.presented + s.overflowDrops + s.lateDrops == frames.size.toLong())
        expect(s.resets == 0L && s.lateDrops == 0L && s.queued == 0 && clock.maxTasks == 1)
        expect(shown.map { it.first }.distinct().size == shown.size)
        expect(shown.zipWithNext().all { (a, b) -> a.first < b.first && b.second > a.second })
        expect(shown.filter { it.first > 215 }.zipWithNext().all { (a, b) -> b.second - a.second == 70_000_000L })
        println(".5.10-shape model: submitted=${s.presented}, startupOverflow=${s.overflowDrops}, steadyDrops=0; NOT a TV replay")
        p.close(); settled(*frames.toTypedArray())
    }
    // Full-capacity input winning the equal-time race must not keep evicting
    // the only ready frame and cancel its worker forever. This deliberately
    // tests a capacity boundary, so drops are allowed and must be reported.
    run {
        val clock = Clock(millisecondCeil = true); val shown = ArrayList<Int>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) }, maxFrames = 5)
        val frames = (0 until 40).map { i -> Ref(i, 1_000_000_000L + i * 100_000_000L) }
        for (i in frames.indices) {
            clock.advanceBeforeMs(i * 100L)
            p.offer(frames[i])
            clock.advanceMs(i * 100L)
        }
        val s = p.snapshot()
        expect(shown.isNotEmpty() && shown.first() == 0)
        expect(shown.last() >= 30 && s.presented >= 20)
        expect(s.overflowDrops > 0L && s.presented + s.overflowDrops + s.queued == frames.size.toLong())
        expect(s.maxQueued == 5 && clock.maxTasks == 1)
        p.close(); settled(*frames.toTypedArray())
    }
    // Handler rounds deadlines up to milliseconds. At equal uptime ticks the
    // decoder may offer BEFORE the ready worker acquires the queue lock. This
    // must not phase-lock correction at a partial value (previously 170 ms)
    // merely because every offer happens to see the head already due.
    run {
        val clock = Clock(millisecondCeil = true); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id to clock.now) })
        val frames = (0 until 900).map { i ->
            val phase = if (i == 0) 0 else if (i <= 3) 30 else minOf(300, 30 + (i - 3) * 10)
            Ref(i, 1_000_000_000L + (i * 70L + phase) * 1_000_000, 3_110_400)
        }
        var steadyDrops = 0L
        for (i in frames.indices) {
            clock.advanceBeforeMs(i * 70L)
            p.offer(frames[i])
            clock.advanceMs(i * 70L)
            if (i == 215) {
                val s = p.snapshot()
                expect(s.correctionMs in 295..300 && s.correctionTargetMs == 300L)
                steadyDrops = s.overflowDrops + s.lateDrops + s.flushDrops
            }
        }
        val s = p.snapshot()
        expect(s.correctionMs in 295..300 && s.phaseEstimateMs == 300L)
        expect(s.tailAheadMs in 500..505)
        expect(s.overflowDrops + s.lateDrops + s.flushDrops == steadyDrops)
        expect(s.lateDrops == 0L && s.resets == 0L)
        expect(s.maxCorrectionStepUs <= 5000 && s.maxQueued <= 10 && s.maxQueuedBytes <= 32L * 1024 * 1024)
        expect(clock.maxTasks == 1)
        expect(shown.filter { it.first > 215 }.zipWithNext().all { (a, b) -> b.second - a.second == 70_000_000L })
        p.close(); settled(*frames.toTypedArray())
    }
    // A sustainable slow phase ramp preserves EVERY frame. Steady SDK cadence
    // remains unchanged; convergence can alter individual gaps by <=5 ms.
    run {
        val clock = Clock(); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id to clock.now) })
        val frames = (0 until 450).map { i -> Ref(i, 1_000_000_000L + (i * 70L + minOf(300, i * 2)) * 1_000_000, 3_110_400) }
        for (i in frames.indices) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        clock.advanceMs(33000)
        expect(shown.map { it.first } == frames.map { it.id })
        expect(p.snapshot().overflowDrops == 0L && p.snapshot().lateDrops == 0L)
        expect(p.snapshot().correctionMs in 295..300 && p.snapshot().maxCorrectionStepUs <= 5000)
        expect(shown.zipWithNext().all { (a, b) ->
            val sourceGap = frames[b.first].timestampNs - frames[a.first].timestampNs
            b.second - a.second in sourceGap - 5_000_000..sourceGap + 5_000_000
        })
        p.close(); settled(*frames.toTypedArray())
    }
    // Track a genuine phase DECREASE too. A monotonic SDK timestamp ramp avoids
    // confusing a valid rephase with the backwards-clock discontinuity guard.
    run {
        val clock = Clock(); val shown = ArrayList<Pair<Int, Long>>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id to clock.now) })
        val frames = (0 until 600).map { i ->
            val phase = when { i < 150 -> minOf(300, i * 2); i < 300 -> 300; else -> maxOf(0, 300 - (i - 300) * 10) }
            Ref(i, 1_000_000_000L + (i * 70L + phase) * 1_000_000, 3_110_400)
        }
        for (i in frames.indices) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        expect(p.snapshot().correctionMs in 0..5 && p.snapshot().tailAheadMs in 495..500)
        clock.advanceMs(43000)
        expect(shown.map { it.first } == frames.map { it.id })
        expect(p.snapshot().resets == 0L && p.snapshot().overflowDrops == 0L && p.snapshot().lateDrops == 0L)
        expect(shown.zipWithNext().all { (a, b) ->
            val sourceGap = frames[b.first].timestampNs - frames[a.first].timestampNs
            // The budget is applied per offer. Two bounded offers can fall
            // between submissions while a decreasing phase is slewed back.
            b.second - a.second in sourceGap - 10_000_000..sourceGap + 10_000_000
        })
        p.close(); settled(*frames.toTypedArray())
    }
    // A single 485 ms decoder pause followed by a 7-frame burst, AFTER phase
    // acquisition, must not destroy the reserve or cause a lasting rephase.
    run {
        val clock = Clock(); val shown = ArrayList<Int>()
        val p = NativeFramePacerPolicy<Ref>(clock, { shown.add(it.id) })
        val frames = (0 until 450).map { i -> Ref(i, 1_000_000_000L + (i * 70L + minOf(300, i * 2)) * 1_000_000, 3_110_400) }
        var correctionBefore = 0L
        for (i in frames.indices) {
            val arrival = if (i in 221..227) 227 * 70L else i * 70L
            clock.advanceMs(arrival); p.offer(frames[i])
            if (i == 220) correctionBefore = p.snapshot().correctionMs
            if (i == 242) expect(p.snapshot().correctionMs == correctionBefore)
        }
        clock.advanceMs(33000)
        expect(shown == frames.map { it.id })
        expect(p.snapshot().overflowDrops == 0L && p.snapshot().lateDrops == 0L && p.snapshot().resets == 0L)
        p.close(); settled(*frames.toTypedArray())
    }
    // Persistent noisy phase must be reported, never accepted as stable timing.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0 until 80).map { i -> Ref(i, 1_000_000_000L + (i * 70L + if (i % 2 == 0) 0 else 60) * 1_000_000) }
        for (i in frames.indices) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        val s = p.snapshot()
        expect(s.correctionCount == 0L && s.correctionMs == 0L && s.correctionSkipReason == 2)
        expect(s.phaseSpreadMs == 60L && s.phaseWindowMs in 800..1000)
        p.close(); settled(*frames.toTypedArray())
    }
    // Known regression retained as evidence, NOT acceptance: a +700 ms SDK
    // coordinate offset is physically feasible at this cadence and reserve.
    // This rejected policy saturates its mapping bound and keeps losing frames;
    // the .5.16 TV run later exposed the same flaw near +960 ms. Do not treat
    // this passing characterization as proof of acceptable playback.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0 until 450).map { i -> Ref(i, 1_000_000_000L + (i * 70L + if (i == 0) 0 else 700) * 1_000_000, 3_110_400) }
        for (i in frames.indices) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        val s = p.snapshot()
        expect(s.correctionMs in 495..500 && s.correctionTargetMs == 500L && s.phaseEstimateMs == 700L)
        expect(s.overflowDrops > 0L && s.maxQueued <= 10 && s.maxQueuedBytes <= 32L * 1024 * 1024)
        expect(s.maxCorrectionStepUs <= 5000)
        p.close(); settled(*frames.toTypedArray())
    }
    // Multiple frames at the same arrival tick cannot outvote the true time
    // span. Observe even overflow-rejected frames, but count one clock sample.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = ArrayList<Ref>()
        for (i in 0..6) {
            val f = Ref(i, 1_000_000_000L + i * 140_000_000L)
            frames.add(f); clock.advanceMs(i * 140L); p.offer(f)
        }
        for (i in 1..24) {
            val f = Ref(i + 6, 1_840_000_000L + i * 8_000_000L)
            frames.add(f); p.offer(f)
        }
        expect(p.snapshot().phaseSamples == 7 && p.snapshot().correctionCount == 0L)
        val f = Ref(99, 2_180_000_000L); frames.add(f)
        clock.advanceMs(980); p.offer(f)
        expect(p.snapshot().phaseSamples == 8 && p.snapshot().correctionCount == 0L)
        expect(p.snapshot().overflowDrops > 0L && p.snapshot().unstableWindows > 0L)
        p.close(); settled(*frames.toTypedArray())
    }
    // An overdue head must drain as late work, not be postponed by a negative
    // phase correction. In particular lateness must remain visible as drops.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0 until 60).map { i -> Ref(i, 1_000_000_000L + i * 70_000_000L) }
        for (i in 0..29) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        val correction = p.snapshot().correctionMs
        clock.stallMs(2900)
        for (i in 30..40) p.offer(frames[i])
        expect(p.snapshot().correctionMs == correction)
        // Capacity eviction of overdue frames and worker late drops are both
        // genuine loss; neither is hidden by retiming or a reset.
        clock.advanceMs(2900)
        expect(p.snapshot().overflowDrops + p.snapshot().lateDrops > 0L && p.snapshot().resets == 0L)
        p.close(); settled(*frames.toTypedArray())
    }
    // A retiming-triggered scheduling failure must release an already-owned
    // queue, cancel the task and close the gate for later offers.
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {})
        val frames = (0 until 30).map { i -> Ref(i, 1_000_000_000L + (i * 70L + minOf(300, i * 2)) * 1_000_000) }
        for (i in 0..11) { clock.advanceMs(i * 70L); p.offer(frames[i]) }
        expect(p.snapshot().queued > 0)
        clock.reject = true; clock.advanceMs(840); p.offer(frames[12])
        expect(p.snapshot().scheduleErrors == 1L && p.snapshot().queued == 0 && p.snapshot().queuedBytes == 0L)
        expect(clock.queuedTasks() == 0)
        p.offer(frames.last()); expect(frames.last().retains == 0)
        p.close(); settled(*frames.toTypedArray())
    }
    run {
        val clock = Clock(); val p = NativeFramePacerPolicy<Ref>(clock, {}); val a = Ref(1, 0)
        p.offer(a); expect(p.snapshot().correctionCount == 0L && p.snapshot().correctionSkipReason == 3)
        p.close(); settled(a)
    }
    println("NativeFramePacerTest: $checks assertions PASS")
}
