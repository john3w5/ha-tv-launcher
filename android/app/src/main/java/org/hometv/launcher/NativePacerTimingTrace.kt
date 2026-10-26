package org.hometv.launcher

/**
 * Bounded numeric timing evidence, with no frame/buffer references or recording I/O.
 *
 * Each row has exactly [ROW_WIDTH] Longs in [COLUMNS] order. Event codes belong to
 * the caller; schema 2 uses event 1=offer, 2=submit and 3=worker start. Values are
 * preserved verbatim, including unknown-field sentinels and Long.MIN/MAX_VALUE.
 * Only export formats text. Its callback runs without this recorder's lock.
 */
internal class NativePacerTimingTrace(val session: Long, maxRows: Int = MAX_ROWS) {
    companion object {
        const val SCHEMA = 2
        const val ROW_WIDTH = 20
        const val BLOCK_ROWS = 8
        const val MAX_ROWS = 6144
        const val COLUMNS = "event,seq,sdkNs,nanoNs,uptimeNs,dueNs,queued,queuedBytes,headAheadMs,tailAheadMs,correctionMs,offered,submitted,overflow,late,resets,bypassed,renderErrors,callbackNs,retained"
    }

    /**
     * exported means an attempt was claimed, including a failed one.
     * pendingObservations is live; END reports its frozen value at export cutoff.
     */
    data class Stats(val rows: Int, val lostRows: Long, val closed: Boolean,
        val exported: Boolean, val emitErrors: Long, val storageLongs: Int,
        val pendingObservations: Long, val acceptingObservations: Boolean)

    private data class ExportState(val values: LongArray, val rows: Int, val lostRows: Long,
        val pendingObservations: Long)
    private val capacity = maxRows.also { require(it in 1..MAX_ROWS) }
    // 6144*20*8 = 983040 payload bytes; the backing array stays below 1 MiB.
    private var storage: LongArray? = LongArray(capacity * ROW_WIDTH)
    private var rowCount = 0
    private var lostRows = 0L
    private var closed = false
    private var exported = false
    private var emitErrors = 0L
    private var acceptingObservations = true
    private var pendingObservations = 0L

    /** Short admission lease; never call external/policy code under this monitor. */
    @Synchronized fun beginObservation(): Boolean {
        if (!acceptingObservations || pendingObservations == Long.MAX_VALUE) return false
        pendingObservations++
        return true
    }

    /** Pair only a successful beginObservation, in the observer's finally block. */
    @Synchronized fun endObservation() {
        check(pendingObservations > 0) { "Unbalanced timing observation lease" }
        pendingObservations--
    }

    /** Stop new leases without discarding records from already admitted work. */
    @Synchronized fun sealAdmissions() { acceptingObservations = false }

    /** Convenience API; callers on the frame path should use the direct overload. */
    @Synchronized fun record(vararg values: Long) {
        require(values.size == ROW_WIDTH) { "A timing row requires exactly 20 Long values" }
        val base = reserveRow()
        if (base < 0) return
        val target = storage ?: return
        for (index in 0 until ROW_WIDTH) target[base + index] = values[index]
    }

    /** Hot-path overload: writes the fixed row directly, without a vararg array. */
    @Synchronized fun record(event: Long, seq: Long, sdkNs: Long, nanoNs: Long,
        uptimeNs: Long, dueNs: Long, queued: Long, queuedBytes: Long,
        headAheadMs: Long, tailAheadMs: Long, correctionMs: Long, offered: Long,
        submitted: Long, overflow: Long, late: Long, resets: Long, bypassed: Long,
        renderErrors: Long, callbackNs: Long, retained: Long) {
        val base = reserveRow()
        if (base < 0) return
        val target = storage ?: return
        target[base] = event
        target[base + 1] = seq
        target[base + 2] = sdkNs
        target[base + 3] = nanoNs
        target[base + 4] = uptimeNs
        target[base + 5] = dueNs
        target[base + 6] = queued
        target[base + 7] = queuedBytes
        target[base + 8] = headAheadMs
        target[base + 9] = tailAheadMs
        target[base + 10] = correctionMs
        target[base + 11] = offered
        target[base + 12] = submitted
        target[base + 13] = overflow
        target[base + 14] = late
        target[base + 15] = resets
        target[base + 16] = bypassed
        target[base + 17] = renderErrors
        target[base + 18] = callbackNs
        target[base + 19] = retained
    }

    /** Called only with the recorder monitor held; -1 means ignored or full. */
    private fun reserveRow(): Int {
        if (closed) return -1
        if (rowCount >= capacity) {
            if (lostRows != Long.MAX_VALUE) lostRows++
            return -1
        }
        return rowCount++ * ROW_WIDTH
    }

    /**
     * Atomically seals admission and closes recording, freezing pending leases
     * alongside the rows. It never waits for those leases. END must report this
     * frozen count even when a late observer finishes while export is emitting.
     * Then emits BEGIN, blocks of <=8 rows, and END.
     * Concurrent/reentrant/repeated exports do nothing. A RuntimeException from
     * emit is counted and aborts the attempt; no retry can duplicate prior lines.
     * Storage is released even when the emitter throws any other Throwable.
     */
    fun export(emit: (String) -> Unit) {
        val state = synchronized(this) {
            if (exported) return
            acceptingObservations = false
            closed = true
            exported = true
            ExportState(storage ?: return, rowCount, lostRows, pendingObservations)
        }
        try {
            emit("stage=pacer_trace_begin session=$session schema=$SCHEMA columns=$COLUMNS")
            var offset = 0
            while (offset < state.rows) {
                val rows = minOf(BLOCK_ROWS, state.rows - offset)
                val line = buildString(3500) {
                    append("stage=pacer_trace_data session=").append(session)
                    append(" offset=").append(offset).append(" rows=").append(rows).append(" data=")
                    for (row in 0 until rows) {
                        if (row != 0) append(';')
                        val base = (offset + row) * ROW_WIDTH
                        for (column in 0 until ROW_WIDTH) {
                            if (column != 0) append(',')
                            append(state.values[base + column])
                        }
                    }
                }
                emit(line)
                offset += rows
            }
            emit("stage=pacer_trace_end session=$session rows=${state.rows} lostRows=${state.lostRows} pendingObservations=${state.pendingObservations} emitErrors=0")
        } catch (_: RuntimeException) {
            synchronized(this) { emitErrors++ }
        } finally {
            synchronized(this) { storage = null }
        }
    }

    @Synchronized fun snapshot() = Stats(rowCount, lostRows, closed, exported,
        emitErrors, storage?.size ?: 0, pendingObservations, acceptingObservations)
}
