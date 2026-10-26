package org.hometv.launcher

import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import java.security.MessageDigest

private fun fileTrace(session: Long, rows: Int = 1): NativePacerTimingTrace {
    val trace = NativePacerTimingTrace(session)
    repeat(rows) { index ->
        trace.record(1, index + 1L, 1_000_000_000L + index, 2_000_000_000L + index,
            2_000_000_000L + index, Long.MIN_VALUE, 1, 3_110_400,
            500, 500, 0, index + 1L, 0, 0, 0, 1, 0, 0, 0, 1)
    }
    return trace
}

private fun fileSha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256")
    .digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }

private class BrokenTraceDirectory(path: String) : File(path) {
    override fun isDirectory(): Boolean = throw IllegalStateException("Filesystem fixture")
}

private class FileExportPolicyClock : NativePacerScheduler {
    var now = 0L
    private var pending: Runnable? = null
    private var due = 0L
    override fun nowNs() = now
    override fun schedule(atNs: Long, task: Runnable): Boolean {
        check(pending == null)
        pending = task; due = atNs
        return true
    }
    override fun cancel(task: Runnable) { if (pending === task) pending = null }
    fun advanceTo(atNs: Long) {
        now = atNs
        if (pending != null && due <= now) {
            val task = pending; pending = null; task?.run()
        }
    }
}

private class FileExportPolicyFrame : NativePacedFrame {
    override val timestampNs = 1_000_000_000L
    override val byteSize = 1024L
    override val isI420 = true
    var references = 1
    override fun retain() { references++ }
    override fun release() { check(references > 1); references-- }
}

fun main() {
    var checks = 0
    fun expect(value: Boolean) {
        check(value) { "Timing trace file export invariant failed at assertion ${checks + 1}" }
        checks++
    }
    fun failed(result: NativePacerTraceFileExporter.Result, session: Long) {
        expect(!result.success && result.session == session && result.errorCode != null)
        expect(result.bytes == 0L && result.sha256 == null && result.fileName == null)
    }
    val root = Files.createTempDirectory("pacer-trace-file-test-").toFile()
    try {
        run {
            val directory = File(root, "normal")
            val trace = fileTrace(101, 17)
            val result = NativePacerTraceFileExporter().export(trace, directory, 4567)
            expect(result.success && result.errorCode == null && result.session == 101L)
            expect(result.fileName == "latest.log")
            val bytes = File(directory, "latest.log").readBytes()
            expect(result.bytes == bytes.size.toLong() && result.bytes <= NativePacerTraceFileExporter.MAX_BYTES)
            expect(result.sha256 == fileSha256(bytes))
            val lines = bytes.toString(Charsets.UTF_8).trimEnd('\n').lines()
            expect(lines.size == 5 && lines.all { it.startsWith("I/HomeTVPacerTrace(4567): ") })
            expect(lines.first().contains("stage=pacer_trace_begin session=101 schema=2 columns=${NativePacerTimingTrace.COLUMNS}"))
            expect(lines[1].contains(" offset=0 rows=8 data="))
            expect(lines[2].contains(" offset=8 rows=8 data="))
            expect(lines[3].contains(" offset=16 rows=1 data="))
            expect(lines.last().endsWith("rows=17 lostRows=0 pendingObservations=0 emitErrors=0"))
            expect(lines.all { it.length < 3800 })
            expect(directory.listFiles()?.map { it.name } == listOf("latest.log"))
            expect(trace.snapshot().storageLongs == 0 && trace.snapshot().emitErrors == 0L)

            // Holding the old inode open distinguishes atomic replacement from
            // truncating/reusing latest.log while a reader could observe it.
            FileInputStream(File(directory, "latest.log")).use { oldReader ->
                val replacement = NativePacerTraceFileExporter().export(fileTrace(102, 29), directory, 4567)
                expect(replacement.success && replacement.session == 102L)
                expect(oldReader.readBytes().contentEquals(bytes))
                val current = File(directory, "latest.log").readBytes()
                expect(!current.contentEquals(bytes) && replacement.sha256 == fileSha256(current))
                expect(current.toString(Charsets.UTF_8).contains("session=102"))
            }
            expect(directory.listFiles()?.map { it.name } == listOf("latest.log"))

            // One-shot recorder semantics cannot overwrite latest with emptiness.
            val previous = File(directory, "latest.log").readBytes()
            val repeated = NativePacerTraceFileExporter().export(trace, directory, 4567)
            failed(repeated, 101)
            expect(repeated.errorCode == "trace_already_exported")
            expect(File(directory, "latest.log").readBytes().contentEquals(previous))
        }
        run {
            val directory = File(root, "cap")
            val exporter = NativePacerTraceFileExporter()
            expect(exporter.export(fileTrace(201), directory, 7).success)
            val previous = File(directory, "latest.log").readBytes()
            val trace = fileTrace(202, 17)
            val result = NativePacerTraceFileExporter(maxBytes = 400).export(trace, directory, 7)
            failed(result, 202)
            expect(result.errorCode == "size_limit")
            expect(trace.snapshot().exported && trace.snapshot().emitErrors == 1L)
            expect(trace.snapshot().storageLongs == 0)
            expect(!File(directory, "latest.tmp").exists())
            expect(File(directory, "latest.log").readBytes().contentEquals(previous))
            expect(directory.listFiles()?.size == 1)
        }
        run {
            val directory = File(root, "cap-no-previous")
            val trace = fileTrace(203)
            val result = NativePacerTraceFileExporter(maxBytes = 1).export(trace, directory, 7)
            failed(result, 203)
            expect(result.errorCode == "size_limit")
            expect(directory.listFiles()?.isEmpty() == true)
            expect(trace.snapshot().exported && trace.snapshot().storageLongs == 0)
        }
        run {
            // A complete file can truthfully contain a pending cutoff. Export
            // stores it; only the offline parser decides trace completeness.
            val directory = File(root, "pending")
            val trace = fileTrace(301)
            expect(trace.beginObservation())
            val result = NativePacerTraceFileExporter().export(trace, directory, 99)
            expect(result.success)
            expect(File(directory, "latest.log").readText().contains("pendingObservations=1"))
            trace.endObservation()
        }
        run {
            val directory = File(root, "existing-file").apply { writeText("sentinel") }
            val trace = fileTrace(401)
            val result = NativePacerTraceFileExporter().export(trace, directory, 3)
            failed(result, 401)
            expect(result.errorCode == "directory_unavailable")
            expect(directory.readText() == "sentinel")
            expect(!File(directory, "latest.tmp").exists())
            expect(!trace.snapshot().exported)
        }
        run {
            val trace = fileTrace(402)
            val result = NativePacerTraceFileExporter().export(trace, BrokenTraceDirectory(File(root, "broken").path), 3)
            failed(result, 402)
            expect(result.errorCode == "runtime_error")
            expect(!File(root, "broken/latest.tmp").exists())
            expect(!trace.snapshot().exported)
        }
        run {
            val directory = File(root, "invalid-pid")
            val trace = fileTrace(403)
            val result = NativePacerTraceFileExporter().export(trace, directory, -1)
            failed(result, 403)
            expect(result.errorCode == "invalid_pid")
            expect(!directory.exists() && !trace.snapshot().exported)
        }
        for (limit in listOf(0L, -1L, NativePacerTraceFileExporter.MAX_BYTES + 1, Long.MAX_VALUE)) {
            var rejected = false
            try { NativePacerTraceFileExporter(limit) } catch (_: IllegalArgumentException) { rejected = true }
            expect(rejected)
        }
        run {
            // Filesystem/runtime failure must neither run nor alter pending
            // policy work. This uses the actual policy, not a mock pacer.
            val clock = FileExportPolicyClock()
            val frame = FileExportPolicyFrame()
            var presented = 0
            val policy = NativeFramePacerPolicy<FileExportPolicyFrame>(clock, { presented++ })
            policy.offer(frame)
            val before = policy.snapshot()
            val result = NativePacerTraceFileExporter().export(fileTrace(501), BrokenTraceDirectory(File(root, "policy-broken").path), 11)
            failed(result, 501)
            expect(policy.snapshot() == before && presented == 0 && frame.references == 2)
            clock.advanceTo(500_000_000L)
            expect(presented == 1 && frame.references == 1)
            policy.close()
        }
    } finally { root.deleteRecursively() }
    println("NativePacerTraceFileExporterTest: $checks assertions PASS (actual private-file bytes/atomic replacement only)")
}
