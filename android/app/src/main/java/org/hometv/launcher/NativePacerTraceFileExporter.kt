package org.hometv.launcher

import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.GeneralSecurityException
import java.security.MessageDigest

/** After-close file sink only; never retains frames or writes while recording. */
internal class NativePacerTraceFileExporter(maxBytes: Long = MAX_BYTES) {
    companion object {
        const val MAX_BYTES = 3L * 1024 * 1024
        const val FILE_NAME = "latest.log"
        private const val TEMP_NAME = "latest.tmp"
        // A single pathname is shared even when successive sessions use different
        // exporter instances. This lock is never held by policy/recording code.
        private val exportLock = Any()
    }

    /** Failed results never identify or hash an older latest.log as this session. */
    data class Result(val session: Long, val bytes: Long, val sha256: String?,
        val fileName: String?, val success: Boolean, val errorCode: String?)

    private class SizeLimitException : IOException("Timing trace file size limit")
    private class ExportStatusException(val code: String) : RuntimeException(code)
    private val limit = maxBytes.also { require(it in 1..MAX_BYTES) }

    fun export(trace: NativePacerTimingTrace, directory: File, pid: Int): Result =
        synchronized(exportLock) {
            fun failed(code: String) = Result(trace.session, 0, null, null, false, code)
            if (pid <= 0) return@synchronized failed("invalid_pid")
            if (trace.snapshot().exported) return@synchronized failed("trace_already_exported")
            val temporary = File(directory, TEMP_NAME)
            val latest = File(directory, FILE_NAME)
            try {
                if (!directory.isDirectory && !directory.mkdirs())
                    throw ExportStatusException("directory_unavailable")
                if (temporary.exists() && !temporary.delete())
                    throw ExportStatusException("temporary_unavailable")
                val initialErrors = trace.snapshot().emitErrors
                var encodedBytes = 0L
                var sawBegin = false
                var sawEnd = false
                var callbackFailure: IOException? = null
                val prefix = "I/HomeTVPacerTrace($pid): "
                BufferedOutputStream(FileOutputStream(temporary)).use { output ->
                    trace.export { line ->
                        try {
                            val bytes = (prefix + line + "\n").toByteArray(Charsets.UTF_8)
                            if (bytes.size.toLong() > limit - encodedBytes) throw SizeLimitException()
                            output.write(bytes)
                            encodedBytes += bytes.size
                            if (line.startsWith("stage=pacer_trace_begin ")) sawBegin = true
                            if (line.startsWith("stage=pacer_trace_end ")) sawEnd = true
                        } catch (error: IOException) {
                            callbackFailure = error
                            // The recorder owns its one-shot callback boundary.
                            // Convert checked I/O failure to its handled RuntimeException.
                            throw RuntimeException(error)
                        }
                    }
                    callbackFailure?.let { throw it }
                    if (trace.snapshot().emitErrors != initialErrors)
                        throw ExportStatusException("trace_emit_error")
                    if (!sawBegin || !sawEnd) throw ExportStatusException("trace_export_unavailable")
                    output.flush()
                }
                // Hash actual closed-file bytes, rather than merely trusting the
                // callback's byte count or hashing a character representation.
                val digest = MessageDigest.getInstance("SHA-256")
                var actualBytes = 0L
                FileInputStream(temporary).use { input ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        actualBytes += read
                        if (actualBytes > limit) throw SizeLimitException()
                        digest.update(buffer, 0, read)
                    }
                }
                if (actualBytes != encodedBytes) throw ExportStatusException("file_size_mismatch")
                val hash = digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
                // No delete-then-rename fallback: on unsupported/non-atomic move,
                // preserve the previous latest file and return a failed result.
                Files.move(temporary.toPath(), latest.toPath(),
                    StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                Result(trace.session, actualBytes, hash, FILE_NAME, true, null)
            } catch (_: SizeLimitException) {
                failed("size_limit")
            } catch (_: AtomicMoveNotSupportedException) {
                failed("atomic_move_unsupported")
            } catch (error: ExportStatusException) {
                failed(error.code)
            } catch (_: IOException) {
                failed("io_error")
            } catch (_: GeneralSecurityException) {
                failed("sha256_unavailable")
            } catch (_: LinkageError) {
                // Files.move is available on the household TV (API 34), but
                // this diagnostic sink must not crash cleanup on API 24/25.
                failed("file_api_unavailable")
            } catch (_: RuntimeException) {
                failed("runtime_error")
            } finally {
                // In particular, a failed export cannot become a partial latest.
                // File.delete is best effort if the underlying filesystem failed.
                try { if (temporary.exists()) temporary.delete() } catch (_: RuntimeException) { }
            }
        }
}
