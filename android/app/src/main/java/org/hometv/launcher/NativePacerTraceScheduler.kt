package org.hometv.launcher

/** Single-task decorator; the policy serializes schedule/cancel under its lock. */
internal class NativePacerTraceScheduler(
    private val delegate: NativePacerScheduler,
    private val onRun: (Long) -> Unit,
) : NativePacerScheduler {
    private var original: Runnable? = null
    private var wrapped: Runnable? = null
    override fun nowNs() = delegate.nowNs()
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        val actual = Runnable {
            // Failed instrumentation must never suppress the real worker task.
            try { onRun(atNs) } catch (_: RuntimeException) { }
            task.run()
        }
        original = task; wrapped = actual
        val accepted = delegate.schedule(atNs, actual)
        if (!accepted) { original = null; wrapped = null }
        return accepted
    }
    override fun cancel(task: Runnable) {
        if (original === task) {
            wrapped?.let(delegate::cancel)
            original = null; wrapped = null
        }
    }
}
