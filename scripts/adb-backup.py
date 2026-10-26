#!/usr/bin/env python3
"""Read-only Android TV snapshot and original HOME APK backup; Python stdlib only."""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import threading
import time

SERIAL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,254}\Z")
PACKAGE = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\Z")
COMPONENT = re.compile(r"([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/[A-Za-z0-9_.]+\Z")
APK_PATH = re.compile(r"/(?:system|system_ext|product|vendor|odm|oem|data/app)/[A-Za-z0-9_./+=@~:-]+\.apk\Z")
SETTINGS = {
    "system": ["screen_off_timeout", "screen_brightness", "screen_brightness_mode", "accelerometer_rotation", "user_rotation", "sound_effects_enabled"],
    "global": ["stay_on_while_plugged_in", "animator_duration_scale", "transition_animation_scale", "window_animation_scale", "hdmi_control_enabled", "hdmi_control_auto_device_off_enabled", "hdmi_control_auto_wakeup_enabled"],
    "secure": ["default_input_method", "enabled_input_methods", "accessibility_enabled", "enabled_accessibility_services", "screensaver_enabled", "screensaver_components", "screensaver_default_component", "user_setup_complete"],
}
MIN_FREE = 256 * 1024 * 1024
OUTPUT_LIMIT = 8 * 1024 * 1024


@dataclass
class Result:
    ok: bool
    stdout: str = ""
    reason: str = ""
    returncode: int = 0


class Adb:
    """Only shell reads and pull are exposed; never invokes a local shell."""
    def __init__(self, executable: str, serial: str, command_timeout: int = 20, pull_timeout: int = 120):
        if not SERIAL.fullmatch(serial):
            raise ValueError("Invalid ADB serial.")
        self.executable = executable
        self.serial = serial
        self.command_timeout = command_timeout
        self.pull_timeout = pull_timeout

    def call(self, parts: list[str]) -> Result:
        if not parts or parts[0] not in ("shell", "pull"):
            raise ValueError("Only read-only shell commands and pull are permitted.")
        command = [self.executable, "-s", self.serial, *parts]
        timeout = self.pull_timeout if parts[0] == "pull" else self.command_timeout
        try:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=False)
        except OSError:
            return Result(False, reason="ADB executable could not be started", returncode=-1)
        buffers = [bytearray(), bytearray()]
        exceeded = threading.Event()

        def drain(pipe, buffer):
            try:
                while True:
                    chunk = pipe.read(65536)
                    if not chunk:
                        break
                    if len(buffer) + len(chunk) > OUTPUT_LIMIT:
                        exceeded.set()
                        process.kill()
                        break
                    buffer.extend(chunk)
            finally:
                pipe.close()

        workers = [threading.Thread(target=drain, args=(pipe, buffer), daemon=True) for pipe, buffer in zip((process.stdout, process.stderr), buffers)]
        for worker in workers:
            worker.start()
        reason = ""
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            reason = "command timeout"
        for worker in workers:
            worker.join(timeout=5)
        if exceeded.is_set():
            reason = "command output limit"
        if not reason and process.returncode:
            reason = f"ADB exit code {process.returncode}"
        return Result(not reason, buffers[0].decode("utf-8", errors="replace"), reason, process.returncode)


def sha256(filename: Path) -> str:
    digest = hashlib.sha256()
    with filename.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_destination(destination: Path) -> Path:
    if destination.is_symlink():
        raise ValueError("Destination must not be a symbolic link.")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("Destination must be a new or empty directory.")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    if stat.S_IMODE(destination.stat().st_mode) & 0o077:
        raise ValueError("Destination filesystem does not enforce private directory permissions.")
    if shutil.disk_usage(destination).free < 1024 * 1024:
        raise ValueError("Not enough space even for an inventory.")
    return destination.resolve()


def components(text: str) -> list[str]:
    return sorted({line.strip() for line in text.splitlines() if COMPONENT.fullmatch(line.strip())})


def package_details(text: str) -> dict:
    """Keep version and per-user flags; discard the rest of dumpsys output."""
    details = {"users": {}}
    match = re.search(r"\bversionName=([^\s]+)", text)
    if match:
        details["versionName"] = match[1]
    match = re.search(r"\bversionCode=(\d+)", text)
    if match:
        details["versionCode"] = int(match[1])
    for match in re.finditer(r"^\s*User (\d+):([^\n]*)", text, re.MULTILINE):
        values = {}
        for key in ["installed", "hidden", "suspended", "stopped", "notLaunched", "instant", "virtual", "enabled"]:
            value = re.search(rf"\b{key}=(true|false|\d+)", match[2])
            if value:
                raw = value[1]
                values[key] = raw == "true" if raw in ("true", "false") else int(raw)
        details["users"][match[1]] = values
    return details


class Backup:
    def __init__(self, adb: Adb, destination: Path, packages: list[str] | None = None, inventory_only: bool = False,
                 max_apks: int = 32, max_total_bytes: int = 512 * 1024 * 1024):
        self.adb = adb
        self.destination = destination
        self.explicit_packages = packages or []
        if len(self.explicit_packages) > 16 or any(not PACKAGE.fullmatch(value) for value in self.explicit_packages):
            raise ValueError("Invalid package selection.")
        self.inventory_only = inventory_only
        self.max_apks = max_apks
        self.max_total_bytes = max_total_bytes
        self.failures = []
        self.commands = []
        self.apks = []
        self.data = {"schemaVersion": 1, "createdAt": datetime.now(timezone.utc).isoformat(), "serial": adb.serial,
                     "scope": "read-only settings/package inventory and selected original HOME APK files; not a firmware or private-data backup"}

    def write_json(self, filename: str, value):
        target = self.destination / filename
        target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        target.chmod(0o600)

    def write_text(self, filename: str, value: str):
        target = self.destination / filename
        target.write_text(value, encoding="utf-8")
        target.chmod(0o600)

    def call(self, label: str, args: list[str], mandatory: bool = True) -> str | None:
        started = time.monotonic()
        result = self.adb.call(args)
        self.commands.append({"label": label, "arguments": args, "ok": result.ok, "seconds": round(time.monotonic() - started, 3),
                              "reason": result.reason, "outputBytes": len(result.stdout.encode("utf-8"))})
        if not result.ok:
            if mandatory:
                self.failures.append(label + ": " + result.reason)
            return None
        return result.stdout.strip()

    def require(self, condition: bool, message: str):
        if not condition:
            self.failures.append(message)

    def snapshot(self):
        metadata = {}
        for key, prop in {"model": "ro.product.model", "manufacturer": "ro.product.manufacturer", "sdk": "ro.build.version.sdk",
                          "androidRelease": "ro.build.version.release", "fingerprint": "ro.build.fingerprint"}.items():
            metadata[key] = self.call("metadata-" + key, ["shell", "getprop", prop])
            self.require(bool(metadata[key]), "Missing device metadata: " + key)
        self.data["device"] = metadata
        raw_user = self.call("current-user", ["shell", "am", "get-current-user"])
        if not raw_user or not raw_user.isdecimal():
            self.failures.append("Current Android user could not be determined; no user number was assumed.")
            return
        user = int(raw_user)
        self.data["currentUser"] = user
        home_intent = ["--brief", "--user", str(user), "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"]
        resolved = self.call("home-resolver", ["shell", "cmd", "package", "resolve-activity", *home_intent])
        candidates = self.call("home-candidates", ["shell", "cmd", "package", "query-activities", *home_intent])
        resolved_components = components(resolved or "")
        home = resolved_components[0] if len(resolved_components) == 1 else None
        if home and (home.startswith("android/") or "ResolverActivity" in home):
            home = None
        self.data["home"] = {"component": home, "resolverOutput": resolved, "candidates": components(candidates or "")}
        self.require(bool(home), "No unique original HOME component was resolved.")
        self.require(bool(self.data["home"]["candidates"]), "No HOME candidates were captured.")
        package_list = self.call("package-versions-paths", ["shell", "pm", "list", "packages", "-f", "--show-versioncode", "--user", str(user)])
        self.require(bool(package_list and any(line.startswith("package:") for line in package_list.splitlines())), "Package/version inventory is empty or unsupported.")
        self.write_text("packages-versions-paths.txt", (package_list or "") + "\n")
        users = self.call("android-users", ["shell", "pm", "list", "users"])
        user_ids = sorted({int(value) for value in re.findall(r"UserInfo\{(\d+):", users or "")} | {user})
        self.require(bool(users and re.search(r"UserInfo\{\d+:", users)), "Android user inventory could not be parsed.")
        self.require(len(user_ids) <= 16, "Android user count exceeds safe backup limit.")
        self.data["users"] = user_ids[:16]
        for user_id in user_ids[:16]:
            for label, flags in [("installed", []), ("enabled", ["-e"]), ("disabled", ["-d"])]:
                result = self.call(f"packages-{label}-user-{user_id}", ["shell", "pm", "list", "packages", *flags, "--user", str(user_id)])
                self.write_text(f"packages-{label}-user-{user_id}.txt", (result or "") + "\n")
        settings = {}
        for namespace, keys in SETTINGS.items():
            settings[namespace] = {}
            for key in keys:
                value = self.call(f"setting-{namespace}-{key}", ["shell", "settings", "--user", str(user), "get", namespace, key])
                settings[namespace][key] = None if value == "null" else value
        self.data["settings"] = settings
        selected = sorted(set(self.explicit_packages + ([home.split("/", 1)[0]] if home else [])))
        self.data["selectedPackages"] = []
        plans = []
        for package in selected:
            dump = self.call("launcher-state-" + package, ["shell", "dumpsys", "package", package])
            details = package_details(dump or "")
            self.require(str(user) in details["users"], "Missing original per-user launcher state for " + package)
            details["package"] = package
            details["selection"] = "active HOME" if home and home.startswith(package + "/") else "explicit --package"
            path_output = self.call("launcher-paths-" + package, ["shell", "pm", "path", "--user", str(user), package])
            paths = [line[8:].strip() for line in (path_output or "").splitlines() if line.startswith("package:")]
            self.require(bool(paths), "No APK paths found for " + package)
            details["apkPaths"] = paths
            self.data["selectedPackages"].append(details)
            for remote in paths:
                if not APK_PATH.fullmatch(remote) or ".." in remote.split("/"):
                    self.failures.append("Unsafe or unsupported APK path rejected for " + package)
                    continue
                size_text = self.call("apk-size-" + package, ["shell", "stat", "-c", "%s", remote])
                if not size_text or not size_text.isdecimal() or int(size_text) <= 0:
                    self.failures.append("APK size could not be verified for " + package)
                    continue
                plans.append({"package": package, "remotePath": remote, "bytes": int(size_text)})
        self.require(bool(selected), "No original launcher or explicit package selected for APK backup.")
        self.data["plannedApks"] = plans

    def pull(self):
        plans = self.data.get("plannedApks", [])
        total = sum(item["bytes"] for item in plans)
        if not plans:
            self.failures.append("No verified launcher APKs available to pull.")
            return
        if len(plans) > self.max_apks or total > self.max_total_bytes:
            self.failures.append("APK count or total byte limit exceeded; no APK was pulled.")
            return
        if shutil.disk_usage(self.destination).free < total + MIN_FREE:
            self.failures.append("Insufficient destination free space; no APK was pulled. Use an explicit inventory-only run in a new directory if needed.")
            return
        for index, plan in enumerate(plans):
            if shutil.disk_usage(self.destination).free < plan["bytes"] + MIN_FREE:
                self.failures.append("Destination free-space reserve reached; remaining pulls stopped.")
                break
            directory = self.destination / "apks" / plan["package"]
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            basename = Path(plan["remotePath"]).name
            filename = directory / f"{index + 1:03d}-{basename}"
            result = self.call("pull-" + plan["package"], ["pull", plan["remotePath"], str(filename)])
            if result is None or not filename.is_file() or filename.is_symlink():
                self.failures.append("APK pull missing or failed for " + plan["package"])
                continue
            filename.chmod(0o600)
            if filename.stat().st_size != plan["bytes"]:
                self.failures.append("APK byte-size mismatch for " + plan["package"])
                continue
            self.apks.append({**plan, "file": str(filename.relative_to(self.destination)), "sha256": sha256(filename)})

    def restore_notes(self):
        home = self.data.get("home", {}).get("component")
        user = self.data.get("currentUser")
        content = "# Obnovení původního HOME\n\nTento soubor nic nespouští. Záloha není obraz firmwaru ani úplná záloha TV.\n\n"
        if home and user is not None:
            command = [self.adb.executable, "-s", self.adb.serial, "shell", "cmd", "package", "set-home-activity", "--user", str(user), home]
            content += f"Zachycený původní HOME: `{home}`, Android uživatel `{user}`.\n\nPo ověření stejné TV a dostupnosti původní aplikace lze vrátit výchozí HOME tímto příkazem:\n\n```sh\n{shlex.join(command)}\n```\n\n"
            start = [self.adb.executable, "-s", self.adb.serial, "shell", "am", "start", "--user", str(user), "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"]
            content += f"Poté ověřit původní obrazovku HOME:\n\n```sh\n{shlex.join(start)}\n```\n\n"
        else:
            content += "Původní HOME nebyl jednoznačně zachycen. Nelze bezpečně vygenerovat příkaz pro jeho návrat.\n\n"
        content += "Tento zálohovací skript původní launcher nevypíná, neodinstaluje a nemění jeho stav. Příkaz set-home-activity předpokládá, že původní aplikace stále existuje a je povolená. Pokud pozdější zásah změní její stav, nejprve porovnat zachycené selectedPackages/users v inventory.json; žádné univerzální hromadné pm enable/disable se nemá spouštět.\n\n"
        content += "APK soubory a splity jsou uložené s SHA-256 a velikostí. Jejich existence není záruka obnovy systémové aplikace na jiný firmware; instalace či install-multiple by vyžadovala samostatné ověření podpisu, verze a kompatibility. Nereinstalovat je rutinně při pouhém návratu HOME.\n\n"
        content += "Neobsahuje soukromá data aplikací, účty, hesla, DRM klíče, streamingové licence ani root/firmware oddíly. Vybraná nastavení jsou jen inventář, nepřehrávají se automaticky zpět. Před jakoukoliv další změnou ověřit status=complete a safeToProceed=true v manifest.json a kontrolní součty.\n"
        self.write_text("RESTORE.md", content)

    def run(self) -> dict:
        self.snapshot()
        snapshot_ok = not self.failures
        if not self.inventory_only:
            self.pull()
        self.data["commands"] = self.commands
        self.write_json("inventory.json", self.data)
        self.restore_notes()
        files = []
        for filename in sorted(self.destination.rglob("*")):
            if filename.is_file() and filename.name != "manifest.json":
                files.append({"file": str(filename.relative_to(self.destination)), "bytes": filename.stat().st_size, "sha256": sha256(filename)})
        complete = snapshot_ok and not self.failures and not self.inventory_only and bool(self.apks) and len(self.apks) == len(self.data.get("plannedApks", []))
        status = "complete" if complete else "inventory-only" if self.inventory_only and snapshot_ok else "partial"
        manifest = {"schemaVersion": 1, "createdAt": self.data["createdAt"], "status": status, "safeToProceed": complete,
                    "mandatorySnapshotComplete": snapshot_ok, "inventoryOnly": self.inventory_only,
                    "homeComponent": self.data.get("home", {}).get("component"), "currentUser": self.data.get("currentUser"),
                    "apks": self.apks, "files": files, "failures": self.failures,
                    "limitations": ["Not a firmware or full-device backup", "No app-private data, accounts, passwords or DRM keys", "APK recovery compatibility not proved by pull alone"]}
        self.write_json("manifest.json", manifest)
        return manifest


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adb", default="adb", help="Path to the already installed adb executable")
    parser.add_argument("--serial", required=True, help="One explicit, already connected/authorized ADB serial")
    parser.add_argument("--destination", required=True, type=Path, help="New or empty private backup directory")
    parser.add_argument("--package", action="append", default=[], help="Additional explicit package to back up (repeatable)")
    parser.add_argument("--inventory-only", action="store_true", help="No APK pull; always safeToProceed=false and exit 2")
    parser.add_argument("--max-apks", type=int, default=32)
    parser.add_argument("--max-total-mib", type=int, default=512)
    parser.add_argument("--command-timeout", type=int, default=20)
    parser.add_argument("--pull-timeout", type=int, default=120)
    args = parser.parse_args(argv)
    if not (1 <= args.max_apks <= 128 and 1 <= args.max_total_mib <= 2048 and 1 <= args.command_timeout <= 60 and 1 <= args.pull_timeout <= 300):
        parser.error("Invalid safety limit or timeout.")
    previous_umask = os.umask(0o077)
    try:
        adb = Adb(args.adb, args.serial, args.command_timeout, args.pull_timeout)
        if len(args.package) > 16 or any(not PACKAGE.fullmatch(value) for value in args.package):
            raise ValueError("Invalid package selection.")
        destination = prepare_destination(args.destination)
        backup = Backup(adb, destination, args.package, args.inventory_only, args.max_apks, args.max_total_mib * 1024 * 1024)
        result = backup.run()
        print(json.dumps({"status": result["status"], "safeToProceed": result["safeToProceed"], "destination": str(destination), "apks": len(result["apks"]), "failures": result["failures"]}, ensure_ascii=False))
        return 0 if result["status"] == "complete" else 2
    except (ValueError, OSError) as error:
        print("Backup stopped: " + str(error), file=sys.stderr)
        return 2
    finally:
        os.umask(previous_umask)


if __name__ == "__main__":
    raise SystemExit(main())
