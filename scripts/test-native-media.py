#!/usr/bin/env python3
"""Offline native media URL and lifecycle tests. No camera, HA or TV connection."""
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
src = root / 'android/app/src/main/java/org/hometv/launcher'
files = [src / 'OverlayProtocol.java', src / 'NativeMediaPolicy.java', root / 'android/protocol-tests/NativeMediaPolicyTest.java',
         src / 'NativeHlsRequestPolicy.java', root / 'android/protocol-tests/NativeHlsRequestPolicyTest.java',
         src / 'NativeCameraRecoveryPolicy.java', root / 'android/protocol-tests/NativeCameraRecoveryPolicyTest.java',
         src / 'NativeAutoQualityPolicy.java', root / 'android/protocol-tests/NativeAutoQualityPolicyTest.java',
         src / 'NativeConfirmationPolicy.java', root / 'android/protocol-tests/NativeConfirmationPolicyTest.java']
with tempfile.TemporaryDirectory(prefix='home-tv-media-test-') as output:
    subprocess.run([str(java_home / 'bin/javac'), '--release', '17', '-encoding', 'UTF-8', '-d', output,
                    *map(str, files)], check=True, timeout=30)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeMediaPolicyTest'], check=True, timeout=10)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeHlsRequestPolicyTest'], check=True, timeout=10)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeCameraRecoveryPolicyTest'], check=True, timeout=10)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeAutoQualityPolicyTest'], check=True, timeout=10)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeConfirmationPolicyTest'], check=True, timeout=10)
