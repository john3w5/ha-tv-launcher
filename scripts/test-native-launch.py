#!/usr/bin/env python3
"""Offline native URI/catalog tests; no ADB, TV, network or application installation."""
from pathlib import Path
import argparse
import os
import json
import re
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
source = root / 'android/app/src/main/java/org/hometv/launcher'
tests = root / 'android/protocol-tests'
names = ['NativeLaunchPolicy', 'NativeCatalogPolicy']
files = [path for name in names for path in [source / (name + '.java'), tests / (name + 'Test.java')]]
with tempfile.TemporaryDirectory(prefix='home-tv-launch-test-') as output:
    subprocess.run([str(java_home / 'bin/javac'), '--release', '17', '-encoding', 'UTF-8', '-d', output,
                    *map(str, files)], check=True, timeout=30)
    for name in names:
        subprocess.run([str(java_home / 'bin/java'), '-cp', output, 'org.hometv.launcher.' + name + 'Test'],
                       check=True, timeout=10)

# These two independently consumed registries must agree exactly, including TCL's capital C.
frontend = (root / 'public/app.js').read_text()
design = re.search(r'const tvAppDesign\s*=\s*\{(.*?)\n\};', frontend, re.S)
assert design, 'Frontend approved app registry not found'
web_ids = set(re.findall(r"'([A-Za-z0-9_.]+)'\s*:\s*\{", design.group(1)))
policy = (source / 'NativeLaunchPolicy.java').read_text()
native_ids = set(re.findall(r'"([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)"', policy))
assert len(web_ids) == 12 and web_ids == native_ids, 'Native and web approved app registries differ'
activity = (source / 'MainActivity.kt').read_text()
assert not re.search(r'showDrawer|hideDrawer|drawerPanel|createLauncherButton|nativeControls|launcherButton', activity)
# Main pages now render natively. URI/JavaScript handoff belonged to the retired WebView home.
assert 'WebView' not in activity and 'evaluateJavascript' not in activity
assert 'TvAppLauncher(packageManager).resolve(id)' in activity
assert 'NativeTvView(this)' in activity
assert 'addJavascriptInterface' not in activity and 'Runtime.getRuntime' not in activity
print('Native/web exact allowlist, native launcher surface and absence of browser/catalog/floating controls: checked.')
