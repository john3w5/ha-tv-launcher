import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("native_pacer_trace", ROOT / "scripts/parse-native-pacer-trace.py")
TRACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRACE)


def log(payload, pid=100, style="epoch"):
    if style == "brief":
        return f"D/HomeTVPacerTrace( {pid}): {payload}"
    if style == "tag":
        return f"D/HomeTVPacerTrace: {payload}"
    if style == "threadtime":
        return f"10-25 16:30:00.100 {pid} 201 D HomeTVPacerTrace: {payload}"
    return f"1792942000.123 {pid} 201 D HomeTVPacerTrace: {payload}"


def row(event=1, seq=1, **changes):
    value = dict(zip(TRACE.COLUMNS, [
        event, seq, 9_000_000_000, 9_000_000_000, 9_000_000_000,
        TRACE.LONG_MIN, 1, 3_110_400, 500, 500, 0, seq, 0, 0, 0, 0, 0, 0,
        -1, 1 if event in (1, 2) else -1,
    ]))
    if event == 3:
        value.update(seq=0, dueNs=8_999_500_001)
    if event == 2:
        value["callbackNs"] = 1234
    value.update(changes)
    return value


def begin(session=1, pid=100, schema=2, columns=TRACE.COLUMNS, style="epoch"):
    return log(f"stage=pacer_trace_begin session={session} schema={schema} columns={','.join(columns)}", pid, style)


def data(rows, session=1, pid=100, offset=0, declared=None, style="epoch"):
    encoded = ";".join(",".join(str(value[column]) for column in TRACE.COLUMNS) for value in rows)
    return log(f"stage=pacer_trace_data session={session} offset={offset} rows={len(rows) if declared is None else declared} data={encoded}", pid, style)


def end(count, session=1, pid=100, lost=0, errors=0, style="epoch", pending=0):
    boundary = "" if pending is None else f" pendingObservations={pending}"
    return log(f"stage=pacer_trace_end session={session} rows={count} lostRows={lost} emitErrors={errors}{boundary}", pid, style)


def parse(rows, **options):
    batches = [data(rows[offset:offset + 8], offset=offset) for offset in range(0, len(rows), 8)]
    return TRACE.parse_lines([begin(), *batches, end(len(rows))], **options)


class NativePacerTraceTest(unittest.TestCase):
    def test_complete_trace_keeps_large_timestamps_exact(self):
        stamp = (1 << 62) + 123
        original = row(sdkNs=stamp - 23, nanoNs=stamp, uptimeNs=stamp - 7)
        result = parse([original], include_rows=True)
        self.assertTrue(result["complete"])
        session = result["sessions"][0]
        self.assertEqual(session["pid"], 100)
        self.assertEqual(session["status"], "complete")
        self.assertEqual(session["rows"][0]["nanoNs"], stamp)
        self.assertEqual(session["analysis"]["firstOffer"]["sdkMinusNanoNs"], -23)
        self.assertEqual(session["analysis"]["firstOffer"]["sdkMinusUptimeNs"], -16)
        decoded = json.loads(json.dumps(result, allow_nan=False))
        self.assertEqual(decoded["sessions"][0]["rows"][0]["sdkNs"], stamp - 23)

    def test_missing_end_is_incomplete_even_with_all_data(self):
        result = TRACE.parse_lines([begin(), data([row()])])
        session = result["sessions"][0]
        self.assertFalse(result["complete"])
        self.assertEqual(session["status"], "incomplete")
        self.assertIn("missing_end", session["issues"])
        self.assertTrue(session["analysis"]["observedRowsOnly"])

    def test_lost_middle_batch_cannot_be_hidden_by_matching_end(self):
        result = TRACE.parse_lines([begin(), data([row(seq=1)]),
                                    data([row(seq=3)], offset=2), end(3)])
        session = result["sessions"][0]
        self.assertFalse(result["complete"])
        self.assertIn("noncontiguous_offset", session["issues"])
        self.assertIn("end_row_count_mismatch", session["issues"])

    def test_truncated_data_row_is_not_accepted_as_complete(self):
        broken = data([row()]).rsplit(",", 1)[0]
        result = TRACE.parse_lines([begin(), broken, end(1)])
        session = result["sessions"][0]
        self.assertFalse(result["complete"])
        self.assertEqual(session["decodedRowCount"], 0)
        self.assertIn("row_column_count_mismatch", session["issues"])
        self.assertIn("end_row_count_mismatch", session["issues"])

    def test_producer_loss_and_emit_errors_keep_observed_summary_partial(self):
        result = TRACE.parse_lines([begin(), data([row()]), end(1, lost=7, errors=2)])
        session = result["sessions"][0]
        self.assertFalse(session["complete"])
        self.assertEqual(session["end"]["lostRows"], 7)
        self.assertIn("producer_lost_rows", session["issues"])
        self.assertIn("producer_emit_errors", session["issues"])
        self.assertTrue(session["analysis"]["available"])
        self.assertTrue(session["analysis"]["observedRowsOnly"])

    def test_schema_and_column_order_are_checked_before_analysis(self):
        for header, issue in [(begin(schema=3), "unsupported_or_missing_schema"),
                              (begin(columns=tuple(reversed(TRACE.COLUMNS))), "columns_mismatch")]:
            with self.subTest(issue=issue):
                result = TRACE.parse_lines([header, data([row()]), end(1)])
                session = result["sessions"][0]
                self.assertFalse(result["complete"])
                self.assertIn(issue, session["issues"])
                self.assertFalse(session["analysis"]["available"])

    def test_batch_count_overlap_and_invalid_integer_are_detected(self):
        cases = [
            ([begin(), data([row()], declared=2), end(1)], "data_row_count_mismatch"),
            ([begin(), data([row()]), data([row(seq=2)], offset=0), end(2)], "noncontiguous_offset"),
            ([begin(), data([row()]).replace("9000000000", "9.0", 1), end(1)], "invalid_row_integer"),
            ([begin(), data([row(nanoNs=1 << 63)]), end(1)], "invalid_row_integer"),
        ]
        for lines, issue in cases:
            with self.subTest(issue=issue):
                result = TRACE.parse_lines(lines)
                self.assertFalse(result["complete"])
                self.assertIn(issue, result["sessions"][0]["issues"])

    def test_session_identity_includes_pid_and_duplicate_begin_is_explicit(self):
        lines = [begin(pid=100), begin(pid=200), data([row()], pid=100),
                 data([row()], pid=200), end(1, pid=100), end(1, pid=200)]
        result = TRACE.parse_lines(lines)
        self.assertTrue(result["complete"])
        self.assertEqual([session["pid"] for session in result["sessions"]], [100, 200])
        duplicated = TRACE.parse_lines(lines + [begin(pid=100), data([row()], pid=100), end(1, pid=100)])
        same_pid = [session for session in duplicated["sessions"] if session["pid"] == 100]
        self.assertEqual([session["occurrence"] for session in same_pid], [1, 2])
        self.assertFalse(duplicated["complete"])
        self.assertTrue(all(session["status"] == "invalid" for session in same_pid))
        self.assertTrue(all("duplicate_begin_identity" in session["issues"] for session in same_pid))

    def test_missing_begin_and_records_after_end_are_visible(self):
        missing = TRACE.parse_lines([data([row()]), end(1)])
        self.assertFalse(missing["complete"])
        self.assertIn("missing_begin", missing["sessions"][0]["issues"])
        self.assertFalse(missing["sessions"][0]["analysis"]["available"])
        after = TRACE.parse_lines([begin(), data([row()]), end(1), data([row(seq=2)], offset=1)])
        self.assertFalse(after["complete"])
        self.assertIn("record_after_end", after["sessions"][0]["issues"])

    def test_first_late_frame_explains_positive_relative_phase(self):
        origin = (1 << 60) + 123
        offers = []
        for index in range(18):
            arrival = origin + index * 1_000_000_000
            sdk = arrival - 960_000_000 if index == 0 else arrival
            offers.append(row(seq=index + 1, sdkNs=sdk, nanoNs=arrival, uptimeNs=arrival - 123))
        analysis = parse(offers)["sessions"][0]["analysis"]
        self.assertEqual(analysis["firstOffer"]["sdkMinusNanoNs"], -960_000_000)
        self.assertEqual(analysis["earlyFirst8Offers"]["offerCount"], 8)
        self.assertEqual(analysis["steadyAfter15s"]["offerCount"], 3)
        self.assertEqual(analysis["steadyAfter15s"]["sdkMinusNanoNs"]["medianNs"], 0)
        self.assertEqual(analysis["steadyAfter15s"]["sdkMinusUptimeNs"]["medianNs"], 123)
        self.assertEqual(analysis["steadyAfter15s"]["relativePhaseNanoNs"]["medianNs"], 960_000_000)
        jump = analysis["jumps"]["largestAbsoluteNanoJumps"][0]
        self.assertEqual((jump["previousSeq"], jump["seq"]), (1, 2))
        self.assertEqual(jump["sdkDeltaMinusNanoArrivalNs"], 960_000_000)

    def test_offer_timeline_uses_sequence_not_export_order(self):
        first = row(seq=1, sdkNs=8_040_000_000, nanoNs=9_000_000_000, uptimeNs=9_000_000_000)
        second = row(seq=2, sdkNs=10_000_000_000, nanoNs=10_000_000_000, uptimeNs=10_000_000_000)
        submitted = row(event=2, seq=1, sdkNs=first["sdkNs"], nanoNs=9_500_000_000, uptimeNs=9_500_000_000)
        result = parse([submitted, second, first])
        self.assertTrue(result["complete"])
        analysis = result["sessions"][0]["analysis"]
        self.assertEqual(analysis["firstOffer"]["seq"], 1)
        self.assertEqual(analysis["jumps"]["largestAbsoluteNanoJumps"][0]["seq"], 2)
        self.assertEqual(analysis["submit"]["offerToSubmitNanoNs"]["medianNs"], 500_000_000)
        self.assertEqual(analysis["submit"]["sdkMinusNanoNs"]["medianNs"], -1_460_000_000)
        self.assertEqual(analysis["submit"]["sdkTimestampMismatchSeqs"], [])
        duplicate = parse([first, first])
        self.assertFalse(duplicate["complete"])
        self.assertIn("duplicate_offer_seq", duplicate["sessions"][0]["issues"])

    def test_worker_dispatch_lateness_uses_uptime_and_unrounded_due(self):
        workers = [row(event=3, dueNs=10_000_000_001, nanoNs=99_000_000_000, uptimeNs=10_001_000_000),
                   row(event=3, dueNs=11_000_000_000, nanoNs=99_000_000_000, uptimeNs=11_003_000_000)]
        analysis = parse(workers)["sessions"][0]["analysis"]
        self.assertEqual(analysis["worker"]["lateCount"], 2)
        self.assertEqual(analysis["worker"]["latenessVsUptimeNs"]["minNs"], 999_999)
        self.assertEqual(analysis["worker"]["latenessVsUptimeNs"]["maxNs"], 3_000_000)
        self.assertEqual(analysis["worker"]["latenessVsUptimeNs"]["medianNs"], "1999999.5")

    def test_event_shape_sentinels_callback_errors_and_unknown_snapshots(self):
        offers = row(queued=-1, queuedBytes=-1, retained=0)
        submit_error = row(event=2, retained=-2, callbackNs=500)
        worker = row(event=3)
        result = parse([offers, submit_error, worker])
        self.assertTrue(result["complete"])
        analysis = result["sessions"][0]["analysis"]
        self.assertEqual(analysis["submit"]["callbackErrors"], 1)
        self.assertEqual(analysis["offerOwnership"]["neverRetainedCount"], 1)
        self.assertFalse(parse([row(event=1, seq=0)])["complete"])
        self.assertFalse(parse([row(event=3, retained=1)])["complete"])

    def test_complete_export_without_offers_has_no_clock_origin_evidence(self):
        result = parse([row(event=3)])
        self.assertTrue(result["complete"])
        analysis = result["sessions"][0]["analysis"]
        self.assertFalse(analysis["available"])
        self.assertEqual(analysis["reason"], "no_offer_rows")
        self.assertEqual(analysis["worker"]["count"], 1)
        empty = parse([])
        self.assertTrue(empty["complete"])
        self.assertIsNone(empty["sessions"][0]["analysis"]["firstOffer"])

    def test_unknown_uptime_does_not_become_a_clock_origin(self):
        analysis = parse([row(seq=1, uptimeNs=-1), row(seq=2)])["sessions"][0]["analysis"]
        self.assertIsNone(analysis["firstOffer"]["sdkMinusUptimeNs"])
        self.assertEqual(analysis["allOffers"]["sdkMinusUptimeNs"]["count"], 1)
        self.assertEqual(analysis["allOffers"]["relativePhaseUptimeNs"]["count"], 0)
        self.assertEqual(analysis["allOffers"]["relativePhaseNanoNs"]["count"], 2)
        self.assertIsNone(analysis["jumps"]["largestAbsoluteNanoJumps"][0]["uptimeArrivalDeltaNs"])

    def test_producer_batch_and_session_limits_are_enforced(self):
        over_batch = TRACE.parse_lines([begin(), data([row(seq=index + 1) for index in range(9)]), end(9)])
        self.assertFalse(over_batch["complete"])
        self.assertIn("data_batch_limit_exceeded", over_batch["sessions"][0]["issues"])
        rows = [row(seq=index + 1) for index in range(TRACE.MAX_SESSION_ROWS + 1)]
        over_session = parse(rows)
        session = over_session["sessions"][0]
        self.assertFalse(over_session["complete"])
        self.assertIn("session_row_limit_exceeded", session["issues"])
        self.assertEqual(session["decodedRowCount"], TRACE.MAX_SESSION_ROWS)
        self.assertEqual(session["discardedExcessRows"], 1)

    def test_in_flight_last_offer_makes_matching_export_incomplete(self):
        # SUBMIT can be recorded before OFFER's finally block. Export sees one
        # complete row and matching END rows, while that final OFFER is pending.
        submitted = row(event=2, seq=1)
        result = TRACE.parse_lines([begin(), data([submitted]), end(1, pending=1)])
        session = result["sessions"][0]
        self.assertEqual(session["decodedRowCount"], session["end"]["rows"])
        self.assertEqual(session["end"]["lostRows"], 0)
        self.assertEqual(session["end"]["emitErrors"], 0)
        self.assertEqual(session["end"]["pendingObservations"], 1)
        self.assertFalse(result["complete"])
        self.assertEqual(session["status"], "incomplete")
        self.assertIn("producer_pending_observations", session["issues"])
        self.assertNotIn("end_row_count_mismatch", session["issues"])
        self.assertTrue(session["analysis"]["observedRowsOnly"])
        self.assertEqual(session["analysis"]["submit"]["unmatchedSubmitSeqs"], [1])

    def test_schema_two_missing_observation_boundary_fails_closed(self):
        result = TRACE.parse_lines([begin(), data([row()]), end(1, pending=None)])
        session = result["sessions"][0]
        self.assertFalse(result["complete"])
        self.assertIsNone(session["end"]["pendingObservations"])
        self.assertEqual(session["status"], "incomplete")
        self.assertIn("missing_observation_boundary", session["issues"])
        self.assertTrue(session["analysis"]["available"])
        self.assertTrue(session["analysis"]["observedRowsOnly"])

    def test_schema_two_invalid_observation_boundary_is_invalid(self):
        for invalid in (-1, "no", "1.0", 1 << 63):
            with self.subTest(invalid=invalid):
                result = TRACE.parse_lines([begin(), data([row()]), end(1, pending=invalid)])
                session = result["sessions"][0]
                self.assertFalse(result["complete"])
                self.assertEqual(session["status"], "invalid")
                self.assertIn("invalid_end_pendingObservations", session["issues"])
                self.assertTrue(session["analysis"]["available"])

    def test_schema_one_stays_descriptive_even_with_matching_counts_or_new_field(self):
        for pending in (None, 0):
            with self.subTest(pending=pending):
                result = TRACE.parse_lines([begin(schema=1), data([row()]), end(1, pending=pending)])
                session = result["sessions"][0]
                self.assertFalse(result["complete"])
                self.assertEqual(session["status"], "incomplete")
                self.assertIn("missing_observation_boundary", session["issues"])
                self.assertNotIn("unsupported_or_missing_schema", session["issues"])
                self.assertTrue(session["analysis"]["available"])
                self.assertTrue(session["analysis"]["observedRowsOnly"])

    def test_logcat_formats_jsonl_unknown_lines_and_empty_input(self):
        for style in ("epoch", "threadtime", "brief", "tag"):
            with self.subTest(style=style):
                lines = [begin(style=style), data([row()], style=style), end(1, style=style)]
                wrapped = [json.dumps({"line": line}) for line in lines]
                result = TRACE.parse_lines(["unrelated text", "{}", *wrapped,
                                           log("stage=unrelated session=9")])
                self.assertTrue(result["complete"])
                self.assertEqual(result["ignoredLineCount"], 3)
                self.assertEqual(result["sessions"][0]["pid"], None if style == "tag" else 100)
        self.assertFalse(TRACE.parse_lines([])["complete"])

    def test_exact_negative_half_median_and_percentiles(self):
        result = TRACE.distribution([-1, 0])
        self.assertEqual(result["medianNs"], "-0.5")
        self.assertEqual(result["p50Ns"], -1)
        self.assertEqual(result["p95Ns"], 0)

    def test_cli_writes_json_and_flags_incomplete_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "trace.log"
            destination = Path(temporary) / "report.json"
            source.write_text("\n".join([begin(), data([row()]), end(1)]), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(TRACE.main([str(source), "--output", str(destination), "--include-rows"]), 0)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(json.loads(destination.read_text())["sessions"][0]["rows"][0]["sdkNs"], 9_000_000_000)
            source.write_text(begin(), encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(TRACE.main([str(source)]), 2)
            self.assertFalse(json.loads(output.getvalue())["complete"])


if __name__ == "__main__":
    unittest.main()
