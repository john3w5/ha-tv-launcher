#!/usr/bin/env python3
"""Parse an after-close HomeTVPacerTrace export without contacting the TV.

Input is ordinary logcat text or the existing JSONL {"line": "..."} wrapper.
All clocks, differences and percentiles remain integers. Half-nanosecond medians
use an exact decimal string. Exit 2 means the export is incomplete or invalid;
the JSON report is still written. No native rendering or screen proof is implied.
Schema 2 requires END pendingObservations=0 for completeness. Schema 1 exports
remain readable, but their observation boundary is unknown and always incomplete.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys


TAG = "HomeTVPacerTrace"
COLUMNS = (
    "event", "seq", "sdkNs", "nanoNs", "uptimeNs", "dueNs", "queued",
    "queuedBytes", "headAheadMs", "tailAheadMs", "correctionMs", "offered",
    "submitted", "overflow", "late", "resets", "bypassed", "renderErrors",
    "callbackNs", "retained",
)
LONG_MIN = -(1 << 63)
LONG_MAX = (1 << 63) - 1
MAX_BATCH_ROWS = 8
MAX_SESSION_ROWS = 6144
SUPPORTED_SCHEMAS = (1, 2)
STAGES = {"pacer_trace_begin", "pacer_trace_data", "pacer_trace_end"}
INTEGER = re.compile(r"-?\d+\Z")
FIELD = re.compile(r"\b([A-Za-z][A-Za-z0-9_]*)=([^\s]*)")
THREAD_PREFIX = re.compile(r"\b(\d+)\s+\d+\s+[VDIWEFAS]\s+" + TAG + r"\s*:\s*(.*)$")
BRIEF_PREFIX = re.compile(r"[VDIWEFAS]/" + TAG + r"\(\s*(\d+)\s*\)\s*:\s*(.*)$")
TAG_PREFIX = re.compile(r"(?:^|[\s/])" + TAG + r"\s*:\s*(.*)$")


def _integer(value, minimum=LONG_MIN, maximum=LONG_MAX):
    if not isinstance(value, str) or not INTEGER.fullmatch(value):
        raise ValueError("expected_integer")
    parsed = int(value)
    if not minimum <= parsed <= maximum:
        raise ValueError("integer_out_of_range")
    return parsed


def _median(values):
    """Return the exact median, without converting a clock to a float."""
    middle = len(values) // 2
    if len(values) % 2:
        return values[middle]
    total = values[middle - 1] + values[middle]
    if total % 2 == 0:
        return total // 2
    return ("-" if total < 0 else "") + str(abs(total) // 2) + ".5"


def distribution(values):
    values = sorted(values)
    if not values:
        return {"count": 0, "minNs": None, "medianNs": None,
                "p05Ns": None, "p50Ns": None, "p95Ns": None,
                "p99Ns": None, "maxNs": None}

    def percentile(percent):
        # Nearest rank: ceil(N * percent / 100), with no float arithmetic.
        return values[max(0, (len(values) * percent + 99) // 100 - 1)]

    return {"count": len(values), "minNs": values[0],
            "medianNs": _median(values), "p05Ns": percentile(5),
            "p50Ns": percentile(50), "p95Ns": percentile(95),
            "p99Ns": percentile(99), "maxNs": values[-1]}


def _window(offers, first):
    uptime_offers = [row for row in offers if row["uptimeNs"] >= 0]
    relative_uptime_offers = uptime_offers if first["uptimeNs"] >= 0 else []
    return {
        "offerCount": len(offers),
        "firstSeq": offers[0]["seq"] if offers else None,
        "lastSeq": offers[-1]["seq"] if offers else None,
        "sdkMinusNanoNs": distribution(row["sdkNs"] - row["nanoNs"] for row in offers),
        "sdkMinusUptimeNs": distribution(row["sdkNs"] - row["uptimeNs"] for row in uptime_offers),
        "nanoMinusUptimeNs": distribution(row["nanoNs"] - row["uptimeNs"] for row in uptime_offers),
        "relativePhaseNanoNs": distribution(
            (row["sdkNs"] - first["sdkNs"]) - (row["nanoNs"] - first["nanoNs"])
            for row in offers),
        "relativePhaseUptimeNs": distribution(
            (row["sdkNs"] - first["sdkNs"]) - (row["uptimeNs"] - first["uptimeNs"])
            for row in relative_uptime_offers),
    }


def analyze_rows(rows):
    """Describe observed numeric rows; completeness is checked separately."""
    # OFFER is recorded after queue.offer returns, while its clocks were sampled
    # before that call. A worker can record SUBMIT first; export order is not
    # the input timeline. Input sequence is assigned before the offer call.
    offers = sorted((row for row in rows if row["event"] == 1), key=lambda row: row["seq"])
    submits = [row for row in rows if row["event"] == 2]
    workers = [row for row in rows if row["event"] == 3]
    offers_by_seq = {row["seq"]: row for row in offers}
    matched_submits = [(offers_by_seq[row["seq"]], row) for row in submits if row["seq"] in offers_by_seq]
    first = offers[0] if offers else None
    jumps = []
    clock_reversals = []
    for previous, current in zip(offers, offers[1:]):
        sdk_delta = current["sdkNs"] - previous["sdkNs"]
        nano_delta = current["nanoNs"] - previous["nanoNs"]
        uptime_delta = current["uptimeNs"] - previous["uptimeNs"]
        uptime_available = previous["uptimeNs"] >= 0 and current["uptimeNs"] >= 0
        jumps.append({"previousSeq": previous["seq"], "seq": current["seq"],
                      "sdkDeltaNs": sdk_delta, "nanoArrivalDeltaNs": nano_delta,
                      "uptimeArrivalDeltaNs": uptime_delta if uptime_available else None,
                      "sdkDeltaMinusNanoArrivalNs": sdk_delta - nano_delta,
                      "sdkDeltaMinusUptimeArrivalNs": sdk_delta - uptime_delta if uptime_available else None})
        if nano_delta < 0 or uptime_available and uptime_delta < 0:
            clock_reversals.append(current["seq"])
    scheduled_workers = [row for row in workers if row["dueNs"] != LONG_MIN and row["uptimeNs"] >= 0]
    lateness = [{"rowIndex": row["rowIndex"], "uptimeNs": row["uptimeNs"],
                 "dueNs": row["dueNs"], "latenessNs": row["uptimeNs"] - row["dueNs"]}
                for row in scheduled_workers]
    first_offer = dict(first) if first else None
    if first_offer is not None:
        first_offer["sdkMinusNanoNs"] = first["sdkNs"] - first["nanoNs"]
        first_offer["sdkMinusUptimeNs"] = first["sdkNs"] - first["uptimeNs"] if first["uptimeNs"] >= 0 else None
    return {
        "available": bool(offers),
        "reason": None if offers else "no_offer_rows",
        "summaryScope": "descriptive_numeric_rows_only",
        "firstOffer": first_offer,
        "allOffers": _window(offers, first) if first else None,
        "earlyFirst8Offers": _window(offers[:8], first) if first else None,
        "steadyAfter15s": _window(
            [row for row in offers if row["nanoNs"] - first["nanoNs"] >= 15_000_000_000], first)
            if first else None,
        "jumps": {
            "consecutiveOfferCount": len(jumps),
            "sdkDeltaMinusNanoArrivalNs": distribution(jump["sdkDeltaMinusNanoArrivalNs"] for jump in jumps),
            "sdkDeltaMinusUptimeArrivalNs": distribution(jump["sdkDeltaMinusUptimeArrivalNs"] for jump in jumps
                                                        if jump["sdkDeltaMinusUptimeArrivalNs"] is not None),
            "largestAbsoluteNanoJumps": sorted(
                jumps, key=lambda jump: abs(jump["sdkDeltaMinusNanoArrivalNs"]), reverse=True)[:8],
            "arrivalClockReversalSeqs": clock_reversals,
        },
        "worker": {
            "count": len(workers), "scheduledDeadlineCount": len(scheduled_workers),
            "latenessVsUptimeNs": distribution(row["latenessNs"] for row in lateness),
            "earlyCount": sum(row["latenessNs"] < 0 for row in lateness),
            "onTimeCount": sum(row["latenessNs"] == 0 for row in lateness),
            "lateCount": sum(row["latenessNs"] > 0 for row in lateness),
            "largestLateness": sorted(lateness, key=lambda row: row["latenessNs"], reverse=True)[:8],
        },
        "submit": {
            "count": len(submits),
            "callbackErrors": sum(row["retained"] == -2 for row in submits),
            "callbackDurationNs": distribution(row["callbackNs"] for row in submits if row["callbackNs"] >= 0),
            "sdkMinusNanoNs": distribution(row["sdkNs"] - row["nanoNs"] for row in submits),
            "sdkMinusUptimeNs": distribution(row["sdkNs"] - row["uptimeNs"] for row in submits if row["uptimeNs"] >= 0),
            "matchedOfferCount": len(matched_submits),
            "unmatchedSubmitSeqs": [row["seq"] for row in submits if row["seq"] not in offers_by_seq],
            "sdkTimestampMismatchSeqs": [submit["seq"] for offer, submit in matched_submits
                                         if offer["sdkNs"] != submit["sdkNs"]],
            "offerToSubmitNanoNs": distribution(submit["nanoNs"] - offer["nanoNs"]
                                                  for offer, submit in matched_submits),
            "offerToSubmitUptimeNs": distribution(submit["uptimeNs"] - offer["uptimeNs"]
                                                    for offer, submit in matched_submits
                                                    if offer["uptimeNs"] >= 0 and submit["uptimeNs"] >= 0),
        },
        "offerOwnership": {
            "wasRetainedCount": sum(row["retained"] == 1 for row in offers),
            "neverRetainedCount": sum(row["retained"] == 0 for row in offers),
        },
    }


def _decode_line(raw):
    if raw.lstrip().startswith("{"):
        try:
            wrapped = json.loads(raw)
            raw = wrapped.get("line", "") if isinstance(wrapped, dict) else ""
        except (ValueError, TypeError):
            return None
    if not isinstance(raw, str):
        return None
    for prefix in (THREAD_PREFIX, BRIEF_PREFIX):
        match = prefix.search(raw)
        if match:
            return int(match.group(1)), match.group(2)
    match = TAG_PREFIX.search(raw)
    return (None, match.group(1)) if match else None


def parse_lines(lines, include_rows=False):
    sessions = []
    current = {}
    occurrences = {}
    unassigned = []
    ignored = 0

    def issue(session, code, line=None, **details):
        if code not in session["issues"]:
            session["issues"].append(code)
        session["issueDetails"].append({"code": code, **({"line": line} if line else {}), **details})

    def new_session(pid, number):
        key = (pid, number)
        occurrences[key] = occurrences.get(key, 0) + 1
        session = {"pid": pid, "session": number, "occurrence": occurrences[key],
                   "identityScope": "pid+session" if pid is not None else "session_only",
                   "begin": None, "end": None, "issues": [], "issueDetails": [],
                   "dataBatchCount": 0, "declaredRowsInData": 0,
                   "expectedNextOffset": 0, "discardedExcessRows": 0, "_rows": []}
        sessions.append(session)
        current[key] = session
        return session

    for line_number, raw in enumerate(lines, 1):
        decoded = _decode_line(raw)
        if decoded is None:
            ignored += 1
            continue
        pid, payload = decoded
        pairs = FIELD.findall(payload)
        fields = dict(pairs)
        stage = fields.get("stage")
        if stage not in STAGES:
            ignored += 1
            continue
        try:
            number = _integer(fields.get("session"), minimum=0)
        except ValueError:
            unassigned.append({"line": line_number, "code": "invalid_or_missing_session"})
            continue
        key = (pid, number)
        previous = current.get(key)
        if stage == "pacer_trace_begin":
            session = new_session(pid, number)
            if previous is not None:
                issue(previous, "duplicate_begin_identity", line_number)
                issue(session, "duplicate_begin_identity", line_number)
        else:
            session = previous or new_session(pid, number)
        names = [name for name, _ in pairs]
        if len(names) != len(set(names)):
            issue(session, "duplicate_field", line_number)
        if stage == "pacer_trace_begin":
            try:
                schema = _integer(fields.get("schema"), minimum=0)
            except ValueError:
                schema = None
            columns = fields.get("columns", "").split(",")
            session["begin"] = {"line": line_number, "schema": schema, "columns": columns}
            if schema not in SUPPORTED_SCHEMAS:
                issue(session, "unsupported_or_missing_schema", line_number)
            if tuple(columns) != COLUMNS:
                issue(session, "columns_mismatch", line_number)
            continue
        if session["end"] is not None:
            issue(session, "record_after_end", line_number)
        if stage == "pacer_trace_end":
            if session["end"] is not None:
                issue(session, "duplicate_end", line_number)
                continue
            end = {"line": line_number}
            for name in ("rows", "lostRows", "emitErrors"):
                try:
                    end[name] = _integer(fields.get(name), minimum=0)
                except ValueError:
                    end[name] = None
                    issue(session, "invalid_end_" + name, line_number)
            end["pendingObservations"] = None
            if "pendingObservations" in fields:
                try:
                    end["pendingObservations"] = _integer(fields["pendingObservations"], minimum=0)
                except ValueError:
                    issue(session, "invalid_end_pendingObservations", line_number)
            session["end"] = end
            continue
        session["dataBatchCount"] += 1
        try:
            offset = _integer(fields.get("offset"), minimum=0)
            declared = _integer(fields.get("rows"), minimum=1)
        except ValueError:
            issue(session, "invalid_data_offset_or_rows", line_number)
            continue
        if offset != session["expectedNextOffset"]:
            issue(session, "noncontiguous_offset", line_number,
                  expected=session["expectedNextOffset"], observed=offset)
        session["expectedNextOffset"] = offset + declared
        session["declaredRowsInData"] += declared
        batches = fields.get("data", "").split(";")
        if declared > MAX_BATCH_ROWS or len(batches) > MAX_BATCH_ROWS:
            issue(session, "data_batch_limit_exceeded", line_number)
        if offset + declared > MAX_SESSION_ROWS or session["declaredRowsInData"] > MAX_SESSION_ROWS:
            if "session_row_limit_exceeded" not in session["issues"]:
                issue(session, "session_row_limit_exceeded", line_number)
        if len(batches) != declared:
            issue(session, "data_row_count_mismatch", line_number,
                  declared=declared, observed=len(batches))
        for index, encoded in enumerate(batches):
            values = encoded.split(",")
            if len(values) != len(COLUMNS):
                issue(session, "row_column_count_mismatch", line_number, rowIndex=offset + index)
                continue
            try:
                values = [_integer(value) for value in values]
            except ValueError:
                issue(session, "invalid_row_integer", line_number, rowIndex=offset + index)
                continue
            row = dict(zip(COLUMNS, values))
            event = row["event"]
            valid_shape = ((event == 1 and row["seq"] > 0 and row["retained"] in (0, 1)) or
                           (event == 2 and row["seq"] > 0 and row["retained"] in (1, -2)) or
                           (event == 3 and row["seq"] == 0 and row["retained"] == -1))
            if not valid_shape:
                issue(session, "invalid_event_shape", line_number, rowIndex=offset + index)
            if len(session["_rows"]) >= MAX_SESSION_ROWS:
                session["discardedExcessRows"] += 1
                if "session_row_limit_exceeded" not in session["issues"]:
                    issue(session, "session_row_limit_exceeded", line_number)
                continue
            row.update(rowIndex=offset + index, sourceLine=line_number)
            session["_rows"].append(row)

    for session in sessions:
        header = session["begin"]
        if header and header["schema"] == 1:
            issue(session, "missing_observation_boundary")
        if session["begin"] is None:
            issue(session, "missing_begin")
        if session["end"] is None:
            issue(session, "missing_end")
        else:
            end = session["end"]
            if end["rows"] is not None and (end["rows"] != len(session["_rows"]) or
                                           end["rows"] != session["expectedNextOffset"] or
                                           end["rows"] != session["declaredRowsInData"]):
                issue(session, "end_row_count_mismatch")
            if end["lostRows"]:
                issue(session, "producer_lost_rows")
            if end["emitErrors"]:
                issue(session, "producer_emit_errors")
            if end["pendingObservations"]:
                issue(session, "producer_pending_observations")
            if header and header["schema"] == 2 and end["pendingObservations"] is None and \
                    "invalid_end_pendingObservations" not in session["issues"]:
                issue(session, "missing_observation_boundary")
        session["decodedRowCount"] = len(session["_rows"])
        offer_sequences = [row["seq"] for row in session["_rows"] if row["event"] == 1]
        if len(offer_sequences) != len(set(offer_sequences)):
            issue(session, "duplicate_offer_seq")
        session["complete"] = not session["issues"]
        incomplete_codes = {"missing_begin", "missing_end", "producer_lost_rows", "producer_emit_errors",
                            "missing_observation_boundary", "producer_pending_observations"}
        session["status"] = ("complete" if session["complete"] else
                             "incomplete" if set(session["issues"]) <= incomplete_codes else "invalid")
        supported = header and header["schema"] in SUPPORTED_SCHEMAS and tuple(header["columns"]) == COLUMNS
        session["analysis"] = analyze_rows(session["_rows"]) if supported else {
            "available": False, "reason": "missing_or_unsupported_header"}
        session["analysis"]["observedRowsOnly"] = not session["complete"]
        if include_rows:
            session["rows"] = session["_rows"]
        del session["_rows"]
    return {
        "schemaVersion": 1,
        "complete": bool(sessions) and all(session["complete"] for session in sessions) and not unassigned,
        "sessions": sessions, "unassignedRecords": unassigned, "ignoredLineCount": ignored,
        "statistics": {"percentiles": "nearest_rank", "medianEncoding": "integer_or_exact_decimal_string",
                       "steadyThresholdNs": 15_000_000_000},
        "limits": [
            "Trace completeness describes the supplied export; missing whole sessions cannot be detected.",
            "Sessions without a logcat PID cannot establish process identity.",
            "Incomplete or invalid exports have observed-row summaries only.",
            "Relative phase is (SDK - first SDK) - (arrival - first arrival), not absolute clock lead.",
            "Unknown policy values may be -1; policy snapshots are not atomic per-frame decisions.",
            "Unknown negative uptime values are omitted from uptime-derived clock statistics.",
            "Producer limits are 8 rows per batch and 6144 rows per session; excess storage is discarded and invalidates completeness.",
            "Schema 2 requires a valid END pendingObservations=0; nonzero pending observations make matching row counts incomplete.",
            "Schema 1 observation boundaries are unknown; these exports are always incomplete descriptive evidence.",
            "retained on offer means retained at least once, not still held at observation time.",
            "OFFER clocks precede queue.offer; OFFER records may follow SUBMIT records. Input analysis uses sequence order.",
            "Offer-to-submit timing joins input sequence IDs; unknown or mismatched IDs are reported without assuming export-order latency.",
            "Worker lateness is dispatch uptime minus the unrounded requested deadline; subsequent policy-lock wait is not captured.",
            "Handler rounds requested deadlines up to milliseconds.",
            "Submission/callback timing does not prove native renderer completion or physical display scanout.",
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Saved logcat text or JSONL; never fetched from a device")
    parser.add_argument("--output", type=Path, help="Write JSON here instead of stdout")
    parser.add_argument("--include-rows", action="store_true", help="Include every decoded row with exact integer values")
    args = parser.parse_args(argv)
    try:
        with args.input.open(encoding="utf-8", errors="replace") as source:
            result = parse_lines(source, include_rows=args.include_rows)
        rendered = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        if args.output:
            args.output.write_text(rendered, encoding="utf-8")
        else:
            sys.stdout.write(rendered)
    except OSError as error:
        parser.exit(1, "Cannot read/write offline trace: {}\n".format(error))
    return 0 if result["complete"] else 2


if __name__ == "__main__":
    sys.exit(main())
