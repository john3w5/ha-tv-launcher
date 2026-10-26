package org.hometv.launcher

import com.google.gson.GsonBuilder
import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.security.MessageDigest
import kotlin.system.exitProcess

/** Offline only. Compile the preserved .5.15 class under this TEMP-only name:
 * NativeFramePacerPolicy -> NativeRecordedBaselinePolicy. Do not compile .5.16
 * as that reference. The original file hash is also checked by the CLI.
 */
internal object NativePacerTraceReplay {
    const val BASELINE_SHA256 = "548f70f8e34c37eb599cd5deed881766f77ca0bbfc4fb7410d2523160d2dd926"
    private const val MS = 1_000_000L
    private val integer = Regex("-?\\d+")
    private val names = NativePacerTimingTrace.COLUMNS.split(',')

    data class Row(val rowIndex: Int, val values: LongArray) {
        val event get() = values[0]
        val seq get() = values[1]
        val sdk get() = values[2]
        val nano get() = values[3]
        val uptime get() = values[4]
        val due get() = values[5]
        val queued get() = values[6]
        val bytes get() = values[7]
        val retained get() = values[19]
    }
    data class Input(val pid: Int, val session: Long, val reportSha256: String,
        val rows: List<Row>, val offers: List<Row>, val workers: List<Row>, val submits: List<Row>)
    data class Assumption(val frameBytes: Long, val format: String = "assumed_uniform_I420",
        val evidence: String)
    data class PolicyStats(val offered: Long, val submitted: Long, val overflow: Long,
        val late: Long, val resets: Long, val fallback: Long, val bypassed: Long,
        val renderErrors: Long, val releaseErrors: Long, val scheduleErrors: Long,
        val queued: Int, val queuedBytes: Long, val extra: Map<String, Any?> = emptyMap())
    data class Run(val engine: String, val schedulerProfile: String, val equalTickOrder: String,
        val inputOffers: Int, val statsBeforeClose: PolicyStats, val inferredFlushDropsBeforeClose: Long,
        val pendingTailAtCutoff: Int, val flushedByModelClose: Int,
        val conservationHolds: Boolean, val allReferencesReleasedAfterClose: Boolean,
        val maxObservedQueued: Int, val maxObservedQueuedBytes: Long,
        val submittedIds: List<Long>, val submittedUptimeNs: List<Long>,
        val outputGapNs: Map<String, Long?>, val outputGapMinusSdkIntervalNs: Map<String, Long?>,
        val modelCutoffUptimeNs: Long)
    data class Calibration(val matchesRecordedDeadlinesAndSubmitIds: Boolean,
        val observedWorkerCount: Int, val missingPendingWorkers: Int,
        val workersBeforeGeneratedDeadline: Int, val deadlineMismatchCount: Int,
        val firstDeadlineMismatches: List<Map<String, Long>>, val clockPairReversals: Int,
        val observedSubmitIds: List<Long>, val run: Run)

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun number(value: JsonElement?): Long {
        require(value != null && value.isJsonPrimitive && value.asJsonPrimitive.isNumber &&
            integer.matches(value.toString())) { "Expected an exact integer JSON number" }
        return value.toString().toLong()
    }
    private fun yes(value: JsonElement?): Boolean = value != null && value.isJsonPrimitive &&
        value.asJsonPrimitive.isBoolean && value.asBoolean
    private fun emptyArray(value: JsonElement?) = value != null && value.isJsonArray && value.asJsonArray.size() == 0

    /** Completeness here is admission/export completeness, never TV smoothness. */
    fun load(text: String, wantedPid: Int? = null, wantedSession: Long? = null): Input {
        val top = JsonParser.parseString(text).asJsonObject
        require(yes(top["complete"]) && emptyArray(top["unassignedRecords"])) { "Report is not complete" }
        val sessions = top.getAsJsonArray("sessions").map { it.asJsonObject }.filter {
            (wantedPid == null || number(it["pid"]) == wantedPid.toLong()) &&
                (wantedSession == null || number(it["session"]) == wantedSession)
        }
        require(sessions.size == 1) { "Select exactly one PID/session" }
        val session = sessions.single()
        require(yes(session["complete"]) && emptyArray(session["issues"])) { "Session is not complete" }
        val header = session.getAsJsonObject("begin")
        require(number(header["schema"]) == 2L) { "Replay requires schema 2" }
        require(header.getAsJsonArray("columns").map { it.asString } == names) { "Unexpected columns" }
        val end = session.getAsJsonObject("end")
        for (field in listOf("lostRows", "emitErrors", "pendingObservations"))
            require(number(end[field]) == 0L) { "Nonzero $field" }
        val encoded = session.getAsJsonArray("rows") ?: error("Use parser --include-rows")
        require(encoded.size() in 1..6144 && number(end["rows"]) == encoded.size().toLong() &&
            number(session["decodedRowCount"]) == encoded.size().toLong()) { "Row count mismatch" }
        val rows = encoded.mapIndexed { index, value ->
            val row = value.asJsonObject
            require(number(row["rowIndex"]) == index.toLong()) { "Noncontiguous rows" }
            Row(index, LongArray(20) { number(row[names[it]]) })
        }
        for (row in rows) {
            require(row.nano >= 0 && row.uptime >= 0) { "Unavailable observed clocks" }
            require((row.event == 1L && row.seq > 0 && row.retained in 0L..1L) ||
                (row.event == 2L && row.seq > 0 && row.retained == 1L) ||
                (row.event == 3L && row.seq == 0L && row.retained == -1L && row.due != Long.MIN_VALUE)) {
                "Unsupported row/callback shape"
            }
            require(row.values[16] == 0L && row.values[17] == 0L) { "Bypass/errors require unavailable per-frame format/error data" }
        }
        require(rows.map { it.values[15] }.distinct().size == 1) { "Unrecorded reset during input" }
        val offers = rows.filter { it.event == 1L }.sortedBy { it.seq }
        require(offers.isNotEmpty() && offers.withIndex().all { it.value.seq == it.index + 1L }) { "Missing/duplicate OFFER sequence" }
        require(offers.zipWithNext().all { (a, b) -> b.nano >= a.nano && b.uptime >= a.uptime }) { "Arrival clock reversal" }
        val bySequence = offers.associateBy { it.seq }
        val submits = rows.filter { it.event == 2L }
        require(submits.map { it.seq }.distinct().size == submits.size) { "Duplicate SUBMIT" }
        require(submits.all { bySequence[it.seq]?.sdk == it.sdk }) { "Unmatched/mismatched SUBMIT" }
        val pid = number(session["pid"])
        require(pid in 1..Int.MAX_VALUE.toLong()) { "PID identity is required" }
        return Input(pid.toInt(), number(session["session"]), sha256(text.toByteArray(Charsets.UTF_8)),
            rows, offers, rows.filter { it.event == 3L }, submits)
    }

    fun assumeUniform(input: Input, explicitBytes: Long? = null): Assumption {
        val ratios = input.rows.filter { it.queued > 0 }.map {
            require(it.bytes > 0 && it.bytes % it.queued == 0L) { "Queue ratio cannot establish a uniform byte assumption" }
            it.bytes / it.queued
        }.distinct()
        val bytes = explicitBytes ?: ratios.singleOrNull() ?: error("No unique observed queue byte/count ratio")
        require(bytes in 1..32L * 1024 * 1024) { "Unsupported frame byte assumption" }
        if (explicitBytes == null) require(ratios.size == 1)
        return Assumption(bytes, evidence = if (explicitBytes == null)
            "explicitly_requested_assumption_from_uniform_queue_ratio_not_per_frame_measurement" else "explicit_user_supplied_frame_size_not_per_frame_measurement")
    }

    private class Frame(val row: Row, override val byteSize: Long) : NativePacedFrame {
        override val timestampNs = row.sdk
        override val isI420 = true
        var refs = 1; var retains = 0; var releases = 0; var callerReleased = false; var submitted = false
        override fun retain() { check(refs > 0); refs++; retains++ }
        override fun release() { check(refs > 0); refs--; releases++ }
        fun releaseCaller() { check(!callerReleased && refs > 0); callerReleased = true; refs-- }
    }
    private interface Engine {
        fun offer(frame: Frame)
        fun close()
        fun stats(): PolicyStats
    }
    private data class Pending(val due: Long, val dispatch: Long, val task: Runnable)
    private class Clock(val input: Input, val profile: String) : NativePacerScheduler {
        var uptime = input.offers.first().uptime
        var nano = input.offers.first().nano
        var pending: Pending? = null
        private val firstNano = nano
        private val firstUptime = uptime
        private val delays = input.workers.sortedBy { it.uptime }.map {
            it.uptime to (it.uptime - roundMs(it.due)).coerceAtLeast(0)
        }
        override fun nowNs() = uptime
        override fun cancel(task: Runnable) { if (pending?.task === task) pending = null }
        override fun schedule(atNs: Long, task: Runnable): Boolean {
            check(pending == null) { "Model supports the policy's single pending task" }
            val rounded = maxOf(uptime, roundMs(atNs))
            val delay = when (profile) {
                "max_observed" -> delays.maxOfOrNull { it.second } ?: 0L
                "observed_time_profile" -> delays.lastOrNull { it.first <= rounded }?.second ?: delays.firstOrNull()?.second ?: 0L
                else -> 0L
            }
            pending = Pending(atNs, Math.addExact(rounded, delay), task)
            return true
        }
        fun observed(row: Row): Boolean {
            val reversed = row.uptime < uptime
            uptime = maxOf(uptime, row.uptime); nano = row.nano
            return reversed
        }
        fun dispatch(atNs: Long) {
            check(atNs >= uptime)
            uptime = atNs
            nano = Math.addExact(firstNano, Math.subtractExact(uptime, firstUptime))
            val next = pending ?: error("No pending model task")
            pending = null
            next.task.run()
        }
        companion object {
            fun roundMs(value: Long): Long {
                require(value >= 0) { "Invalid scheduler deadline" }
                val remainder = value % MS
                return if (remainder == 0L) value else Math.addExact(value, MS - remainder)
            }
        }
    }
    private fun engine(name: String, clock: Clock, present: (Frame) -> Unit): Engine {
        if (name == "preserved_0.5.15") {
            val p = NativeRecordedBaselinePolicy<Frame>(clock, present)
            return object : Engine {
                override fun offer(frame: Frame) = p.offer(frame)
                override fun close() = p.close()
                override fun stats(): PolicyStats { val s = p.snapshot(); return PolicyStats(s.offered, s.presented,
                    s.overflowDrops, s.lateDrops, s.resets, s.fallbackFrames, s.bypassed,
                    s.renderErrors, s.releaseErrors, s.scheduleErrors, s.queued, s.queuedBytes) }
            }
        }
        require(name == "absolute_candidate")
        val p = NativeAbsoluteFramePacerPolicy<Frame>(clock, present, { clock.nano })
        return object : Engine {
            override fun offer(frame: Frame) = p.offer(frame)
            override fun close() = p.close()
            override fun stats(): PolicyStats { val s = p.snapshot(); return PolicyStats(s.offered, s.presented,
                s.overflowDrops, s.lateDrops, s.resets, s.fallbackFrames, s.bypassed,
                s.renderErrors, s.releaseErrors, s.scheduleErrors, s.queued, s.queuedBytes,
                mapOf("bridgeValid" to s.bridgeValid, "bridgeOffsetNs" to s.bridgeOffsetNs,
                    "bridgeSampleWidthNs" to s.bridgeSampleWidthNs, "expiredAtOffer" to s.expiredAtOffer,
                    "invalidClockFrames" to s.invalidClockFrames, "flushDrops" to s.flushDrops)) }
        }
    }
    private class Accumulator(val input: Input, val assumption: Assumption, val name: String,
        val profile: String, val order: String) {
        val clock = Clock(input, profile)
        val frames = ArrayList<Frame>()
        val presented = ArrayList<Pair<Frame, Long>>()
        val policy = engine(name, clock) { frame ->
            check(!frame.submitted && frame.refs > 0); frame.submitted = true
            presented.add(frame to clock.uptime)
        }
        var maxQueued = 0; var maxBytes = 0L; var dispatches = 0
        fun inspect() {
            val s = policy.stats()
            check(s.queued in 0..10 && s.queuedBytes in 0..32L * 1024 * 1024)
            maxQueued = maxOf(maxQueued, s.queued); maxBytes = maxOf(maxBytes, s.queuedBytes)
        }
        fun offer(row: Row) {
            clock.observed(row)
            val frame = Frame(row, assumption.frameBytes); frames.add(frame)
            try { policy.offer(frame) } finally { frame.releaseCaller() }
            inspect()
        }
        fun dispatch(at: Long) {
            check(++dispatches <= 100_000) { "Unbounded model task loop" }
            clock.dispatch(at); inspect()
        }
        fun finish(cutoff: Long): Run {
            val s = policy.stats()
            val unpresentedReleased = frames.count { it.retains > 0 && it.refs == 0 && !it.submitted }.toLong()
            val flush = unpresentedReleased - s.late
            check(flush >= 0)
            val conserved = s.offered == s.submitted + s.overflow + s.late + flush + s.queued + s.bypassed
            val gaps = presented.zipWithNext().map { (a, b) -> b.second - a.second }
            val sourceErrors = presented.zipWithNext().map { (a, b) ->
                (b.second - a.second) - (b.first.timestampNs - a.first.timestampNs)
            }
            val heldBeforeClose = frames.count { it.refs > 0 }
            policy.close()
            val ownership = frames.all { it.refs == 0 && it.callerReleased && it.retains == it.releases }
            check(conserved && ownership) { "Replay ownership/accounting invariant failed" }
            return Run(name, profile, order, input.offers.size, s, flush, s.queued, heldBeforeClose,
                conserved, ownership, maxQueued, maxBytes, presented.map { it.first.row.seq },
                presented.map { it.second }, distribution(gaps), distribution(sourceErrors), cutoff)
        }
    }

    /** Original dispatch slots calibrate only the preserved baseline, never candidate timing. */
    fun calibrate(input: Input, assumption: Assumption): Calibration {
        val a = Accumulator(input, assumption, "preserved_0.5.15", "recorded_worker_slots", "recorded_nano_then_row_index")
        var missing = 0; var early = 0; var mismatch = 0; var reversals = 0
        val examples = ArrayList<Map<String, Long>>()
        for (row in input.rows.filter { it.event == 1L || it.event == 3L }.sortedWith(compareBy<Row> { it.nano }.thenBy { it.rowIndex })) {
            if (a.clock.observed(row)) reversals++
            if (row.event == 1L) { a.offer(row); continue }
            val pending = a.clock.pending
            if (pending == null) { missing++; continue }
            if (pending.due != row.due) {
                mismatch++
                if (examples.size < 32) examples.add(mapOf("rowIndex" to row.rowIndex.toLong(),
                    "recordedDueNs" to row.due, "generatedDueNs" to pending.due))
            }
            if (Clock.roundMs(pending.due) > a.clock.uptime) { early++; continue }
            a.dispatch(a.clock.uptime)
        }
        val observed = input.submits.map { it.seq }
        val run = a.finish(input.rows.maxOf { it.uptime })
        return Calibration(missing == 0 && early == 0 && mismatch == 0 && reversals == 0 &&
            run.submittedIds == observed, input.workers.size, missing, early, mismatch, examples, reversals, observed, run)
    }

    /** Counterfactual scheduling; original worker ordinals never drive the candidate. */
    fun simulate(input: Input, assumption: Assumption, name: String, profile: String,
        order: String): Run {
        require(profile in listOf("round_only", "observed_time_profile", "max_observed"))
        require(order in listOf("worker_first", "offer_first"))
        val a = Accumulator(input, assumption, name, profile, order)
        fun advance(until: Long, includeEqual: Boolean) {
            while (true) {
                val next = a.clock.pending ?: break
                if (next.dispatch > until || !includeEqual && next.dispatch == until) break
                a.dispatch(next.dispatch)
            }
        }
        for (row in input.offers) {
            advance(row.uptime, order == "worker_first")
            a.offer(row)
        }
        val cutoff = input.rows.maxOf { it.uptime }
        advance(cutoff, true)
        a.clock.uptime = maxOf(a.clock.uptime, cutoff)
        return a.finish(cutoff)
    }

    private fun distribution(values: List<Long>): Map<String, Long?> {
        val sorted = values.sorted()
        fun rank(percent: Int): Long? = if (sorted.isEmpty()) null else sorted[maxOf(0, (sorted.size * percent + 99) / 100 - 1)]
        return linkedMapOf("count" to sorted.size.toLong(), "minNs" to sorted.firstOrNull(),
            "p50Ns" to rank(50), "p95Ns" to rank(95), "p99Ns" to rank(99), "maxNs" to sorted.lastOrNull(),
            "over250Ms" to values.count { it > 250_000_000 }.toLong(),
            "over500Ms" to values.count { it > 500_000_000 }.toLong())
    }
    fun report(input: Input, assumption: Assumption, candidateSource: File? = null): Map<String, Any?> {
        val calibration = calibrate(input, assumption)
        val runs = ArrayList<Run>()
        for (profile in listOf("round_only", "observed_time_profile", "max_observed"))
            for (order in listOf("worker_first", "offer_first"))
                for (name in listOf("preserved_0.5.15", "absolute_candidate"))
                    runs.add(simulate(input, assumption, name, profile, order))
        return linkedMapOf("schemaVersion" to 1, "proofScope" to "offline_counterfactual_policy_model_not_TV_or_native_renderer_proof",
            "sourceProof" to mapOf("pid" to input.pid, "session" to input.session,
                "parsedReportSha256" to input.reportSha256, "traceSchema" to 2,
                "baselineSourceSha256" to BASELINE_SHA256,
                "candidateSourceSha256" to candidateSource?.let { sha256(it.readBytes()) },
                "sourceIdentityScope" to "source_files_hashed; compilation_binding_requires_runner"),
            "frameAssumption" to assumption, "baselineCalibration" to calibration,
            "counterfactualRuns" to runs, "assumptions" to listOf(
                "Every recorded OFFER is fed, including originally rejected frames; missing records are never interpolated.",
                "Frame format/size is an explicit uniform I420 assumption; queue ratios do not measure individual input buffers.",
                "Constructor clock bridge uses the first observed nano/uptime pair, sampled simultaneously in the model with width zero.",
                "OFFER clocks precede policy entry; WORKER clocks precede policy-lock wait. Their exact serialized policy order is unavailable.",
                "Calibration compares recorded requested deadlines and SUBMIT IDs under nano/row-index order; no fitting repairs mismatches.",
                "Candidate dispatch is counterfactual: ceil-to-ms plus zero, preceding-wall-time observed extra dispatch delay, or maximum observed extra delay.",
                "Both equal-millisecond offer/worker orders are tested; callback execution and policy-lock wait have zero modeled duration.",
                "The model starts empty at the first OFFER; earlier track-binding resets and actual constructor bridge time are unavailable.",
                "Cutoff is the last recorded event uptime, not an invented close timestamp. Pending tail is reported, then explicitly released by model close.",
                "SDK intervals may vary; output is not graded against an invented fixed FPS. Input effects of changed CPU/backpressure require TV measurement."))
    }
}

fun main(args: Array<String>) {
    try {
        val flags = linkedMapOf<String, String>()
        var infer = false; var index = 0
        while (index < args.size) {
            val key = args[index++]
            if (key == "--assume-uniform-i420-from-queue") { require(!infer); infer = true; continue }
            require(key in listOf("--input", "--baseline-source", "--candidate-source", "--output", "--pid", "--session", "--assume-uniform-i420-bytes") && index < args.size && key !in flags) { "Invalid or duplicate replay argument: $key" }
            flags[key] = args[index++]
        }
        val source = File(flags["--baseline-source"] ?: error("--baseline-source is required"))
        require(NativePacerTraceReplay.sha256(source.readBytes()) == NativePacerTraceReplay.BASELINE_SHA256) { "Expected preserved .5.15 source hash" }
        val file = File(flags["--input"] ?: error("--input is required"))
        require(file.length() in 1..32L * 1024 * 1024) { "Invalid parsed report size" }
        require(infer xor ("--assume-uniform-i420-bytes" in flags)) { "Choose exactly one explicit frame assumption" }
        val input = NativePacerTraceReplay.load(file.readText(Charsets.UTF_8), flags["--pid"]?.toInt(), flags["--session"]?.toLong())
        val assumption = NativePacerTraceReplay.assumeUniform(input, flags["--assume-uniform-i420-bytes"]?.toLong())
        val report = NativePacerTraceReplay.report(input, assumption, flags["--candidate-source"]?.let(::File))
        val text = GsonBuilder().setPrettyPrinting().serializeNulls().create().toJson(report) + "\n"
        flags["--output"]?.let { File(it).writeText(text, Charsets.UTF_8) } ?: print(text)
    } catch (error: Exception) {
        System.err.println("Offline replay rejected: ${error.message}")
        exitProcess(2)
    }
}
