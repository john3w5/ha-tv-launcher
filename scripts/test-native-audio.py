#!/usr/bin/env python3
"""Offline audio/recovery timing-policy and original-WAV checks. Does not connect to any TV."""
from pathlib import Path
import argparse
import os
import array
import json
import subprocess
import tempfile
import wave

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
sources = [root / 'android/app/src/main/java/org/hometv/launcher/NativeAudioPolicy.java',
           root / 'android/protocol-tests/NativeAudioPolicyTest.java',
           root / 'android/app/src/main/java/org/hometv/launcher/DashboardRecoveryPolicy.java',
           root / 'android/protocol-tests/DashboardRecoveryPolicyTest.java']
with tempfile.TemporaryDirectory(prefix='home-tv-audio-test-') as output:
    subprocess.run([str(java_home / 'bin/javac'), '--release', '17', '-encoding', 'UTF-8', '-d', output,
                    *map(str, sources)], check=True, timeout=30)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.NativeAudioPolicyTest'], check=True, timeout=10)
    subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.DashboardRecoveryPolicyTest'], check=True, timeout=10)
for name in ['nav_move', 'nav_select']:
    with wave.open(str(root / 'android/app/src/main/res/raw' / (name + '.wav')), 'rb') as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 48000)
        duration_ms = 1000 * audio.getnframes() / audio.getframerate()
        samples = array.array('h', audio.readframes(audio.getnframes()))
        assert 20 <= duration_ms <= 35
        assert samples[0] == samples[-1] == 0
        assert .05 < max(abs(sample) for sample in samples) / 32767 <= .4
        assert abs(sum(samples) / len(samples) / 32767) < .03
print('Original WAV assets: 2 checked; mono PCM16, 48 kHz, 20–35 ms, bounded peak and zero endpoints.')
