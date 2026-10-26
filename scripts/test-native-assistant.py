#!/usr/bin/env python3
"""Offline native assistant command guards. No device or HA command is invoked."""
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
java = Path(json.loads(metadata.read_text())['javaHome']) / 'bin'
source = root / 'android/app/src/main/java/org/hometv/launcher'
with tempfile.TemporaryDirectory(prefix='home-tv-assistant-test-') as output:
    subprocess.run([str(java / 'javac'), '--release', '17', '-encoding', 'UTF-8', '-d', output,
        str(source / 'NativeLaunchPolicy.java'), str(source / 'NativeAssistantPolicy.java'),
        str(root / 'android/protocol-tests/NativeAssistantPolicyTest.java')], check=True, timeout=30)
    subprocess.run([str(java / 'java'), '-cp', output, 'org.hometv.launcher.NativeAssistantPolicyTest'], check=True, timeout=10)
