import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("tv_camera_qa", ROOT / "scripts/test-tv-camera-playback.py")
QA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(QA)


def record(second, stage, camera="entrance", quality="smooth", mode="smooth", **values):
    fields = f"stage={stage} camera={camera} quality={quality} mode={mode} " + " ".join(f"{key}={value}" for key, value in values.items())
    return QA.parse_line(f"1800000000.000 100 100 D HomeTVRTC: {fields}", second)


def stream():
    rows = [record(0, "rendering")]
    for second in range(10, 81, 10):
        rows.extend([
            record(second, "sample", decodedFrames=second * 20, maxDecodedGapMs=1250, decodedGapOver500Ms=2, decodedGapOver1000Ms=1),
            record(second + .01, "rtcstats", framesDecoded=second * 20, framesDropped=1, freezeCount=2, totalFreezesDuration=1.2,
                   packetsLost=0, packetsReceived=second * 100, bytesReceived=second * 100000, decoderHw=1, remotePrivate=1, remoteTypeHost=1, frameWidth=1280, frameHeight=720),
        ])
    return rows


class NativeCameraQaTest(unittest.TestCase):
    def paced_stream(self):
        rows = stream()
        for row in rows:
            if row['stage'] == 'sample':
                second = row['time']
                row['values'].update(pacerSubmitted=second * 18, pacerOverflowDrops=second * 2,
                    pacerLateDrops=0, pacerGapOver500Ms=0, pacerRenderErrors=0,
                    pacerReleaseErrors=0, pacerScheduleErrors=0)
        return rows

    def clean_paced_hd_stream(self):
        rows = stream()
        for row in rows:
            row.update(quality='hd', mode='hd')
            if row['stage'] == 'sample':
                row['values'].update(pacerSubmitted=row['time'] * 20,
                    pacerOverflowDrops=0, pacerLateDrops=0, pacerFlushDrops=0,
                    pacerResets=0, pacerFallbackFrames=0, pacerBypassed=0,
                    pacerGapOver500Ms=0, pacerRenderErrors=0,
                    pacerReleaseErrors=0, pacerScheduleErrors=0)
        return rows

    def test_pacer_capacity_loss_is_not_reported_as_clean_video(self):
        result = QA.analyze_records(self.paced_stream(), 'entrance', 'smooth')
        self.assertEqual(result['verdict'], 'steady_degraded')
        self.assertIn('steady_pacer_dropped_frame_ratio_at_least_1pct', result['issues'])
        self.assertAlmostEqual(result['rendererSubmission']['dropRatio'], .1)

    def test_pacer_counter_resets_are_not_combined(self):
        rows = self.paced_stream()
        [row for row in rows if row['stage'] == 'sample'][-1]['values']['pacerSubmitted'] = 1
        result = QA.analyze_records(rows, 'entrance', 'smooth')
        self.assertEqual(result['verdict'], 'interrupted')
        self.assertIn('pacer_counter_reset', result['interruptions'])

    def test_pacer_flush_loss_counts_in_drop_ratio(self):
        rows = self.clean_paced_hd_stream()
        for row in rows:
            if row['stage'] == 'sample' and row['time'] >= 50:
                row['values']['pacerFlushDrops'] = 40
        result = QA.analyze_records(rows, 'entrance', 'hd')
        pacing = result['rendererSubmission']
        self.assertEqual(result['verdict'], 'steady_degraded')
        self.assertIn('steady_pacer_dropped_frame_ratio_at_least_1pct', result['issues'])
        self.assertEqual(pacing['pacerFlushDrops'], 40)
        self.assertAlmostEqual(pacing['dropRatio'], 40 / (1200 + 40))
        self.assertEqual(pacing['flushDropsCoverage'], 'complete')
        self.assertIn('pacerFlushDrops', pacing['dropCountersIncluded'])

    def test_historical_logs_without_flush_counter_keep_measured_ratio(self):
        result = QA.analyze_records(self.paced_stream(), 'entrance', 'smooth')
        pacing = result['rendererSubmission']
        self.assertAlmostEqual(pacing['dropRatio'], .1)
        self.assertIsNone(pacing['pacerFlushDrops'])
        self.assertEqual(pacing['flushDropsCoverage'], 'absent')
        self.assertEqual(pacing['dropCountersIncluded'], ['pacerOverflowDrops', 'pacerLateDrops'])
        self.assertIsNone(result['startupThroughFirstSteadySample']['pacerFlushDrops'])

    def test_partial_flush_counter_does_not_claim_a_complete_drop_ratio(self):
        rows = self.clean_paced_hd_stream()
        next(row for row in rows if row['stage'] == 'sample' and row['time'] == 20)['values'].pop('pacerFlushDrops')
        result = QA.analyze_records(rows, 'entrance', 'hd')
        self.assertEqual(result['rendererSubmission']['flushDropsCoverage'], 'partial')
        self.assertIsNone(result['rendererSubmission']['pacerFlushDrops'])
        self.assertIsNone(result['rendererSubmission']['dropRatio'])
        self.assertEqual(result['verdict'], 'steady_degraded')
        self.assertIn('pacer_drop_counter_coverage_partial', result['issues'])

    def test_flush_counter_reset_interrupts_the_pacer_measurement(self):
        rows = self.clean_paced_hd_stream()
        for row in rows:
            if row['stage'] == 'sample':
                row['values']['pacerFlushDrops'] = 100 if row['time'] < 80 else 1
        result = QA.analyze_records(rows, 'entrance', 'hd')
        self.assertEqual(result['verdict'], 'interrupted')
        self.assertIn('counter_reset:pacerFlushDrops', result['issues'])
        self.assertIn('pacer_counter_reset', result['interruptions'])
        self.assertIsNone(result['rendererSubmission']['dropRatio'])

    def test_steady_resets_fallback_and_bypass_degrade_hd_even_without_drop_counts(self):
        for field, issue in (('pacerResets', 'steady_pacer_reset'),
                             ('pacerFallbackFrames', 'steady_pacer_fallback_frames'),
                             ('pacerBypassed', 'steady_pacer_bypassed_frames')):
            with self.subTest(field=field):
                rows = self.clean_paced_hd_stream()
                for row in rows:
                    if row['stage'] == 'sample' and row['time'] >= 50:
                        row['values'][field] = 1
                result = QA.analyze_records(rows, 'entrance', 'hd')
                self.assertEqual(result['verdict'], 'steady_degraded')
                self.assertIn(issue, result['issues'])
                self.assertEqual(result['rendererSubmission'][field], 1)
                self.assertEqual(result['rendererSubmission']['dropRatio'], 0)

    def test_startup_pacer_losses_stay_visible_without_becoming_steady_losses(self):
        rows = self.clean_paced_hd_stream()
        startup = dict(pacerOverflowDrops=7, pacerLateDrops=3, pacerFlushDrops=2,
                       pacerResets=1, pacerFallbackFrames=4, pacerBypassed=1)
        for row in rows:
            if row['stage'] == 'sample':
                row['values'].update(startup)
        result = QA.analyze_records(rows, 'entrance', 'hd')
        self.assertEqual(result['verdict'], 'steady_no_observed_freeze')
        self.assertEqual(result['rendererSubmission']['dropRatio'], 0)
        for field in ('pacerOverflowDrops', 'pacerLateDrops', 'pacerFlushDrops'):
            self.assertEqual(result['startupThroughFirstSteadySample'][field], startup[field])
            self.assertEqual(result['rendererSubmission'][field], 0)
        self.assertFalse(any(issue.startswith('steady_pacer') for issue in result['issues']))

    def test_flush_drop_ratio_at_exactly_one_percent_is_degraded(self):
        rows = self.clean_paced_hd_stream()
        for row in rows:
            if row['stage'] == 'sample':
                row['values']['pacerSubmitted'] = int(row['time'] / 10) * 165
                row['values']['pacerFlushDrops'] = 10 if row['time'] >= 50 else 0
        result = QA.analyze_records(rows, 'entrance', 'hd')
        self.assertAlmostEqual(result['rendererSubmission']['dropRatio'], .01)
        self.assertEqual(result['verdict'], 'steady_degraded')

    def test_startup_freezes_do_not_become_steady_freezes(self):
        result = QA.analyze_records(stream(), "entrance", "smooth")
        self.assertEqual(result["verdict"], "steady_no_observed_freeze")
        self.assertEqual(result["startupThroughFirstSteadySample"]["freezeCount"], 2)
        self.assertEqual(result["steady"]["freezeCount"], 0)
        self.assertEqual(result["wholeSessionMaxDecodedGapMs"], 1250)
        self.assertEqual(result["steady"]["decodedGapOver500Ms"], 0)
        self.assertAlmostEqual(result["steady"]["decodedFps"], 20)
        self.assertAlmostEqual(result["steady"]["bitrateKbps"], 800)
        self.assertIn("physical screen presentation is not proven", result["proofScope"])

    def test_real_steady_freezes_gaps_and_packet_loss_are_flagged(self):
        rows = stream()
        for row in rows:
            if row["time"] >= 50:
                if row["stage"] == "sample":
                    row["values"]["decodedGapOver500Ms"] += 1
                    row["values"]["decodedGapOver1000Ms"] += 1
                else:
                    row["values"]["freezeCount"] += 1
                    row["values"]["totalFreezesDuration"] += 2
                    row["values"]["packetsLost"] += 300
                    row["values"]["framesDropped"] += 50
        result = QA.analyze_records(rows, "entrance", "smooth")
        self.assertEqual(result["verdict"], "steady_degraded")
        for flag in ("steady_freeze", "steady_decoded_gap_over_500ms", "steady_packet_loss_at_least_2pct", "steady_dropped_frame_ratio_at_least_1pct"):
            self.assertIn(flag, result["issues"])

    def test_foreign_camera_or_quality_never_gets_counted(self):
        for change in ({"camera": "cars"}, {"quality": "hd", "mode": "hd"}, {"mode": "auto"}):
            rows = stream(); rows.insert(7, record(35, "rtcstats", framesDecoded=999999, **change))
            result = QA.analyze_records(rows, "entrance", "smooth")
            self.assertEqual(result["verdict"], "interrupted")
            self.assertIn("camera_quality_or_mode_changed", result["interruptions"])
            self.assertLess(result["window"]["steadyRtcSamples"], 7)

    def test_restarted_receiver_and_counter_reset_are_not_combined(self):
        rows = stream(); rows.insert(7, record(35, "rendering"))
        self.assertIn("receiver_restarted", QA.analyze_records(rows, "entrance", "smooth")["interruptions"])
        rows = stream(); rows[-1]["values"]["framesDecoded"] = 1
        result = QA.analyze_records(rows, "entrance", "smooth")
        self.assertEqual(result["verdict"], "interrupted")
        self.assertIsNone(result["steady"]["decodedFrames"])

    def test_missing_or_too_short_logs_do_not_claim_success(self):
        self.assertEqual(QA.analyze_records([], "entrance", "smooth")["verdict"], "insufficient_data")
        self.assertEqual(QA.analyze_records(stream()[:5], "entrance", "smooth")["verdict"], "insufficient_data")
        rows = stream()
        for row in rows:
            row["values"].pop("freezeCount", None)
        self.assertEqual(QA.analyze_records(rows, "entrance", "smooth")["verdict"], "insufficient_data")

    def test_logcat_and_jsonl_are_both_offline_inputs(self):
        self.assertIsNone(QA.parse_line("other tag http://private/"))
        self.assertIsNone(QA.parse_line("HomeTVRTC " + "x" * 17000))
        line = "1800000000.250 123 D HomeTVRTC: stage=sample camera=entrance quality=hd mode=hd decodedFrames=42"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rtc.jsonl"
            path.write_text(json.dumps({"receivedMonotonic": 12.5, "line": line}) + "\n" + line + "\n")
            rows = QA.read_records(path)
            self.assertEqual([row["time"] for row in rows], [12.5, 1800000000.25])

    def test_buttons_use_exact_observed_bounds_and_never_guess(self):
        xml = '<hierarchy><node package="org.hometv.launcher" text="HD" enabled="true" clickable="true" selected="false" bounds="[10,20][110,60]"/></hierarchy>'
        self.assertEqual(QA.selected_button(xml, "hd"), {"text": "HD", "x": 60, "y": 40, "selected": False})
        with self.assertRaises(RuntimeError):
            QA.selected_button(xml.replace('text="HD"', 'text="Nastavení"'), "hd")
        with self.assertRaises(RuntimeError):
            QA.selected_button(xml.replace(PACKAGE := "org.hometv.launcher", "foreign.app"), "hd")

    def test_foreground_and_default_plan_never_execute_adb(self):
        self.assertEqual(QA.parse_foreground("mResumedActivity: ActivityRecord{xx u0 org.hometv.launcher/.MainActivity t4}"), QA.COMPONENT)
        with mock.patch.object(QA.subprocess, "run", side_effect=AssertionError("No ADB without --run")), mock.patch.object(QA.subprocess, "Popen", side_effect=AssertionError("No logcat without --run")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(QA.main([]), 0)
            plan = json.loads(output.getvalue())
            self.assertFalse(plan["tvAccess"]); self.assertEqual(len(plan["cases"]), 8); self.assertEqual(plan["measurementSecondsTotal"], 640)


if __name__ == "__main__":
    unittest.main()
