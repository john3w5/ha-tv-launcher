#!/usr/bin/env python3
"""Compile camera controller/pacer and test pacing from existing local caches.

No Gradle, downloads, Android device commands, or Home Assistant access are used.
Run: python3 scripts/test-native-pacer.py
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import zipfile


def artifact(cache, group, module, version, extension="jar"):
    matches = list((cache / group / module / version).glob(
        "*/{}-{}.{}".format(module, version, extension)))
    if len(matches) != 1:
        raise ValueError("Expected one cached {}:{}:{} ({}); no download attempted".format(
            group, module, version, extension))
    return matches[0]


def required_match(pattern, source, label):
    match = re.search(pattern, source)
    if not match:
        raise ValueError("Cannot read {} from the project".format(label))
    return match.group(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", type=Path, default=Path(os.environ.get("HOME_TV_TOOLCHAIN", str(Path.home() / ".cache/home-tv-launcher/toolchain.json"))),
        help="Existing toolchain metadata; alternatively HOME_TV_TOOLCHAIN. Missing caches fail without downloads")
    parser.add_argument("--baseline-camera-sources", type=Path,
        help="Read preserved diagnostic baseline policy/controller/wrapper here; run baseline ownership/trace tests, not candidate acceptance")
    parser.add_argument("--trace-fixture-output", type=Path,
        help="Export a synthetic Kotlin-recorder fixture for offline parser interoperability; not TV evidence")
    args = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    toolchain_path = args.toolchain.expanduser().resolve()
    config = json.loads(toolchain_path.read_text(encoding="utf-8"))
    java = Path(config["javaHome"]) / "bin/java"
    cache = Path(config["gradleUserHome"]) / "caches/modules-2/files-2.1"
    root_build = (project / "android/build.gradle.kts").read_text(encoding="utf-8")
    app_build = (project / "android/app/build.gradle.kts").read_text(encoding="utf-8")
    kotlin = required_match(r'kotlin\.android"\) version "([^"]+)"', root_build, "Kotlin version")
    webrtc = required_match(r'io\.github\.webrtc-sdk:android:([^"\s]+)', app_build, "WebRTC version")
    sdk = required_match(r'compileSdk\s*=\s*(\d+)', app_build, "compile SDK")
    target = required_match(r'jvmTarget\s*=\s*"(\d+)"', app_build, "JVM target")
    android_jar = Path(config["androidSdkRoot"]) / "platforms" / ("android-" + sdk) / "android.jar"
    if not java.is_file() or not android_jar.is_file():
        raise ValueError("The configured JDK or Android platform is missing; no installation attempted")

    # These are the compiler's cached runtime dependencies for this project's Kotlin 2.2.20.
    if kotlin != "2.2.20":
        raise ValueError("Review compiler runtime dependencies for changed Kotlin version before running")
    stdlib = artifact(cache, "org.jetbrains.kotlin", "kotlin-stdlib", kotlin)
    compiler = [artifact(cache, "org.jetbrains.kotlin", name, kotlin) for name in (
        "kotlin-compiler-embeddable", "kotlin-stdlib", "kotlin-script-runtime", "kotlin-daemon-embeddable")]
    compiler += [artifact(cache, "org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
        artifact(cache, "org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
        artifact(cache, "org.jetbrains", "annotations", "13.0")]
    aar = artifact(cache, "io.github.webrtc-sdk", "android", webrtc, "aar")
    sources = [project / path for path in (
        "android/app/src/main/java/org/hometv/launcher/NativeFramePacerPolicy.kt",
        "android/app/src/main/java/org/hometv/launcher/NativeAbsoluteFramePacerPolicy.kt",
        "android/app/src/main/java/org/hometv/launcher/NativeFramePacer.kt",
        "android/app/src/main/java/org/hometv/launcher/NativePacerTimingTrace.kt",
        "android/app/src/main/java/org/hometv/launcher/NativePacerTraceScheduler.kt",
        "android/app/src/main/java/org/hometv/launcher/NativePacerTraceFileExporter.kt",
        "android/app/src/main/java/org/hometv/launcher/NativeWebRtcController.kt",
        "android/app/src/main/java/org/hometv/launcher/NativeWebRtcTransport.kt",
        "android/app/src/main/java/org/hometv/launcher/NativeDecoderEvidence.kt",
        "android/protocol-tests/NativeFramePacerTest.kt",
        "android/protocol-tests/NativeAbsoluteFramePacerTest.kt",
        "android/protocol-tests/NativeAbsoluteFramePacerSdkTest.kt",
        "android/protocol-tests/NativeFramePacerSdkTest.kt",
        "android/protocol-tests/NativePacerTimingTraceTest.kt",
        "android/protocol-tests/NativePacerTraceSchedulerTest.kt",
        "android/protocol-tests/NativePacerTraceFileExporterTest.kt")]
    mains = ["NativeFramePacerTestKt", "NativeAbsoluteFramePacerTestKt", "NativeAbsoluteFramePacerSdkTestKt", "NativeFramePacerSdkTestKt", "NativePacerTimingTraceTestKt", "NativePacerTraceSchedulerTestKt", "NativePacerTraceFileExporterTestKt"]
    if args.baseline_camera_sources:
        baseline = args.baseline_camera_sources.expanduser().resolve()
        wrapper = baseline / "NativeFramePacer.kt"
        if not wrapper.is_file() or "traceSequence" not in wrapper.read_text() or "NativeAbsoluteFramePacerPolicy(" in wrapper.read_text():
            raise ValueError("Use a compatible baseline source archive in the public package, including its unchanged scheduling wrapper")
        replaced = {"NativeFramePacerPolicy.kt", "NativeWebRtcController.kt", "NativeFramePacer.kt"}
        sources = [baseline / path.name if path.name in replaced else path for path in sources
            if path.name not in {"NativeFramePacerTest.kt", "NativeAbsoluteFramePacerTest.kt", "NativeAbsoluteFramePacerSdkTest.kt", "NativeAbsoluteFramePacerPolicy.kt"}]
        mains = ["NativeFramePacerSdkTestKt", "NativePacerTimingTraceTestKt", "NativePacerTraceSchedulerTestKt", "NativePacerTraceFileExporterTestKt"]
        print("Diagnostic compatibility compile: preserved baseline policy/controller; scheduling sources are not rewritten", flush=True)
    policies = [project / "android/app/src/main/java/org/hometv/launcher" / (name + ".java")
        for name in ("OverlayProtocol", "NativeWebRtcPolicy", "NativeMediaPolicy",
            "NativeAutoQualityPolicy", "NativeCameraRecoveryPolicy", "NativeIceCandidatePolicy")]
    if not all(path.is_file() for path in sources + policies):
        raise ValueError("Camera source/test files are missing")

    print("Offline NativeFramePacer verification: actual cached WebRTC {}, Android {}".format(webrtc, sdk), flush=True)
    with tempfile.TemporaryDirectory(prefix="native-pacer-test-", dir=toolchain_path.parent) as temporary:
        work = Path(temporary)
        rtc_jar = work / "webrtc-classes.jar"
        with zipfile.ZipFile(aar) as archive:
            rtc_jar.write_bytes(archive.read("classes.jar"))
        # Compile the real camera controller too, so diagnostic Stats changes
        # cannot silently break its integration. Only Gradle's generated config
        # constants are stubbed; no Android classes or SDK APIs are substituted.
        build_config = work / "BuildConfig.java"
        build_config.write_text('package org.hometv.launcher; public final class BuildConfig { '
            'public static final boolean DEBUG = true; '
            'public static final String VERSION_NAME = "offline-camera-compile"; '
            'public static final String DASHBOARD_URL = "http://127.0.0.1:4317/"; }\n', encoding="utf-8")
        subprocess.run([str(java.with_name("javac")), "--release", target, "-encoding", "UTF-8",
            "-classpath", str(android_jar), "-d", str(work), str(build_config), *map(str, policies)],
            cwd=project, check=True)
        subprocess.run([str(java), "-cp", os.pathsep.join(map(str, compiler)),
            "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect",
            "-jvm-target", target, "-classpath", os.pathsep.join(map(str, (work, stdlib, android_jar, rtc_jar))),
            "-d", str(work), *map(str, sources)], cwd=project, check=True)
        # The SDK ownership fixture executes actual VideoFrame/JavaI420Buffer
        # bytecode from this AAR. wrap() uses caller-owned direct buffers, so it
        # needs neither Android stubs nor the Android-only native library at runtime.
        runtime = os.pathsep.join(map(str, (work, stdlib, rtc_jar)))
        for main_class in mains:
            subprocess.run([str(java), "-cp", runtime,
                "org.hometv.launcher." + main_class], cwd=project, check=True)
        if args.trace_fixture_output:
            with args.trace_fixture_output.open("w", encoding="utf-8") as output:
                subprocess.run([str(java), "-cp", runtime,
                    "org.hometv.launcher.NativePacerTimingTraceTestKt", "--export-fixture"],
                    cwd=project, stdout=output, check=True)
    print("Offline NativeFramePacer compile/test PASS", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode or 1)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print("Offline NativeFramePacer verification failed: {}".format(error), file=sys.stderr)
        sys.exit(1)
