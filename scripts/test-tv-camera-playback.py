#!/usr/bin/env python3
"""Native camera QA. Default/offline parsing never contacts TV; only --run controls ADB.

Examples:
  python3 scripts/test-tv-camera-playback.py
  python3 scripts/test-tv-camera-playback.py --run --serial "$TV_SERIAL" --camera entrance --quality smooth
  python3 scripts/test-tv-camera-playback.py --parse CASE/rtc.jsonl --camera entrance --quality smooth

Metrics prove decoded-frame delivery/inbound counters, not physical screen presentation.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET

PACKAGE = "org.hometv.launcher"
COMPONENT = PACKAGE + "/.MainActivity"
CAMERAS = ("entrance", "cars", "garden", "outside")
QUALITIES = ("smooth", "hd")
TAG = "HomeTVRTC"
FIELD = re.compile(r"\b([A-Za-z][A-Za-z0-9_]*)=([^\s]+)")
NUMBER = re.compile(r"^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$")
BOUNDS = re.compile(r"^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")


def parse_line(line, received_monotonic=None):
    """Only fixed RTC stage/label/numeric fields; discard arbitrary logcat messages."""
    if not isinstance(line, str) or len(line) > 16384 or TAG not in line or "stage=" not in line:
        return None
    fields = dict(FIELD.findall(line))
    if fields.get("stage") not in {"rendering", "connected", "answer", "sample", "rtcstats", "ice", "quality"}:
        return None
    record = {key: fields[key] for key in ("stage", "camera", "quality", "mode", "next") if key in fields}
    numeric = {}
    for key, value in fields.items():
        if NUMBER.fullmatch(value):
            number = float(value)
            if math.isfinite(number):
                numeric[key] = int(number) if number.is_integer() else number
    record["values"] = numeric
    stamp = re.match(r"^\s*(\d+\.\d+)\s", line)
    record["time"] = float(received_monotonic) if received_monotonic is not None else float(stamp.group(1)) if stamp else None
    return record


def read_records(path):
    result = []
    with Path(path).open(encoding="utf-8", errors="replace") as source:
        for line in source:
            if line.startswith("{"):
                try:
                    wrapper = json.loads(line)
                    record = parse_line(wrapper.get("line"), wrapper.get("receivedMonotonic"))
                except (ValueError, TypeError):
                    record = None
            else:
                record = parse_line(line)
            if record is not None:
                result.append(record)
    return result


def delta(rows, field, issues, label):
    values = [(row["time"], row["values"][field]) for row in rows if row["values"].get(field, -1) >= 0]
    if len(values) < 2:
        return None
    if any(b[1] < a[1] for a, b in zip(values, values[1:])):
        issues.append("counter_reset:" + label)
        return None
    return values[-1][1] - values[0][1]


def analyze_records(records, camera, quality, warmup_seconds=15, started=None, ended=None, interruption=None):
    """Never combine cameras, modes, profiles or restarted receiver counters."""
    mode = quality
    expected = [row for row in records if row.get("camera") == camera and row.get("mode") == mode and
                (quality == "auto" or row.get("quality") == quality) and row.get("time") is not None]
    render = next((row for row in expected if row["stage"] == "rendering" and (started is None or row["time"] >= started)), None)
    start = started if started is not None else render["time"] if render else expected[0]["time"] if expected else None
    profile = render.get("quality") if render else quality if quality != "auto" else None
    issues = []
    interruptions = [interruption] if interruption else []
    accepted = []
    if start is not None:
        render_count = 0
        for row in records:
            stamp = row.get("time")
            if stamp is None or stamp < start or ended is not None and stamp > ended:
                continue
            if row["stage"] not in {"rendering", "sample", "rtcstats", "quality"}:
                continue
            if not all(key in row for key in ("camera", "quality", "mode")):
                continue
            if row["camera"] != camera or row["mode"] != mode or row["quality"] != profile:
                interruptions.append("camera_quality_or_mode_changed")
                break
            if row["stage"] == "quality":
                interruptions.append("automatic_profile_switch")
                break
            if row["stage"] == "rendering":
                render_count += 1
                if render_count > 1:
                    interruptions.append("receiver_restarted")
                    break
            accepted.append(row)
    stats = [row for row in accepted if row["stage"] == "rtcstats"]
    samples = [row for row in accepted if row["stage"] == "sample"]
    steady_stats = [row for row in stats if row["time"] >= start + warmup_seconds] if start is not None else []
    steady_samples = [row for row in samples if row["time"] >= start + warmup_seconds] if start is not None else []
    span = steady_stats[-1]["time"] - steady_stats[0]["time"] if len(steady_stats) >= 2 else 0
    decoded = delta(steady_stats, "framesDecoded", issues, "framesDecoded")
    dropped = delta(steady_stats, "framesDropped", issues, "framesDropped")
    freeze_count = delta(steady_stats, "freezeCount", issues, "freezeCount")
    freeze_duration = delta(steady_stats, "totalFreezesDuration", issues, "totalFreezesDuration")
    lost = delta(steady_stats, "packetsLost", issues, "packetsLost")
    received = delta(steady_stats, "packetsReceived", issues, "packetsReceived")
    received_bytes = delta(steady_stats, "bytesReceived", issues, "bytesReceived")
    gap500 = delta(steady_samples, "decodedGapOver500Ms", issues, "decodedGapOver500Ms")
    gap1000 = delta(steady_samples, "decodedGapOver1000Ms", issues, "decodedGapOver1000Ms")
    delta(steady_samples, "decodedFrames", issues, "decodedSinkFrames")
    max_gap = max((row["values"].get("maxDecodedGapMs", 0) for row in samples), default=None)
    drop_ratio = dropped / (decoded + dropped) if decoded is not None and dropped is not None and decoded + dropped > 0 else None
    loss_ratio = lost / (lost + received) if lost is not None and received is not None and lost + received > 0 else None
    if freeze_count is not None and freeze_count > 0 or freeze_duration is not None and freeze_duration > 0:
        issues.append("steady_freeze")
    if gap500 is not None and gap500 > 0:
        issues.append("steady_decoded_gap_over_500ms")
    if drop_ratio is not None and drop_ratio >= .01:
        issues.append("steady_dropped_frame_ratio_at_least_1pct")
    if loss_ratio is not None and lost >= 10 and loss_ratio >= .02:
        issues.append("steady_packet_loss_at_least_2pct")
    if decoded is not None and decoded <= 0:
        issues.append("no_steady_decoded_progress")
    if any(issue.startswith("counter_reset:") for issue in issues):
        interruptions.append("receiver_counter_reset")
    sufficient = render is not None and span >= 20 and decoded is not None and gap500 is not None and freeze_count is not None and freeze_duration is not None
    def known_set(field):
        return sorted({row["values"][field] for row in steady_stats if row["values"].get(field, -1) >= 0})
    baseline = steady_stats[0]["values"] if steady_stats else {}
    paced = [row for row in steady_samples if row["values"].get("pacerSubmitted", -1) >= 0]
    paced_span = paced[-1]["time"] - paced[0]["time"] if len(paced) >= 2 else 0
    submitted = delta(paced, "pacerSubmitted", issues, "pacerSubmitted")
    pacing = {"available": paced_span > 0, "proofScope": "Renderer submissions only; not physical display presentation.",
        "counterSpanSeconds": round(paced_span, 3), "submittedFrames": submitted,
        "submittedFps": round(submitted / paced_span, 3) if submitted is not None and paced_span > 0 else None,
        "wholeSessionMaxSubmittedGapMs": max((row["values"].get("pacerMaxSubmittedGapMs", 0) for row in samples), default=None) if paced else None}
    for field in ("pacerGapOver250Ms", "pacerGapOver500Ms", "pacerGapOver1000Ms", "pacerOverflowDrops", "pacerLateDrops", "pacerFlushDrops", "pacerResets", "pacerFallbackFrames", "pacerBypassed", "pacerRenderErrors", "pacerReleaseErrors", "pacerScheduleErrors"):
        pacing[field] = delta(paced, field, issues, field)
    drop_fields = ["pacerOverflowDrops", "pacerLateDrops"]
    flush_samples = sum(row["values"].get("pacerFlushDrops", -1) >= 0 for row in paced)
    # Historical logs predate flush accounting. Preserve their existing measured
    # overflow/late ratio and state its scope; partially present new telemetry
    # cannot establish a flush delta covering the whole submission interval.
    pacing["flushDropsCoverage"] = "absent" if flush_samples == 0 else "complete" if flush_samples == len(paced) else "partial"
    if flush_samples:
        drop_fields.append("pacerFlushDrops")
    if pacing["flushDropsCoverage"] == "partial":
        pacing["pacerFlushDrops"] = None
        issues.append("pacer_drop_counter_coverage_partial")
    pacing["dropCountersIncluded"] = drop_fields
    paced_drops = sum(pacing[field] for field in drop_fields) if all(pacing[field] is not None for field in drop_fields) and pacing["flushDropsCoverage"] != "partial" else None
    pacing["dropRatio"] = paced_drops / (submitted + paced_drops) if submitted is not None and paced_drops is not None and submitted + paced_drops > 0 else None
    if pacing["dropRatio"] is not None and pacing["dropRatio"] >= .01:
        issues.append("steady_pacer_dropped_frame_ratio_at_least_1pct")
    if pacing["pacerGapOver500Ms"] is not None and pacing["pacerGapOver500Ms"] > 0:
        issues.append("steady_renderer_submission_gap_over_500ms")
    if any((pacing[field] or 0) > 0 for field in ("pacerRenderErrors", "pacerReleaseErrors", "pacerScheduleErrors")):
        issues.append("pacer_runtime_error")
    for field, issue in (("pacerResets", "steady_pacer_reset"),
                         ("pacerFallbackFrames", "steady_pacer_fallback_frames"),
                         ("pacerBypassed", "steady_pacer_bypassed_frames")):
        if (pacing[field] or 0) > 0:
            issues.append(issue)
    if any(issue.startswith("counter_reset:pacer") for issue in issues):
        interruptions.append("pacer_counter_reset")
    paced_baseline = paced[0]["values"] if paced else {}
    verdict = "interrupted" if interruptions else "insufficient_data" if not sufficient else "steady_degraded" if issues else "steady_no_observed_freeze"
    return {
        "camera": camera, "mode": mode, "profile": profile, "verdict": verdict,
        "interruptions": list(dict.fromkeys(interruptions)), "issues": list(dict.fromkeys(issues)),
        "proofScope": "Native decoded-frame callbacks and inbound-video counters; physical screen presentation is not proven.",
        "window": {"started": start, "ended": ended, "warmupSeconds": warmup_seconds, "steadyCounterSpanSeconds": round(span, 3), "rtcSamples": len(stats), "steadyRtcSamples": len(steady_stats)},
        "startupThroughFirstSteadySample": {"freezeCount": baseline.get("freezeCount"), "freezeDurationSeconds": baseline.get("totalFreezesDuration"), "framesDropped": baseline.get("framesDropped"),
            "pacerOverflowDrops": paced_baseline.get("pacerOverflowDrops"),
            "pacerLateDrops": paced_baseline.get("pacerLateDrops"),
            "pacerFlushDrops": paced_baseline.get("pacerFlushDrops")},
        "wholeSessionMaxDecodedGapMs": max_gap,
        "rendererSubmission": pacing,
        "steady": {"decodedFrames": decoded, "framesDropped": dropped, "dropRatio": drop_ratio,
            "freezeCount": freeze_count, "freezeDurationSeconds": freeze_duration,
            "decodedGapOver500Ms": gap500, "decodedGapOver1000Ms": gap1000,
            "packetsLost": lost, "packetsReceived": received, "packetLossRatio": loss_ratio,
            "decodedFps": round(decoded / span, 3) if decoded is not None and span > 0 else None,
            "bitrateKbps": round(received_bytes * 8 / span / 1000, 3) if received_bytes is not None and span > 0 else None,
            "decoderHwValues": known_set("decoderHw"), "decoderCodecMatchedValues": known_set("decoderCodecMatched"), "decoderCodecHwValues": known_set("decoderCodecHw"), "decoderCodecSoftwareValues": known_set("decoderCodecSoftware"), "remotePrivateValues": known_set("remotePrivate"), "remoteTypeHostValues": known_set("remoteTypeHost"),
            "dimensions": sorted({(row["values"].get("frameWidth"), row["values"].get("frameHeight")) for row in steady_stats if row["values"].get("frameWidth", 0) > 0 and row["values"].get("frameHeight", 0) > 0})},
    }


def parse_foreground(text):
    for line in text.splitlines():
        if "topResumedActivity" in line or "mResumedActivity" in line:
            match = re.search(r"\b([A-Za-z][A-Za-z0-9_.]+/[A-Za-z0-9_.$]+)", line)
            if match:
                return match.group(1)
    return None


def selected_button(xml, quality):
    root = ET.fromstring(xml[xml.index("<hierarchy"):xml.rfind("</hierarchy>") + len("</hierarchy>")])
    matches = []
    for node in root.iter("node"):
        text = node.get("text", "")
        if node.get("package") != PACKAGE or node.get("enabled") != "true" or node.get("clickable") != "true":
            continue
        if quality == "auto" and text.startswith("Auto · ") or text == {"smooth": "Plynulé", "hd": "HD"}.get(quality):
            bounds = BOUNDS.fullmatch(node.get("bounds", ""))
            if bounds:
                left, top, right, bottom = map(int, bounds.groups())
                if right > left and bottom > top:
                    matches.append({"text": text, "x": (left + right) // 2, "y": (top + bottom) // 2, "selected": node.get("selected") == "true"})
    if len(matches) != 1:
        raise RuntimeError("The exact native camera quality button is not uniquely visible.")
    return matches[0]


class Adb:
    def __init__(self, executable, serial):
        self.prefix = [executable, "-s", serial]

    def run(self, *args, timeout=12, binary=False):
        process = subprocess.run(self.prefix + list(args), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        return process.stdout if binary else process.stdout.decode("utf-8", "replace")

    def foreground(self):
        return parse_foreground(self.run("shell", "dumpsys", "activity", "activities"))

    def hierarchy(self):
        return self.run("exec-out", "uiautomator", "dump", "/dev/tty", timeout=15)


def private_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def run_case(adb, directory, camera, quality, args):
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    records, lock, stop = [], threading.Lock(), threading.Event()
    raw_path = directory / "rtc.jsonl"
    log = subprocess.Popen(adb.prefix + ["logcat", "-v", "epoch", "-T", "1", TAG + ":D", "*:S"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", errors="replace", bufsize=1)
    def collect():
        with raw_path.open("w", encoding="utf-8") as output:
            raw_path.chmod(0o600)
            for line in log.stdout:
                if stop.is_set():
                    break
                row = parse_line(line, time.monotonic())
                if row is not None:
                    with lock:
                        if len(records) >= 20000:
                            stop.set()
                            break
                        records.append(row)
                    output.write(json.dumps({"receivedMonotonic": row["time"], "line": line.rstrip("\n")}, ensure_ascii=False) + "\n"); output.flush()
    reader = threading.Thread(target=collect, name="camera-qa-log", daemon=True); reader.start()
    started = ended = render_anchor = None
    interruption = None
    setup_error = None
    foreground_checks = []
    try:
        launched = time.monotonic()
        adb.run("shell", "am", "start", "-W", "-n", COMPONENT, "--es", "open_camera", camera, timeout=20)
        button = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                button = selected_button(adb.hierarchy(), quality)
                break
            except (RuntimeError, ET.ParseError, ValueError, subprocess.SubprocessError):
                time.sleep(.5)
        if button is None:
            raise RuntimeError("Native camera quality controls were not observed within 15 seconds.")
        selection_at = time.monotonic() if not button["selected"] else launched
        if not button["selected"]:
            adb.run("shell", "input", "tap", str(button["x"]), str(button["y"]))
        confirmed = selected_button(adb.hierarchy(), quality)
        if not confirmed["selected"]:
            raise RuntimeError("Native camera did not confirm the requested quality selection.")
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            with lock:
                render = next((row for row in records if row.get("stage") == "rendering" and row.get("camera") == camera and row.get("mode") == quality and (quality == "auto" or row.get("quality") == quality) and row["time"] >= selection_at), None)
            if render:
                render_anchor = render["time"]
                break
            if log.poll() is not None:
                raise RuntimeError("ADB logcat stopped before rendering was observed.")
            time.sleep(.25)
        else:
            raise RuntimeError("No matching native rendered-frame event was observed.")
        if args.screenshots:
            (directory / "before-window.png").write_bytes(adb.run("exec-out", "screencap", "-p", timeout=15, binary=True))
            (directory / "before-window.png").chmod(0o600)
        # No screenshots or UI hierarchy dumps occur between these timestamps.
        started = time.monotonic()
        foreground = adb.foreground()
        foreground_checks.append({"time": time.monotonic(), "component": foreground})
        if foreground not in (COMPONENT, PACKAGE + "/" + PACKAGE + ".MainActivity"):
            interruption = "foreground_not_native_launcher"
        next_check = time.monotonic() + args.foreground_interval
        until = started + args.duration
        while not interruption and time.monotonic() < until:
            if stop.is_set() or log.poll() is not None:
                interruption = "log_collection_stopped"; break
            if time.monotonic() >= next_check:
                foreground = adb.foreground(); foreground_checks.append({"time": time.monotonic(), "component": foreground})
                if foreground not in (COMPONENT, PACKAGE + "/" + PACKAGE + ".MainActivity"):
                    interruption = "foreground_changed"; break
                next_check = time.monotonic() + args.foreground_interval
            time.sleep(.25)
        ended = time.monotonic()
        if args.screenshots and not interruption:
            (directory / "after-window.png").write_bytes(adb.run("exec-out", "screencap", "-p", timeout=15, binary=True))
            (directory / "after-window.png").chmod(0o600)
    except (RuntimeError, subprocess.SubprocessError, OSError) as error:
        setup_error = type(error).__name__ + ": " + str(error).splitlines()[0][:180]
        ended = time.monotonic()
    finally:
        stop.set(); log.terminate()
        try:
            log.wait(timeout=3)
        except subprocess.TimeoutExpired:
            log.kill(); log.wait(timeout=3)
        reader.join(timeout=2)
    with lock:
        captured = list(records)
    # Preserve pre-window rendering as an anchor; window deltas begin after warm-up.
    anchor = render_anchor if started is not None else None
    summary = analyze_records(captured, camera, quality, args.warmup, started=anchor, ended=ended, interruption=interruption)
    summary["collectionWindow"] = {"startedMonotonic": started, "endedMonotonic": ended, "requestedSeconds": args.duration, "noScreenshotsOrUiDumps": True, "foregroundChecks": foreground_checks}
    if setup_error:
        summary["setupError"] = setup_error; summary["verdict"] = "setup_failed"
    private_json(directory / "summary.json", summary)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    action = parser.add_mutually_exclusive_group(); action.add_argument("--run", action="store_true", help="Explicitly control the authorized TV through ADB."); action.add_argument("--parse", type=Path, help="Read one captured RTC log offline; never use ADB.")
    parser.add_argument("--camera", choices=CAMERAS + ("all",), default="all")
    parser.add_argument("--quality", choices=QUALITIES + ("auto", "all"), default="all")
    parser.add_argument("--duration", type=float, default=80)
    parser.add_argument("--warmup", type=float, default=15)
    parser.add_argument("--foreground-interval", type=float, default=10)
    parser.add_argument("--serial", help="Existing authorized ADB serial; no automatic pairing/connect.")
    parser.add_argument("--adb", default=str(Path.home() / ".local/share/home-tv-launcher/build-tools/android-sdk/platform-tools/adb"))
    parser.add_argument("--output", type=Path, default=Path.home() / ".local/share/home-tv-launcher/build-tools/qa/native-cameras" / dt.datetime.now().strftime("%Y%m%d-%H%M%S"))
    parser.add_argument("--screenshots", action="store_true", help="Optional private before/after screenshots outside each measurement window.")
    args = parser.parse_args(argv)
    if not 1 <= args.duration <= 600 or not 0 <= args.warmup < args.duration or not 2 <= args.foreground_interval <= 60:
        parser.error("duration must be 1..600, warmup less than duration and foreground interval 2..60 seconds.")
    if args.parse:
        if args.camera == "all" or args.quality == "all":
            parser.error("offline --parse needs one --camera and --quality")
        result = analyze_records(read_records(args.parse), args.camera, args.quality, args.warmup)
        print(json.dumps(result, ensure_ascii=False, indent=2)); return 0
    cases = [(camera, quality) for camera in (CAMERAS if args.camera == "all" else (args.camera,)) for quality in (QUALITIES if args.quality == "all" else (args.quality,))]
    if not args.run:
        print(json.dumps({"mode": "plan_only", "tvAccess": False, "durationSecondsPerCase": args.duration, "warmupSeconds": args.warmup, "cases": [{"camera": c, "quality": q} for c, q in cases], "measurementSecondsTotal": args.duration * len(cases), "outputIfRun": str(args.output), "note": "Only --run contacts/controls TV. Eight default cases take at least 10m40s plus setup. Counters do not prove physical presentation."}, ensure_ascii=False, indent=2)); return 0
    if not args.serial or not re.fullmatch(r"[A-Za-z0-9_.:\[\]-]{1,160}", args.serial):
        parser.error("--run requires an explicit, already-authorized --serial")
    executable = args.adb if Path(args.adb).is_file() else shutil.which("adb")
    if not executable:
        parser.error("adb not found; pass --adb with the installed platform-tools executable")
    adb = Adb(executable, args.serial)
    if adb.run("get-state").strip() != "device":
        parser.error("the selected ADB serial is not an authorized connected device")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=False); args.output.chmod(0o700)
    package = adb.run("shell", "dumpsys", "package", PACKAGE)
    version = re.search(r"\bversionName=([^\s]+)", package)
    private_json(args.output / "plan.json", {"createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "package": PACKAGE, "versionName": version.group(1) if version else None, "cases": cases, "durationSeconds": args.duration, "warmupSeconds": args.warmup})
    summaries = []
    for camera, quality in cases:
        print(f"START {camera}/{quality} {args.duration:g}s", flush=True)
        summary = run_case(adb, args.output / f"{camera}-{quality}", camera, quality, args)
        summaries.append(summary); private_json(args.output / "summary.json", summaries)
        print(json.dumps({"camera": camera, "quality": quality, "verdict": summary["verdict"], "issues": summary["issues"], "interruptions": summary["interruptions"]}), flush=True)
        if summary["verdict"] in ("interrupted", "setup_failed"):
            break  # Never retake control after the family/user changes the foreground app.
    print("RESULTS " + str(args.output), flush=True)
    return 0 if len(summaries) == len(cases) and all(item["verdict"] == "steady_no_observed_freeze" for item in summaries) else 1


if __name__ == "__main__":
    raise SystemExit(main())
