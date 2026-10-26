package org.hometv.launcher

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

private fun recordTimingRow(trace: NativePacerTimingTrace, start: Long) {
    trace.record(start, start + 1, start + 2, start + 3, start + 4,
        start + 5, start + 6, start + 7, start + 8, start + 9,
        start + 10, start + 11, start + 12, start + 13, start + 14,
        start + 15, start + 16, start + 17, start + 18, start + 19)
}

private fun timingRows(lines: List<String>): List<List<Long>> = lines
    .filter { it.startsWith("stage=pacer_trace_data ") }
    .flatMap { it.substringAfter(" data=").split(';').map { row -> row.split(',').map(String::toLong) } }

fun main(args: Array<String>) {
    if (args.contentEquals(arrayOf("--export-fixture"))) {
        // Interoperability fixture only: first decoded SDK timestamp is late,
        // then SDK and local clocks coincide. Relative phase reaches +960 ms
        // while the steady absolute lead is zero. Never label this TV evidence.
        val trace = NativePacerTimingTrace(7)
        for (index in 0..240) {
            val nano = 1_000_000_000_000L + index * 70_000_000L
            val sdk = nano - if (index == 0) 960_000_000L else 0L
            trace.record(1, index + 1L, sdk, nano, nano - 125_000L, Long.MIN_VALUE,
                8, 24_883_200, 10, 500, 0, index + 1L, index.toLong(), 0, 0, 0, 0, 0, 0, 1)
        }
        trace.export { println("1800000000.000 123 124 D HomeTVPacerTrace: $it") }
        return
    }
    var checks = 0
    fun expect(value: Boolean) {
        check(value) { "Timing trace invariant failed at assertion ${checks + 1}" }
        checks++
    }
    fun invalid(action: () -> Unit) {
        var rejected = false
        try { action() } catch (_: IllegalArgumentException) { rejected = true }
        expect(rejected)
    }

    for (capacity in listOf(Int.MIN_VALUE, -1, 0, 6145, Int.MAX_VALUE)) {
        invalid { NativePacerTimingTrace(1, capacity) }
    }
    run {
        val trace = NativePacerTimingTrace(1)
        val state = trace.snapshot()
        expect(state.rows == 0 && state.lostRows == 0L)
        expect(!state.closed && !state.exported && state.emitErrors == 0L)
        expect(state.pendingObservations == 0L && state.acceptingObservations)
        expect(state.storageLongs == 6144 * 20 && state.storageLongs * 8 < 1024 * 1024)
        trace.export {}
        expect(trace.snapshot().storageLongs == 0)
    }
    run {
        val trace = NativePacerTimingTrace(Long.MIN_VALUE, 2)
        val extremes = LongArray(20) { if (it % 2 == 0) Long.MIN_VALUE + it else Long.MAX_VALUE - it }
        for (width in listOf(0, 1, 19, 21, 40)) invalid { trace.record(*LongArray(width)) }
        expect(trace.snapshot().rows == 0 && trace.snapshot().lostRows == 0L)
        trace.record(*extremes)
        recordTimingRow(trace, -10)
        val lines = ArrayList<String>()
        trace.export(lines::add)
        expect(lines.size == 3)
        expect(lines.first() == "stage=pacer_trace_begin session=${Long.MIN_VALUE} schema=2 columns=${NativePacerTimingTrace.COLUMNS}")
        expect(NativePacerTimingTrace.COLUMNS.split(',') == listOf("event", "seq", "sdkNs", "nanoNs", "uptimeNs", "dueNs", "queued", "queuedBytes", "headAheadMs", "tailAheadMs", "correctionMs", "offered", "submitted", "overflow", "late", "resets", "bypassed", "renderErrors", "callbackNs", "retained"))
        expect(timingRows(lines) == listOf(extremes.toList(), (0..19).map { -10L + it }))
        expect(lines[1].startsWith("stage=pacer_trace_data session=${Long.MIN_VALUE} offset=0 rows=2 data="))
        expect(lines.last() == "stage=pacer_trace_end session=${Long.MIN_VALUE} rows=2 lostRows=0 pendingObservations=0 emitErrors=0")
        expect(lines.all { " session=${Long.MIN_VALUE} " in it && it.length < 3800 })
        val state = trace.snapshot()
        expect(state.closed && state.exported && state.storageLongs == 0 && state.emitErrors == 0L)
        invalid { trace.record(1L) }
        trace.export { error("A second export must not emit") }
        expect(trace.snapshot() == state)
    }
    run {
        val trace = NativePacerTimingTrace(Long.MAX_VALUE, 17)
        repeat(17) { recordTimingRow(trace, it * 100L) }
        val lines = ArrayList<String>()
        trace.export(lines::add)
        expect(lines.size == 5)
        val blocks = lines.filter { it.startsWith("stage=pacer_trace_data ") }
        expect(blocks[0].contains(" offset=0 rows=8 data="))
        expect(blocks[1].contains(" offset=8 rows=8 data="))
        expect(blocks[2].contains(" offset=16 rows=1 data="))
        expect(timingRows(lines) == (0 until 17).map { row -> (0..19).map { row * 100L + it } })
        expect(lines.all { it.length < 3800 })
    }
    run {
        val trace = NativePacerTimingTrace(Long.MIN_VALUE, 8)
        repeat(8) { trace.record(*LongArray(20) { Long.MIN_VALUE }) }
        val lines = ArrayList<String>()
        trace.export(lines::add)
        expect(lines.size == 3 && lines.maxOf { it.length } < 3800)
        expect(timingRows(lines).size == 8 && timingRows(lines).all { it == List(20) { Long.MIN_VALUE } })
    }
    run {
        val trace = NativePacerTimingTrace(31, 2)
        repeat(5) { recordTimingRow(trace, it * 100L) }
        expect(trace.snapshot().rows == 2 && trace.snapshot().lostRows == 3L)
        val lines = ArrayList<String>()
        trace.export {
            expect(trace.snapshot().closed && trace.snapshot().exported)
            recordTimingRow(trace, 999)
            trace.export { error("Reentrant export must not emit") }
            lines.add(it)
        }
        expect(timingRows(lines) == listOf((0..19).map(Int::toLong), (0..19).map { 100L + it }))
        expect(lines.last() == "stage=pacer_trace_end session=31 rows=2 lostRows=3 pendingObservations=0 emitErrors=0")
        val state = trace.snapshot()
        recordTimingRow(trace, 999)
        trace.export(lines::add)
        expect(trace.snapshot() == state && lines.size == 3)
    }
    // An empty recorder still provides a complete, unambiguous session envelope.
    run {
        val trace = NativePacerTimingTrace(0, 1)
        val lines = ArrayList<String>()
        trace.export {
            expect(!trace.beginObservation() && !trace.snapshot().acceptingObservations)
            lines.add(it)
        }
        expect(lines.size == 2 && timingRows(lines).isEmpty())
        expect(lines.last() == "stage=pacer_trace_end session=0 rows=0 lostRows=0 pendingObservations=0 emitErrors=0")
        expect(trace.snapshot().storageLongs == 0)
    }
    // Fail BEGIN, DATA and END separately. None is retried or leaves storage held.
    for (failAt in 0..2) run {
        val trace = NativePacerTimingTrace(41, 1)
        recordTimingRow(trace, 0)
        var attempts = 0
        trace.export {
            if (attempts++ == failAt) throw IllegalStateException("Emitter fixture")
        }
        val state = trace.snapshot()
        expect(attempts == failAt + 1)
        expect(state.closed && state.exported && state.emitErrors == 1L)
        expect(state.storageLongs == 0 && state.rows == 1)
        trace.export { attempts++ }
        recordTimingRow(trace, 0)
        expect(attempts == failAt + 1 && trace.snapshot() == state)
    }
    run {
        val trace = NativePacerTimingTrace(42, 1)
        var propagated = false
        try { trace.export { throw AssertionError("Fatal emitter fixture") } }
        catch (_: AssertionError) { propagated = true }
        expect(propagated && trace.snapshot().storageLongs == 0)
        expect(trace.snapshot().exported && trace.snapshot().closed)
        trace.export { error("A failed attempt must not be retried") }
    }
    // Sealing admission is NOT the record/export cutoff. An already admitted
    // observer, or a serialized submit observation, can still append its row.
    run {
        val trace = NativePacerTimingTrace(43, 3)
        expect(trace.beginObservation())
        expect(trace.snapshot().pendingObservations == 1L)
        trace.sealAdmissions(); trace.sealAdmissions()
        expect(!trace.beginObservation())
        expect(!trace.snapshot().acceptingObservations && !trace.snapshot().closed)
        recordTimingRow(trace, 100)
        trace.endObservation()
        recordTimingRow(trace, 200)
        expect(trace.snapshot().rows == 2 && trace.snapshot().pendingObservations == 0L)
        val lines = ArrayList<String>()
        trace.export(lines::add)
        expect(timingRows(lines) == listOf((0..19).map { 100L + it }, (0..19).map { 200L + it }))
        expect(lines.last() == "stage=pacer_trace_end session=43 rows=2 lostRows=0 pendingObservations=0 emitErrors=0")
        expect(!trace.beginObservation() && !trace.snapshot().acceptingObservations)
    }
    // Ordinary balanced observers finish before export, giving a complete zero
    // pending count. Unbalanced finally blocks must not silently underflow it.
    run {
        val trace = NativePacerTimingTrace(44, 2)
        var rejected = false
        try { trace.endObservation() } catch (_: IllegalStateException) { rejected = true }
        expect(rejected && trace.snapshot().pendingObservations == 0L)
        expect(trace.beginObservation() && trace.beginObservation())
        trace.endObservation()
        expect(trace.snapshot().pendingObservations == 1L)
        recordTimingRow(trace, 0)
        trace.endObservation()
        val lines = ArrayList<String>()
        trace.export(lines::add)
        expect(lines.last() == "stage=pacer_trace_end session=44 rows=1 lostRows=0 pendingObservations=0 emitErrors=0")
        expect(trace.snapshot().pendingObservations == 0L && !trace.snapshot().acceptingObservations)
        rejected = false
        try { trace.endObservation() } catch (_: IllegalStateException) { rejected = true }
        expect(rejected && trace.snapshot().pendingObservations == 0L)
    }
    // Model an offer that has left the policy but pauses before its observation.
    // Export freezes pending=1. Release the observer DURING BEGIN, before END:
    // its late row is ignored, its lease ends, but END must still say pending=1.
    run {
        val trace = NativePacerTimingTrace(45, 2)
        val admitted = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val observerDone = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val observer = Thread {
            try {
                check(trace.beginObservation())
                admitted.countDown()
                try {
                    check(resume.await(5, TimeUnit.SECONDS))
                    recordTimingRow(trace, 999)
                } finally { trace.endObservation() }
            } catch (error: Throwable) { failure.compareAndSet(null, error) }
            finally { observerDone.countDown() }
        }.apply { start() }
        expect(admitted.await(2, TimeUnit.SECONDS))
        trace.sealAdmissions()
        expect(!trace.beginObservation() && trace.snapshot().pendingObservations == 1L)
        val lines = ArrayList<String>()
        var observerFinishedBeforeEnd = false
        try {
            trace.export { line ->
                if (line.startsWith("stage=pacer_trace_begin ")) {
                    resume.countDown()
                    observerFinishedBeforeEnd = observerDone.await(2, TimeUnit.SECONDS)
                }
                lines.add(line)
            }
        } finally {
            resume.countDown()
            observer.join(5000)
        }
        expect(observerFinishedBeforeEnd && !observer.isAlive && failure.get() == null)
        expect(lines.size == 2 && timingRows(lines).isEmpty())
        expect(lines.last() == "stage=pacer_trace_end session=45 rows=0 lostRows=0 pendingObservations=1 emitErrors=0")
        val state = trace.snapshot()
        expect(state.pendingObservations == 0L && state.rows == 0 && state.lostRows == 0L)
        expect(state.storageLongs == 0 && state.closed && state.exported && !state.acceptingObservations)
        trace.export { error("Incomplete export must not be retried") }
        expect(trace.snapshot() == state)
    }
    // Concurrent writers can fill only the allocated rows, without torn fields.
    run {
        val trace = NativePacerTimingTrace(51, 127)
        val start = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val threads = (0 until 6).map { writer ->
            Thread {
                try {
                    check(start.await(5, TimeUnit.SECONDS))
                    repeat(200) { recordTimingRow(trace, writer * 1_000_000L + it * 100L) }
                } catch (error: Throwable) { failure.compareAndSet(null, error) }
            }.apply { start() }
        }
        start.countDown()
        threads.forEach { it.join(5000) }
        expect(threads.none { it.isAlive } && failure.get() == null)
        val state = trace.snapshot()
        expect(state.rows == 127 && state.lostRows == 1200L - 127 && state.storageLongs == 127 * 20)
        val lines = ArrayList<String>()
        trace.export(lines::add)
        val rows = timingRows(lines)
        expect(rows.size == 127 && rows.map { it.first() }.toSet().size == 127)
        expect(rows.all { row -> row.size == 20 && row.withIndex().all { (column, value) -> value == row.first() + column } })
        expect(lines.all { it.length < 3800 })
        expect(trace.snapshot().storageLongs == 0)
    }
    // Export closes the gate before calling external code and holds no monitor
    // across emit: a concurrent record/reexport must finish while emit is paused.
    run {
        val trace = NativePacerTimingTrace(61, 4)
        recordTimingRow(trace, 0)
        val emitting = CountDownLatch(1)
        val resume = CountDownLatch(1)
        val writerDone = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        val lines = ArrayList<String>()
        val exporter = Thread {
            try {
                trace.export {
                    if (lines.isEmpty()) {
                        emitting.countDown()
                        check(resume.await(5, TimeUnit.SECONDS))
                    }
                    lines.add(it)
                }
            } catch (error: Throwable) { failure.compareAndSet(null, error) }
        }.apply { start() }
        expect(emitting.await(2, TimeUnit.SECONDS))
        val writer = Thread {
            try {
                repeat(100) { recordTimingRow(trace, 999) }
                trace.export { error("Concurrent export must not emit") }
                writerDone.countDown()
            } catch (error: Throwable) { failure.compareAndSet(null, error) }
        }.apply { start() }
        val completedWhileEmitterPaused = writerDone.await(2, TimeUnit.SECONDS)
        resume.countDown()
        writer.join(5000); exporter.join(5000)
        expect(completedWhileEmitterPaused && !writer.isAlive && !exporter.isAlive && failure.get() == null)
        expect(trace.snapshot().rows == 1 && trace.snapshot().lostRows == 0L)
        expect(trace.snapshot().storageLongs == 0 && lines.size == 3)
        expect(timingRows(lines) == listOf((0..19).map(Int::toLong)))
    }
    println("NativePacerTimingTraceTest: $checks assertions PASS (bounded numeric recording/export only)")
}
