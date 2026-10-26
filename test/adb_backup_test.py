"""Offline tests only. Fake ADB responses and tiny fake APKs; never connects to a TV."""
import importlib.util
import json
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("adb_backup", Path(__file__).resolve().parents[1] / "scripts" / "adb-backup.py")
backup = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backup
SPEC.loader.exec_module(backup)
HOME = "com.google.android.apps.tv.launcherx/.home.HomeActivity"
PACKAGE = HOME.split("/")[0]
REMOTE = "/product/app/LauncherX/base.apk"
SPLIT = "/product/app/LauncherX/split_config.en.apk"
APK = b"fake-apk"


class FakeAdb:
    serial = "192.168.50.133:46277"
    executable = "/path with spaces/adb"

    def __init__(self, fail_pull=False, unsafe_path=False, missing_home=False):
        self.calls = []
        self.fail_pull = fail_pull
        self.unsafe_path = unsafe_path
        self.missing_home = missing_home

    def call(self, parts):
        self.calls.append(parts)
        if parts[:2] == ["shell", "getprop"]:
            return backup.Result(True, "34" if parts[-1].endswith("sdk") else "TCL-test")
        if parts[:3] == ["shell", "am", "get-current-user"]:
            return backup.Result(True, "0")
        if parts[:4] == ["shell", "cmd", "package", "resolve-activity"]:
            return backup.Result(True, "android/com.android.internal.app.ResolverActivity" if self.missing_home else HOME)
        if parts[:4] == ["shell", "cmd", "package", "query-activities"]:
            return backup.Result(True, HOME + "\ncom.tcl.launcher/.MainActivity\n")
        if parts[:4] == ["shell", "pm", "list", "users"]:
            return backup.Result(True, "Users:\n UserInfo{0:Owner:13} running\n UserInfo{10:Child:10}")
        if parts[:4] == ["shell", "pm", "list", "packages"]:
            return backup.Result(True, "" if "-d" in parts else "package:/product/app/LauncherX/base.apk=" + PACKAGE + " versionCode:123\n")
        if parts[:2] == ["shell", "settings"]:
            return backup.Result(True, "null")
        if parts[:3] == ["shell", "dumpsys", "package"]:
            return backup.Result(True, "versionCode=123 minSdk=26\nversionName=1.2.3\nUser 0: installed=true hidden=false stopped=false notLaunched=false enabled=0\nUser 10: installed=true enabled=1\nsecretUnrelatedProperty=DO-NOT-STORE\n")
        if parts[:3] == ["shell", "pm", "path"]:
            return backup.Result(True, "package:" + ("/product/app/a;evil.apk" if self.unsafe_path else REMOTE) + "\npackage:" + SPLIT)
        if parts[:3] == ["shell", "stat", "-c"]:
            return backup.Result(True, str(len(APK)))
        if parts[0] == "pull":
            if self.fail_pull:
                return backup.Result(False, reason="simulated disconnect", returncode=1)
            Path(parts[2]).write_bytes(APK)
            return backup.Result(True, "1 file pulled")
        raise AssertionError("Unexpected command: " + repr(parts))


class AdbBackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tv-backup-offline-")
        self.directory = Path(self.temporary.name) / "backup"
        backup.prepare_destination(self.directory)

    def tearDown(self):
        self.temporary.cleanup()

    def run_backup(self, adb=None, **kwargs):
        adb = adb or FakeAdb()
        result = backup.Backup(adb, self.directory, **kwargs).run()
        return result, adb

    def test_complete_backup_checksums_private_permissions_and_restore_target(self):
        result, adb = self.run_backup()
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["safeToProceed"])
        self.assertEqual(len(result["apks"]), 2)
        self.assertEqual(result["homeComponent"], HOME)
        for item in result["files"]:
            filename = self.directory / item["file"]
            self.assertEqual(backup.sha256(filename), item["sha256"])
            self.assertEqual(stat.S_IMODE(filename.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        restored = (self.directory / "RESTORE.md").read_text()
        self.assertIn("set-home-activity --user 0 " + HOME, restored)
        inventory = json.loads((self.directory / "inventory.json").read_text())
        self.assertEqual(inventory["users"], [0, 10])
        self.assertEqual(inventory["selectedPackages"][0]["users"]["0"]["enabled"], 0)
        self.assertNotIn("DO-NOT-STORE", (self.directory / "inventory.json").read_text())
        self.assertTrue(all(command[0] in ("shell", "pull") for command in adb.calls))
        self.assertFalse(any(any(value in ("disable", "disable-user", "uninstall", "install", "set-home-activity") for value in command) for command in adb.calls))

    def test_failed_pull_is_partial_and_not_success(self):
        result, _ = self.run_backup(FakeAdb(fail_pull=True))
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["safeToProceed"])
        self.assertTrue(result["failures"])

    def test_inventory_only_is_explicit_and_never_allows_install_gate(self):
        result, adb = self.run_backup(inventory_only=True)
        self.assertEqual(result["status"], "inventory-only")
        self.assertFalse(result["safeToProceed"])
        self.assertFalse(any(command[0] == "pull" for command in adb.calls))

    def test_low_space_does_not_start_any_pull(self):
        with patch.object(backup.shutil, "disk_usage", return_value=SimpleNamespace(free=1024)):
            result, adb = self.run_backup()
        self.assertEqual(result["status"], "partial")
        self.assertFalse(any(command[0] == "pull" for command in adb.calls))

    def test_count_and_byte_limits_stop_before_pull(self):
        result, adb = self.run_backup(max_apks=1, max_total_bytes=1)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(any(command[0] == "pull" for command in adb.calls))

    def test_unsafe_remote_path_is_rejected_and_cannot_be_pulled(self):
        result, adb = self.run_backup(FakeAdb(unsafe_path=True))
        self.assertEqual(result["status"], "partial")
        self.assertFalse(any(";" in value for command in adb.calls for value in command))

    def test_ambiguous_home_is_not_fabricated(self):
        result, adb = self.run_backup(FakeAdb(missing_home=True))
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(result["homeComponent"])
        self.assertFalse(any(command[0] == "pull" for command in adb.calls))

    def test_serial_package_and_destination_validation(self):
        for serial in ["192.168.50.1;evil", "$(touch-x)", "-s", "name with space"]:
            with self.assertRaises(ValueError):
                backup.Adb("adb", serial)
        with self.assertRaises(ValueError):
            backup.Backup(FakeAdb(), self.directory, packages=["com.test;evil"])
        (self.directory / "keep.txt").write_text("existing")
        with self.assertRaises(ValueError):
            backup.prepare_destination(self.directory)
        self.assertEqual((self.directory / "keep.txt").read_text(), "existing")

    def test_real_process_boundary_preserves_argument_lists_without_local_shell(self):
        fake = Path(self.temporary.name) / "fake adb"
        fake.write_text("#!" + sys.executable + "\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n")
        fake.chmod(0o700)
        adb = backup.Adb(str(fake), "192.168.50.133:46277")
        result = adb.call(["shell", "getprop", "ro.product.model"])
        self.assertTrue(result.ok)
        self.assertEqual(json.loads(result.stdout), ["-s", "192.168.50.133:46277", "shell", "getprop", "ro.product.model"])

    def test_process_timeout_is_bounded_and_explicit(self):
        fake = Path(self.temporary.name) / "fake-slow-adb"
        fake.write_text("#!" + sys.executable + "\nimport time\ntime.sleep(10)\n")
        fake.chmod(0o700)
        result = backup.Adb(str(fake), "192.168.50.133:46277", command_timeout=1).call(["shell", "getprop", "ro.product.model"])
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "command timeout")


if __name__ == "__main__":
    unittest.main()
