#!/usr/bin/env python3
"""Offline calendar projection, cache freshness and Czech/DST regression checks."""
from pathlib import Path
import argparse
import os
import json
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--toolchain', type=Path,
    default=Path(os.environ.get('HOME_TV_TOOLCHAIN', str(Path.home() / '.cache/home-tv-launcher/toolchain.json'))),
    help='Existing local toolchain metadata; alternatively set HOME_TV_TOOLCHAIN. No installation or download.')
args = parser.parse_args()
metadata = args.toolchain.expanduser().resolve()
if not metadata.is_file():
    parser.error('Provide existing toolchain metadata with --toolchain or HOME_TV_TOOLCHAIN')
java_home = Path(json.loads(metadata.read_text())['javaHome'])
sources = [root / 'android/app/src/main/java/org/hometv/launcher/NativeCalendarProjection.java',
           root / 'android/protocol-tests/NativeCalendarProjectionTest.java']
with tempfile.TemporaryDirectory(prefix='home-tv-calendar-test-') as output:
    subprocess.run([str(java_home / 'bin/javac'), '--release', '17', '-encoding', 'UTF-8', '-d', output,
                    *map(str, sources)], check=True, timeout=30)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeCalendarProjectionTest'],
                   check=True, timeout=20)
