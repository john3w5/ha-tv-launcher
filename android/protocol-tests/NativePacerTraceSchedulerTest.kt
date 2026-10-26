package org.hometv.launcher

private class TraceSchedulerClock : NativePacerScheduler {
    var now = 0L
    var reject = false
    var maxPending = 0
    val scheduled = ArrayList<Pair<Long, Runnable>>()
    val cancelled = ArrayList<Runnable>()
    private val pending = ArrayList<Pair<Long, Runnable>>()
    override fun nowNs() = now
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        scheduled.add(atNs to task)
        if (reject) return false
        pending.add(atNs to task)
        maxPending = maxOf(maxPending, pending.size)
        return true
    }
    override fun cancel(task: Runnable) {
        cancelled.add(task)
        pending.removeAll { it.second === task }
    }
    fun pendingCount() = pending.size
    fun runReady() {
        while (true) {
            val entry = pending.minByOrNull { it.first } ?: return
            if (entry.first > now) return
            pending.remove(entry)
            entry.second.run()
        }
    }
}

fun main() {
    var checks = 0
    fun expect(value: Boolean) {
        check(value) { "Trace scheduler invariant failed at assertion ${checks + 1}" }
        checks++
    }

    // Deadlines and current time pass through exactly; instrumentation does not
    // introduce Handler-style millisecond rounding or synchronous execution.
    run {
        val clock = TraceSchedulerClock().apply { now = 9_876_543_210_123L }
        val events = ArrayList<String>()
        val traced = NativePacerTraceScheduler(clock) { events.add("trace:$it") }
        val task = Runnable { events.add("task") }
        val due = 9_876_543_210_999L
        expect(traced.nowNs() == clock.now)
        expect(traced.schedule(due, task))
        expect(clock.scheduled.single().first == due)
        expect(clock.scheduled.single().second !== task)
        expect(events.isEmpty() && clock.pendingCount() == 1)
        clock.now = due - 1; clock.runReady()
        expect(events.isEmpty())
        clock.now = due; clock.runReady()
        expect(events == listOf("trace:$due", "task"))
        expect(clock.pendingCount() == 0)
        clock.runReady()
        expect(events.size == 2)
    }

    // A task that is ready but has not run must still be cancellable through
    // its original identity, even though the delegate sees a wrapper identity.
    run {
        val clock = TraceSchedulerClock()
        var traceCalls = 0; var taskCalls = 0
        val traced = NativePacerTraceScheduler(clock) { traceCalls++ }
        val task = Runnable { taskCalls++ }
        val unrelated = Runnable { error("Unrelated task must not run") }
        expect(traced.schedule(123_456_789L, task))
        traced.cancel(unrelated)
        expect(clock.cancelled.isEmpty() && clock.pendingCount() == 1)
        clock.now = 123_456_789L
        traced.cancel(task)
        expect(clock.cancelled.single() === clock.scheduled.single().second)
        expect(clock.pendingCount() == 0)
        clock.runReady()
        expect(traceCalls == 0 && taskCalls == 0)
        traced.cancel(task)
        expect(clock.cancelled.size == 1)
    }

    // The policy cancels before every schedule. Reusing the exact same worker
    // Runnable must replace its wrapper and preserve at most one pending task.
    run {
        val clock = TraceSchedulerClock()
        val tracedDeadlines = ArrayList<Long>()
        var taskCalls = 0
        val traced = NativePacerTraceScheduler(clock, tracedDeadlines::add)
        val task = Runnable { taskCalls++ }
        for (index in 0 until 40) {
            traced.cancel(task)
            val due = 1_000_001L + index
            expect(traced.schedule(due, task))
            expect(clock.scheduled.last().first == due)
            expect(clock.pendingCount() == 1)
        }
        expect(clock.maxPending == 1 && clock.cancelled.size == 39)
        expect(clock.scheduled.map { it.second }.toSet().size == 40)
        clock.now = 1_000_100L; clock.runReady()
        expect(taskCalls == 1 && tracedDeadlines == listOf(1_000_040L))
        expect(clock.pendingCount() == 0)
    }

    // After each execution the same original task can be scheduled again.
    // Exact nanosecond values, including Long.MAX_VALUE, reach both delegate
    // and diagnostic callback with no arithmetic conversion by the decorator.
    run {
        val clock = TraceSchedulerClock()
        val tracedDeadlines = ArrayList<Long>()
        val seenTaskTimes = ArrayList<Long>()
        val traced = NativePacerTraceScheduler(clock, tracedDeadlines::add)
        val task = Runnable { seenTaskTimes.add(clock.now) }
        val deadlines = listOf(1L, 999_999L, 1_000_001L, 9_876_543_210_123L, Long.MAX_VALUE)
        for (due in deadlines) {
            traced.cancel(task)
            expect(traced.schedule(due, task))
            clock.now = due; clock.runReady()
            expect(clock.pendingCount() == 0)
        }
        expect(clock.scheduled.map { it.first } == deadlines)
        expect(tracedDeadlines == deadlines && seenTaskTimes == deadlines)
        expect(clock.maxPending == 1)
    }

    // A rejected schedule must discard its identity mapping: later cancel is
    // harmless, and a later accepted schedule using the same task still works.
    run {
        val clock = TraceSchedulerClock().apply { reject = true }
        var traceCalls = 0; var taskCalls = 0
        val traced = NativePacerTraceScheduler(clock) { traceCalls++ }
        val task = Runnable { taskCalls++ }
        expect(!traced.schedule(111L, task))
        expect(clock.pendingCount() == 0 && clock.scheduled.single().first == 111L)
        traced.cancel(task)
        expect(clock.cancelled.isEmpty())
        clock.now = 111L; clock.runReady()
        expect(traceCalls == 0 && taskCalls == 0)
        clock.reject = false
        expect(traced.schedule(112L, task))
        traced.cancel(task)
        expect(clock.cancelled.single() === clock.scheduled.last().second)
        expect(clock.pendingCount() == 0)
        expect(traced.schedule(113L, task))
        clock.now = 113L; clock.runReady()
        expect(traceCalls == 1 && taskCalls == 1)
    }

    // Instrumentation runs first exactly once, and any RuntimeException from
    // that instrumentation must not suppress or duplicate the actual worker.
    run {
        val clock = TraceSchedulerClock()
        val events = ArrayList<String>()
        val traced = NativePacerTraceScheduler(clock) {
            events.add("trace:$it")
            throw IllegalStateException("Diagnostic fixture")
        }
        val task = Runnable { events.add("task") }
        expect(traced.schedule(201L, task))
        clock.now = 201L; clock.runReady(); clock.runReady()
        expect(events == listOf("trace:201", "task"))
        expect(clock.pendingCount() == 0)
    }

    // The diagnostic exception guard must not accidentally swallow a failure
    // from the real worker; that task still executes exactly once.
    run {
        val clock = TraceSchedulerClock()
        var traceCalls = 0; var taskCalls = 0
        val traced = NativePacerTraceScheduler(clock) { traceCalls++ }
        val failure = IllegalArgumentException("Worker fixture")
        val task = Runnable { taskCalls++; throw failure }
        expect(traced.schedule(301L, task))
        clock.now = 301L
        var caught: RuntimeException? = null
        try { clock.runReady() } catch (error: RuntimeException) { caught = error }
        expect(caught === failure)
        expect(traceCalls == 1 && taskCalls == 1 && clock.pendingCount() == 0)
        clock.runReady()
        expect(taskCalls == 1)
    }
    println("NativePacerTraceSchedulerTest: $checks assertions PASS (diagnostic scheduler delegation only)")
}
