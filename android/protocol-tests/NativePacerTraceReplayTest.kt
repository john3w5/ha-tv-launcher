package org.hometv.launcher

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

private fun replayFixture(phaseNs: Long = 0, steps: List<Long> = List(8) { it * 70_000_000L }): JsonObject {
    val nanoBase = 10_000_000_000L
    val uptimeBase = 7_000_000_000L
    val columns = NativePacerTimingTrace.COLUMNS.split(',')
    val events = ArrayList<LongArray>()
    for ((index, at) in steps.withIndex()) {
        val sdk = nanoBase + at + if (index == 0) 0 else phaseNs
        events.add(longArrayOf(1, index + 1L, sdk, nanoBase + at, uptimeBase + at,
            Long.MIN_VALUE, 1, 3_110_400, 500, 500, 0, index + 1L, 0, 0, 0, 1, 0, 0, 0, 1))
        val due = uptimeBase + 500_000_000L + at + if (index == 0) 0 else phaseNs
        events.add(longArrayOf(3, 0, 0, nanoBase + due - uptimeBase, due, due,
            1, 3_110_400, 0, 0, 0, steps.size.toLong(), index.toLong(), 0, 0, 1, 0, 0, 0, -1))
        events.add(longArrayOf(2, index + 1L, sdk, nanoBase + due - uptimeBase, due,
            Long.MIN_VALUE, 0, 0, 0, 0, 0, steps.size.toLong(), index.toLong(), 0, 0, 1, 0, 0, 0, 1))
    }
    events.sortWith(compareBy<LongArray> { it[3] }.thenBy { if (it[0] == 1L) 0 else if (it[0] == 3L) 1 else 2 })
    val rows = JsonArray()
    events.forEachIndexed { index, values ->
        rows.add(JsonObject().apply {
            addProperty("rowIndex", index)
            columns.forEachIndexed { column, name -> addProperty(name, values[column]) }
        })
    }
    val session = JsonObject().apply {
        addProperty("pid", 42); addProperty("session", 7); addProperty("complete", true)
        add("issues", JsonArray()); addProperty("decodedRowCount", events.size)
        add("begin", JsonObject().apply {
            addProperty("schema", 2); add("columns", JsonArray().apply { columns.forEach(::add) })
        })
        add("end", JsonObject().apply {
            addProperty("rows", events.size); addProperty("lostRows", 0)
            addProperty("emitErrors", 0); addProperty("pendingObservations", 0)
        })
        add("rows", rows)
    }
    return JsonObject().apply {
        addProperty("complete", true); add("unassignedRecords", JsonArray())
        add("sessions", JsonArray().apply { add(session) })
    }
}

fun main() {
    var checks = 0
    fun expect(value: Boolean) { check(value) { "Replay invariant failed at assertion ${checks + 1}" }; checks++ }
    fun rejected(mutator: (JsonObject) -> Unit) {
        val report = replayFixture(); mutator(report)
        var refused = false
        try { NativePacerTraceReplay.load(report.toString()) } catch (_: Exception) { refused = true }
        expect(refused)
    }
    fun session(report: JsonObject) = report.getAsJsonArray("sessions")[0].asJsonObject
    rejected { it.addProperty("complete", false) }
    rejected { session(it).getAsJsonObject("begin").addProperty("schema", 1) }
    for (field in listOf("lostRows", "emitErrors", "pendingObservations"))
        rejected { session(it).getAsJsonObject("end").addProperty(field, 1) }
    rejected { session(it).getAsJsonObject("end").remove("pendingObservations") }
    rejected { session(it).getAsJsonArray("rows").remove(0) }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("sdkNs", 1.25) }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("sdkNs", "123") }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("seq", 99) }
    rejected { session(it).getAsJsonArray("rows").first { row -> row.asJsonObject["event"].asLong == 2L }.asJsonObject.addProperty("sdkNs", 123) }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("bypassed", 1) }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("renderErrors", 1) }
    rejected { session(it).getAsJsonArray("rows")[0].asJsonObject.addProperty("resets", 2) }

    val input = NativePacerTraceReplay.load(replayFixture().toString())
    val assumption = NativePacerTraceReplay.assumeUniform(input)
    expect(assumption.frameBytes == 3_110_400L && assumption.evidence.contains("assumption"))
    val calibration = NativePacerTraceReplay.calibrate(input, assumption)
    expect(calibration.matchesRecordedDeadlinesAndSubmitIds)
    expect(calibration.run.submittedIds == (1L..8L).toList())
    expect(calibration.run.conservationHolds && calibration.run.allReferencesReleasedAfterClose)
    for (profile in listOf("round_only", "observed_time_profile", "max_observed")) {
        for (order in listOf("worker_first", "offer_first")) {
            for (engine in listOf("preserved_0.5.15", "absolute_candidate")) {
                val run = NativePacerTraceReplay.simulate(input, assumption, engine, profile, order)
                expect(run.submittedIds == (1L..8L).toList())
                expect(run.statsBeforeClose.overflow == 0L && run.statsBeforeClose.late == 0L)
                expect(run.allReferencesReleasedAfterClose && run.conservationHolds)
                expect(run.maxObservedQueued <= 10 && run.maxObservedQueuedBytes <= 32L * 1024 * 1024)
            }
        }
    }
    // A mismatching real dispatch deadline must be reported, not fitted away.
    run {
        val report = replayFixture()
        session(report).getAsJsonArray("rows").first { it.asJsonObject["event"].asLong == 3L }
            .asJsonObject.addProperty("dueNs", 7_499_000_000L)
        val altered = NativePacerTraceReplay.load(report.toString())
        val result = NativePacerTraceReplay.calibrate(altered, NativePacerTraceReplay.assumeUniform(altered))
        expect(!result.matchesRecordedDeadlinesAndSubmitIds && result.deadlineMismatchCount > 0)
    }
    // Delayed original worker observations stress each policy's own scheduling;
    // they do not impose the original worker count on the candidate.
    run {
        val report = replayFixture()
        for (entry in session(report).getAsJsonArray("rows")) {
            val row = entry.asJsonObject
            if (row["event"].asLong == 3L) row.addProperty("dueNs", row["dueNs"].asLong - 7_000_000)
        }
        val delayed = NativePacerTraceReplay.load(report.toString())
        val run = NativePacerTraceReplay.simulate(delayed, assumption, "absolute_candidate", "max_observed", "worker_first")
        expect(run.submittedUptimeNs.first() == input.offers.first().uptime + 507_000_000L)
        expect(run.pendingTailAtCutoff == 1 && run.flushedByModelClose == 1)
        expect(run.allReferencesReleasedAfterClose && run.conservationHolds)
    }
    // Actual SDK intervals may alternate 60/120ms. A constant-70ms expectation
    // would conceal a different playback policy rather than verify this one.
    run {
        val steps = listOf(0L, 60L, 180L, 240L, 360L, 420L, 540L, 600L).map { it * 1_000_000L }
        val variable = NativePacerTraceReplay.load(replayFixture(steps = steps).toString())
        val run = NativePacerTraceReplay.simulate(variable, assumption, "absolute_candidate", "round_only", "worker_first")
        expect(run.submittedIds == (1L..8L).toList())
        expect(run.outputGapNs["p50Ns"] == 60_000_000L && run.outputGapNs["maxNs"] == 120_000_000L)
        expect(run.outputGapMinusSdkIntervalNs["minNs"] == 0L && run.outputGapMinusSdkIntervalNs["maxNs"] == 0L)
    }
    // Parsing exact clocks above 2^53 cannot go through a Double conversion.
    run {
        val report = replayFixture()
        val shift = 9_007_199_254_740_993L
        for (entry in session(report).getAsJsonArray("rows")) {
            val row = entry.asJsonObject
            for (field in listOf("sdkNs", "nanoNs", "uptimeNs", "dueNs")) {
                if (row[field].asLong != Long.MIN_VALUE && (field != "sdkNs" || row["event"].asLong != 3L))
                    row.addProperty(field, row[field].asLong + shift)
            }
        }
        val large = NativePacerTraceReplay.load(report.toString())
        expect(large.offers.first().nano == 10_000_000_000L + shift)
        expect(large.offers.first().sdk == 10_000_000_000L + shift)
    }
    val rendered = com.google.gson.GsonBuilder().serializeNulls().create().toJson(NativePacerTraceReplay.report(input, assumption))
    val result = JsonParser.parseString(rendered).asJsonObject
    expect(result["proofScope"].asString.contains("counterfactual"))
    expect(result.getAsJsonObject("sourceProof")["candidateSourceSha256"].isJsonNull)
    expect(result.getAsJsonArray("counterfactualRuns").size() == 12)
    println("NativePacerTraceReplayTest: $checks assertions PASS (synthetic loader/model tests; no TV replay)")
}
