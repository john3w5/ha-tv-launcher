#!/usr/bin/env python3
"""Compile/run the offline real-trace replay from existing caches; never access TV.

Only a complete schema2 parser export is eligible. Candidate runs are explicitly
counterfactual; baseline calibration reports whether its recorded slots match.
An explicit uniform-I420 assumption is required because trace rows omit format.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BASELINE_SHA256 = '548f70f8e34c37eb599cd5deed881766f77ca0bbfc4fb7410d2523160d2dd926'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--baseline-source', type=Path, default=Path.home() /
        '.local/share/home-tv-launcher/build-tools/artifacts/0.5.15-camera-baseline/NativeFramePacerPolicy.kt')
    parser.add_argument('--toolchain', type=Path, default=Path.home() /
        '.cache/home-tv-launcher/toolchain.json')
    parser.add_argument('--pid', type=int)
    parser.add_argument('--session', type=int)
    assumptions = parser.add_mutually_exclusive_group()
    assumptions.add_argument('--assume-uniform-i420-from-queue', action='store_true')
    assumptions.add_argument('--assume-uniform-i420-bytes', type=int)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.input:
        args.input = args.input.expanduser().resolve()
    if args.output:
        args.output = args.output.expanduser().resolve()
    if not args.input and not args.self_test:
        parser.error('Provide --input or --self-test')
    if args.input and (not args.output or not (args.assume_uniform_i420_from_queue or args.assume_uniform_i420_bytes)):
        parser.error('Replay requires --output and an explicit uniform I420 assumption')
    if args.input and args.input.stat().st_size > 20 * 1024 * 1024:
        parser.error('Parsed trace exceeds the bounded 20MiB offline input limit')
    if args.output and args.output.exists():
        parser.error('Use a new output path; preserve previous analyses')
    project = Path(__file__).resolve().parents[1]
    baseline = args.baseline_source.expanduser().resolve()
    original = baseline.read_bytes()
    if hashlib.sha256(original).hexdigest() != BASELINE_SHA256:
        raise ValueError('Baseline is not the preserved .5.15 policy')
    declaration = 'internal class NativeFramePacerPolicy<'
    source = original.decode('utf-8')
    if source.count(declaration) != 1:
        raise ValueError('Unexpected baseline class declaration')
    config_path = args.toolchain.expanduser().resolve()
    config = json.loads(config_path.read_text())
    java = Path(config['javaHome']) / 'bin/java'
    cache = Path(config['gradleUserHome']) / 'caches/modules-2/files-2.1'
    spec = importlib.util.spec_from_file_location('native_pacer_offline', project / 'scripts/test-native-pacer.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    artifact = helper.artifact
    version = '2.2.20'
    compiler = [artifact(cache, 'org.jetbrains.kotlin', name, version) for name in
        ('kotlin-compiler-embeddable', 'kotlin-stdlib', 'kotlin-script-runtime', 'kotlin-daemon-embeddable')]
    compiler += [artifact(cache, 'org.jetbrains.kotlin', 'kotlin-reflect', '1.6.10'),
        artifact(cache, 'org.jetbrains.kotlinx', 'kotlinx-coroutines-core-jvm', '1.8.0'),
        artifact(cache, 'org.jetbrains', 'annotations', '13.0')]
    stdlib = artifact(cache, 'org.jetbrains.kotlin', 'kotlin-stdlib', version)
    gson = artifact(cache, 'com.google.code.gson', 'gson', '2.11.0')
    sources = [project / 'android/app/src/main/java/org/hometv/launcher' / name for name in
        ('NativeAbsoluteFramePacerPolicy.kt', 'NativePacerTimingTrace.kt')]
    sources += [project / 'android/protocol-tests' / name for name in
        ('NativePacerTraceReplay.kt', 'NativePacerTraceReplayTest.kt')]
    if not all(path.is_file() for path in sources):
        raise ValueError('Replay source files are missing')
    source_hashes = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}
    with tempfile.TemporaryDirectory(prefix='native-pacer-replay-', dir=config_path.parent) as temporary:
        work = Path(temporary)
        renamed = work / 'NativeRecordedBaselinePolicy.kt'
        renamed.write_text(source.replace(declaration, 'internal class NativeRecordedBaselinePolicy<'))
        subprocess.run([str(java), '-cp', os.pathsep.join(map(str, compiler)),
            'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect',
            '-jvm-target', '17', '-classpath', os.pathsep.join(map(str, (stdlib, gson))),
            '-d', str(work), str(renamed), *map(str, sources)], check=True, cwd=project)
        runtime = os.pathsep.join(map(str, (work, stdlib, gson)))
        if args.self_test:
            subprocess.run([str(java), '-cp', runtime,
                'org.hometv.launcher.NativePacerTraceReplayTestKt'], check=True, cwd=project)
        if args.input:
            command = [str(java), '-cp', runtime, 'org.hometv.launcher.NativePacerTraceReplayKt',
                '--input', str(args.input.expanduser().resolve()), '--output', str(args.output.expanduser().resolve()),
                '--baseline-source', str(baseline), '--candidate-source', str(sources[0])]
            if args.assume_uniform_i420_from_queue:
                command.append('--assume-uniform-i420-from-queue')
            else:
                command += ['--assume-uniform-i420-bytes', str(args.assume_uniform_i420_bytes)]
            if args.pid is not None:
                command += ['--pid', str(args.pid)]
            if args.session is not None:
                command += ['--session', str(args.session)]
            result = subprocess.run(command, cwd=project).returncode
            if any(hashlib.sha256(Path(path).read_bytes()).hexdigest() != digest for path, digest in source_hashes.items()):
                raise ValueError('Replay sources changed during compilation or execution; output is not a verified run')
            if result == 0:
                provenance = dict(baselineSha256=BASELINE_SHA256, compiledSourceSha256=source_hashes,
                    parsedInputSha256=hashlib.sha256(args.input.read_bytes()).hexdigest(),
                    outputSha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),
                    sourceBinding='same source bytes verified before compiler invocation and after execution',
                    mode='offline counterfactual replay; no TV access')
                args.output.with_suffix(args.output.suffix + '.provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
            return result
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as error:
        sys.exit(error.returncode or 1)
    except (OSError, ValueError, KeyError) as error:
        print('Offline replay failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
