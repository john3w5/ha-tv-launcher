package org.hometv.launcher

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame

private class AbsoluteSdkPacerClock : NativePacerScheduler {
    var now = 0L
    var reject = false
    var maxTasks = 0
    private val tasks = ArrayList<Pair<Long, Runnable>>()
    override fun nowNs() = now
    fun sourceNow() = 1_000_000_000L + now
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        if (reject) return false
        tasks.add(atNs to task)
        maxTasks = maxOf(maxTasks, tasks.size)
        return true
    }
    override fun cancel(task: Runnable) { tasks.removeAll { it.second === task } }
    fun advanceMs(ms: Long) {
        val target = ms * 1_000_000
        check(target >= now)
        while (true) {
            val next = tasks.minByOrNull { it.first } ?: break
            if (next.first > target) break
            tasks.remove(next)
            now = maxOf(now, next.first)
            next.second.run()
        }
        now = target
    }
    fun taskCount() = tasks.size
}

/** Executes the actual M150 Java refcount, without JNI allocation or rendering. */
private class AbsoluteSdkI420Frame(timestampNs: Long = 1_000_000_000L, rotation: Int = 0,
    throwOnFree: Boolean = false) {
    val frees = AtomicInteger()
    private var callerReleased = false
    // Odd 5x3 pixels with independently padded Y/U/V strides: 8*3+(4+5)*2 = 42 B.
    val buffer = JavaI420Buffer.wrap(5, 3,
        ByteBuffer.allocateDirect(24), 8,
        ByteBuffer.allocateDirect(8), 4,
        ByteBuffer.allocateDirect(10), 5,
        Runnable {
            frees.incrementAndGet()
            if (throwOnFree) throw IllegalStateException("SDK release callback fixture")
        })
    val frame = VideoFrame(buffer, rotation, timestampNs)
    val reference = NativePacerFrameReference(frame, traceSequence = 77)
    fun releaseCaller() {
        check(!callerReleased)
        callerReleased = true
        frame.release()
    }
}

private class AbsoluteSdkNonI420Buffer : VideoFrame.Buffer {
    var references = 1
    var retains = 0
    var releases = 0
    override fun getWidth() = 2
    override fun getHeight() = 2
    override fun retain() { check(references > 0); references++; retains++ }
    override fun release() { check(references > 0); references--; releases++ }
    override fun toI420(): VideoFrame.I420Buffer = error("Bypass must not convert a non-I420 buffer")
    override fun cropAndScale(cropX: Int, cropY: Int, cropWidth: Int, cropHeight: Int,
        scaleWidth: Int, scaleHeight: Int): VideoFrame.Buffer = error("Bypass must not crop a buffer")
}

private fun newAbsoluteSdkPacer(clock: AbsoluteSdkPacerClock,
    present: (NativePacerFrameReference) -> Unit, maxBytes: Long = 32L * 1024 * 1024) =
    NativeAbsoluteFramePacerPolicy(clock, present, clock::sourceNow, maxBytes = maxBytes)

fun main() {
    var checks = 0
    fun expect(value: Boolean) {
        check(value) { "Actual WebRTC SDK invariant failed at assertion ${checks + 1}" }
        checks++
    }
    fun freed(vararg fixtures: AbsoluteSdkI420Frame) {
        fixtures.forEach { expect(it.frees.get() == 1) }
    }

    // The adapter counts actual plane strides and ceil(chroma height), preserves
    // SDK timestamps/rotation and owns the frame after the sink caller releases it.
    run {
        val clock = AbsoluteSdkPacerClock()
        val f = AbsoluteSdkI420Frame(timestampNs = 1_234_567_890L, rotation = 90)
        val shown = ArrayList<VideoFrame>()
        val p = newAbsoluteSdkPacer(clock, {
            expect(f.frees.get() == 0)
            shown.add(it.frame)
        })
        expect(f.reference.timestampNs == 1_234_567_890L)
        expect(f.reference.traceSequence == 77L && !f.reference.wasRetained)
        expect(f.reference.isI420 && f.reference.byteSize == 42L)
        expect(f.frame.rotatedWidth == 3 && f.frame.rotatedHeight == 5)
        p.offer(f.reference)
        expect(f.reference.wasRetained)
        f.releaseCaller()
        expect(f.frees.get() == 0 && p.snapshot().queuedBytes == 42L)
        clock.advanceMs(734)
        expect(shown.isEmpty() && f.frees.get() == 0)
        clock.advanceMs(735)
        expect(shown.single() === f.frame)
        freed(f)
        expect(f.reference.wasRetained) // Sticky admission evidence, not current ownership.
        expect(p.snapshot().queued == 0 && p.snapshot().queuedBytes == 0L)
        expect(p.snapshot().releaseErrors == 0L && clock.maxTasks == 1)
        p.close(); freed(f)
    }

    // A rejected incoming frame releases only its caller reference; every held
    // native SDK buffer remains alive until reset releases the queue's ownership.
    run {
        val clock = AbsoluteSdkPacerClock()
        val p = newAbsoluteSdkPacer(clock, { error("No deadline has elapsed") })
        val frames = (0..10).map { AbsoluteSdkI420Frame(1_000_000_000L + it * 70_000_000L) }
        frames.forEach { p.offer(it.reference); it.releaseCaller() }
        expect(p.snapshot().queued == 10 && p.snapshot().queuedBytes == 420L)
        expect(p.snapshot().overflowDrops == 1L)
        expect(frames.take(10).all { it.frees.get() == 0 })
        freed(frames.last())
        p.reset()
        freed(*frames.toTypedArray())
        expect(p.snapshot().queuedBytes == 0L && clock.taskCount() == 0)
        p.close(); freed(*frames.toTypedArray())
    }

    // Byte capacity is enforced independently of frame count, including padded
    // planes; repeated close and offers after close cannot retain an SDK buffer.
    run {
        val clock = AbsoluteSdkPacerClock()
        val p = newAbsoluteSdkPacer(clock, {}, maxBytes = 70)
        val a = AbsoluteSdkI420Frame(); val b = AbsoluteSdkI420Frame(1_070_000_000L)
        p.offer(a.reference); a.releaseCaller()
        p.offer(b.reference); b.releaseCaller()
        expect(p.snapshot().queued == 1 && p.snapshot().queuedBytes == 42L)
        expect(p.snapshot().overflowDrops == 1L && a.frees.get() == 0)
        freed(b)
        p.close(); p.close(); freed(a, b)
        val after = AbsoluteSdkI420Frame(1_140_000_000L)
        p.offer(after.reference); after.releaseCaller(); freed(after)
        clock.advanceMs(1000)
        expect(clock.taskCount() == 0 && p.snapshot().queuedBytes == 0L)
        expect(p.snapshot().releaseErrors == 0L)
    }

    // Both initial scheduling failure and failure while rescheduling an already
    // owned queue must release actual SDK references and close the offer gate.
    for (rejectInitially in listOf(true, false)) run {
        val clock = AbsoluteSdkPacerClock().apply { reject = rejectInitially }
        val shown = ArrayList<VideoFrame>()
        val p = newAbsoluteSdkPacer(clock, { shown.add(it.frame) })
        val a = AbsoluteSdkI420Frame()
        p.offer(a.reference); a.releaseCaller()
        val frames = arrayListOf(a)
        if (!rejectInitially) {
            val b = AbsoluteSdkI420Frame(1_070_000_000L)
            p.offer(b.reference); b.releaseCaller(); frames.add(b)
            expect(frames.all { it.frees.get() == 0 })
            clock.reject = true
            clock.advanceMs(500)
            expect(shown.single() === a.frame)
        } else expect(shown.isEmpty())
        freed(*frames.toTypedArray())
        expect(p.snapshot().scheduleErrors == 1L && p.snapshot().queued == 0)
        expect(p.snapshot().queuedBytes == 0L && clock.taskCount() == 0)
        val after = AbsoluteSdkI420Frame(1_140_000_000L)
        p.offer(after.reference); after.releaseCaller(); freed(after)
        p.close(); freed(*frames.toTypedArray())
        expect(p.snapshot().releaseErrors == 0L)
    }

    // A throwing renderer callback still releases the queue's final SDK reference.
    run {
        val clock = AbsoluteSdkPacerClock()
        val p = newAbsoluteSdkPacer(clock, { throw IllegalStateException("SDK fixture") })
        val f = AbsoluteSdkI420Frame()
        p.offer(f.reference); f.releaseCaller()
        expect(f.frees.get() == 0)
        clock.advanceMs(500)
        freed(f)
        expect(p.snapshot().renderErrors == 1L && p.snapshot().releaseErrors == 0L)
        p.close(); freed(f)
    }

    // A failing SDK release callback cannot prevent the next queued buffer from
    // being released. RefCountDelegate has already consumed the final reference.
    run {
        val clock = AbsoluteSdkPacerClock()
        val p = newAbsoluteSdkPacer(clock, {})
        val a = AbsoluteSdkI420Frame(throwOnFree = true)
        val b = AbsoluteSdkI420Frame(1_070_000_000L)
        p.offer(a.reference); a.releaseCaller()
        p.offer(b.reference); b.releaseCaller()
        expect(a.frees.get() == 0 && b.frees.get() == 0)
        p.close()
        freed(a, b)
        expect(p.snapshot().releaseErrors == 1L)
        expect(p.snapshot().queuedBytes == 0L && clock.taskCount() == 0)
        p.close(); freed(a, b)
    }

    // A real SDK VideoFrame can also wrap a non-I420 buffer. Bypass neither
    // converts nor retains it, and first releases any older owned raw queue.
    run {
        val clock = AbsoluteSdkPacerClock()
        val raw = AbsoluteSdkI420Frame()
        val buffer = AbsoluteSdkNonI420Buffer()
        val frame = VideoFrame(buffer, 0, 1_070_000_000L)
        val reference = NativePacerFrameReference(frame)
        val shown = ArrayList<VideoFrame>()
        val p = newAbsoluteSdkPacer(clock, {
            expect(buffer.references == 1)
            shown.add(it.frame)
        })
        p.offer(raw.reference); raw.releaseCaller()
        expect(!reference.isI420 && reference.byteSize == 0L)
        p.offer(reference)
        freed(raw)
        expect(shown.single() === frame && buffer.retains == 0 && buffer.releases == 0)
        frame.release()
        expect(buffer.references == 0 && buffer.releases == 1)
        expect(p.snapshot().bypassed == 1L && p.snapshot().queuedBytes == 0L)
        expect(clock.taskCount() == 0)
        p.close(); clock.advanceMs(1000)
        expect(buffer.retains == 0 && buffer.releases == 1)
        freed(raw)
    }
    // A valid late first render deadline is immediate and cannot poison later
    // source-clock mapping. Actual SDK buffers remain owned until each callback.
    run {
        val clock = AbsoluteSdkPacerClock()
        val shown = ArrayList<Pair<VideoFrame, Long>>()
        val p = newAbsoluteSdkPacer(clock, { shown.add(it.frame to clock.now) })
        val late = AbsoluteSdkI420Frame(clock.sourceNow() - 864_000_000)
        p.offer(late.reference); late.releaseCaller()
        expect(late.frees.get() == 0 && late.reference.wasRetained)
        clock.advanceMs(0); freed(late)
        expect(shown.single() == late.frame to 0L && p.snapshot().expiredAtOffer == 1L)
        clock.advanceMs(588)
        val normal = AbsoluteSdkI420Frame(clock.sourceNow() + 9_000_000)
        p.offer(normal.reference); normal.releaseCaller()
        expect(normal.frees.get() == 0 && p.snapshot().headAheadMs == 509L)
        clock.advanceMs(1096); expect(normal.frees.get() == 0)
        clock.advanceMs(1097); freed(normal)
        expect(shown.last() == normal.frame to 1_097_000_000L)
        expect(p.snapshot().bridgeOffsetNs == -1_000_000_000L && p.snapshot().bridgeSamples == 1L)
        expect(p.snapshot().invalidClockFrames == 0L && p.snapshot().fallbackFrames == 0L)
        p.close(); freed(late, normal)
    }

    println("NativeAbsoluteFramePacerSdkTest: $checks assertions PASS (actual M150 Java SDK; no native rendering)")
}
