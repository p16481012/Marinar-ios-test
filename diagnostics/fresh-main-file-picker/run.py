#!/usr/bin/env python3
"""One fresh-install file diagnostic of the real Marinar app; not the main validation gate."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

BASE_SHA = "c3ed42954c52c013e8495f5559c022e78fad58aa"
SOURCE_RUN = 39618057694
BUNDLE_ID = "com.p16481012.marinar.ios.test"
TESTS = ["testBlobDownloadShareAndFilePicker", "testSystemFilesProviderCanOpenFixture"]


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    if platform.system() != "Darwin" or os.environ.get("CI") != "true":
        raise SystemExit("This one-shot diagnostic requires a disposable macOS CI host.")
    root = Path(__file__).resolve().parents[2]
    output = root / "ios-app/build/fresh-picker/report"
    output.mkdir(parents=True, exist_ok=True)
    derived = root / "ios-app/build/fresh-picker/DerivedData"
    result = output / "fresh-picker.xcresult"
    report = {"scope": "fresh-install-native-file-path-only", "passed": False,
              "sourceCommit": os.environ.get("GITHUB_SHA"), "productionSourceCommit": BASE_SHA,
              "runtimeSourceRun": SOURCE_RUN, "startedAt": now(), "commands": [], "errors": [],
              "coverage": {"chat": False, "fullBackupRestore": False, "largeStreamedBackup": False,
                           "physicalDevice": False, "externalProvider": False},
              "installationPolicy": "No simctl install/launch or API seed; one XCTest session performs the first install"}
    device = None
    boot_requested = False

    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    def run(arguments, name, timeout=120, required=True):
        entry = {"name": name, "arguments": [str(v) for v in arguments],
                 "startedAt": now(), "timeoutSeconds": timeout}
        report["commands"].append(entry)
        save()
        started = time.monotonic()
        log = output / (name + ".log")
        try:
            with log.open("w", encoding="utf-8") as stream:
                process = subprocess.Popen(entry["arguments"], cwd=root, stdout=stream,
                                           stderr=subprocess.STDOUT, start_new_session=True, text=True)
                try:
                    process.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    entry["timedOut"] = True
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=5)
                entry["exitCode"] = process.returncode
            text = log.read_text(encoding="utf-8", errors="replace")
            failed = entry.get("timedOut", False) or process.returncode != 0
            if failed and required:
                detail = f"{name}: timeout after {timeout}s" if entry.get("timedOut") else f"{name}: exit {process.returncode}"
                report["errors"].append(detail)
                if arguments[0] == "xcodebuild":
                    print("\n".join(text.splitlines()[-60:]), flush=True)
                raise RuntimeError(detail)
            return text if not failed else None
        finally:
            entry["elapsedSeconds"] = round(time.monotonic() - started, 3)
            save()

    try:
        provenance = json.loads((output / "runtime-source-run.json").read_text())
        jobs = json.loads((output / "runtime-source-jobs.json").read_text())["jobs"]
        assert provenance["id"] == SOURCE_RUN and provenance["head_sha"] == BASE_SHA
        assert any(v["name"] == "Build and test packaged server" and v["conclusion"] == "success" for v in jobs)
        run(["git", "diff", "--exit-code", BASE_SHA, "--", "ios-app/App", "ios-app/Marinar.xcodeproj",
             "ios-app/Info.plist", "ios-app/scripts", "packages"], "production-source-identical")
        runtime_root = root / "ios-app/Resources/runtime"
        manifest = json.loads((runtime_root / "runtime-manifest.json").read_text())
        canonical = ""
        for entry in manifest["files"]:
            file = (runtime_root / entry["path"]).resolve()
            assert file.is_relative_to(runtime_root.resolve())
            contents = file.read_bytes()
            assert len(contents) == entry["size"] and hashlib.sha256(contents).hexdigest() == entry["sha256"]
            canonical += f'{entry["path"]}\t{entry["sha256"]}\t{entry["size"]}\n'
        assert hashlib.sha256(canonical.encode()).hexdigest() == manifest["deploymentId"]
        report["runtimeVerified"] = {"files": len(manifest["files"]), "deploymentId": manifest["deploymentId"],
                                     "sourceCommit": provenance["head_sha"]}
        report["xcode"] = run(["xcodebuild", "-version"], "xcode-version").strip()
        assert re.search(r"^Xcode 26\.2\s*$", report["xcode"], re.MULTILINE)
        report["simulatorSDK"] = run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], "sdk-version").strip()
        assert report["simulatorSDK"] == "26.2"
        # Preserve the current manual and xctestrun without changing test installation.
        developer = Path(os.environ["DEVELOPER_DIR"])
        manual = developer / "usr/share/man/man5/xcodebuild.xctestrun.5"
        report["xctestrunManualPath"] = str(manual)
        if manual.is_file():
            shutil.copy2(manual, output / "xcodebuild.xctestrun.5.txt")
        else:
            run(["man", "-P", "cat", "5", "xcodebuild.xctestrun"], "xctestrun-manual", required=False)
        runtimes = json.loads(run(["xcrun", "simctl", "list", "runtimes", "--json"], "runtime-list"))["runtimes"]
        runtime = next(v for v in runtimes if v.get("isAvailable") and v.get("version") == "26.2" and ".iOS-" in v["identifier"])
        report["runtime"] = runtime
        types = json.loads(run(["xcrun", "simctl", "list", "devicetypes", "--json"], "device-types"))["devicetypes"]
        device_type = next(v for v in types if v["name"] == "iPhone 16 Pro")
        device = run(["xcrun", "simctl", "create", "MarinarFreshFilePicker", device_type["identifier"], runtime["identifier"]], "create-device").strip()
        assert re.fullmatch(r"[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}", device)
        report["deviceID"] = device
        run(["defaults", "write", "com.apple.iphonesimulator", "ConnectHardwareKeyboard", "-bool", "false"], "global-keyboard")
        prefs = output / "keyboard.plist"
        run(["defaults", "export", "com.apple.iphonesimulator", str(prefs)], "keyboard-before")
        before = plistlib.loads(prefs.read_bytes())
        assert device not in before.get("DevicePreferences", {})
        run(["defaults", "write", "com.apple.iphonesimulator", "DevicePreferences", "-dict-add", device,
             "<dict><key>ConnectHardwareKeyboard</key><false/></dict>"], "device-keyboard")
        run(["defaults", "export", "com.apple.iphonesimulator", str(prefs)], "keyboard-after")
        after = plistlib.loads(prefs.read_bytes())
        assert after["ConnectHardwareKeyboard"] is False and after["DevicePreferences"][device]["ConnectHardwareKeyboard"] is False
        for key, value in before.get("DevicePreferences", {}).items():
            assert after["DevicePreferences"][key] == value
        report["keyboardPreferences"] = {"globalConnectHardwareKeyboard": False, "deviceConnectHardwareKeyboard": False}
        prefs.unlink()
        run(["open", "-a", str(developer / "Applications/Simulator.app"), "--args", "-CurrentDeviceUDID", device], "open-simulator")
        boot_requested = True
        run(["xcrun", "simctl", "boot", device], "boot-device", required=False)
        run(["xcrun", "simctl", "bootstatus", device, "-b"], "boot-status", timeout=480)
        common = ["-project", str(root / "ios-app/Marinar.xcodeproj"), "-scheme", "Marinar", "-configuration", "Debug",
                  "-destination", f"platform=iOS Simulator,id={device}", "-derivedDataPath", str(derived),
                  "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY="]
        run(["xcodebuild", "build-for-testing", *common], "build-for-testing", timeout=900)
        for file in sorted((derived / "Build/Products").glob("*.xctestrun")):
            shutil.copy2(file, output / file.name)
        run(["xcrun", "simctl", "listapps", device], "apps-before-first-xctest")
        # simctl emits an OpenStep property list; Python plistlib only reads XML/binary.
        installed = json.loads(run(["plutil", "-convert", "json", "-o", "-",
                                    str(output / "apps-before-first-xctest.log")], "apps-before-first-xctest-json"))
        assert BUNDLE_ID not in installed, "App was already installed before the only XCTest session"
        report["appAbsentBeforeXCTest"] = True
        report["singleXCTestSessionStartedAt"] = now()
        # No target preinstall, launch, server seeding or restore precedes this command.
        run(["xcodebuild", "test-without-building", *common, "-parallel-testing-enabled", "NO",
             "-maximum-concurrent-test-simulator-destinations", "1", "-resultBundlePath", str(result),
             *[f"-only-testing:MarinarUITests/MarinarUITests/{test}" for test in TESTS]], "file-ui-tests", timeout=900)
        report["xcodebuildSucceeded"] = True
    except Exception as error:
        report["failure"] = str(error)
    finally:
        if device and boot_requested:
            container_text = run(["xcrun", "simctl", "get_app_container", device, BUNDLE_ID, "data"], "app-container", required=False)
            if container_text:
                container = Path(container_text.strip())
                report["dataContainerAfterXCTest"] = str(container)
                for filename in ["ios-export-events.json", "ios-download-result.json"]:
                    file = container / "Documents" / filename
                    if file.is_file():
                        shutil.copy2(file, output / filename)
                try:
                    # Read-only observation after both tests; never log or persist the boot token.
                    config = json.loads((container / "Library/Application Support/launch-config.json").read_text())
                    request = urllib.request.Request(f'http://127.0.0.1:{int(config["port"])}/api/ios/health',
                                                     headers={"x-marinara-ios-token": config["token"]})
                    with urllib.request.urlopen(request, timeout=5) as response:
                        health = json.load(response)
                    report["healthAfterXCTest"] = {key: health.get(key) for key in ["ready", "deploymentId", "version", "nodeVersion", "platform"]}
                except Exception as error:
                    report["healthAfterXCTestObservation"] = type(error).__name__
            run(["xcrun", "simctl", "io", device, "screenshot", str(output / "final-screen.png")], "final-screenshot", required=False)
            predicate = ('process == "Marinar" OR process == "fileproviderd" OR process CONTAINS[c] "DocumentManager" OR '
                         'process CONTAINS[c] "Spotlight" OR subsystem CONTAINS[c] "FileProvider" OR subsystem CONTAINS[c] "DocumentManager"')
            run(["xcrun", "simctl", "spawn", device, "log", "show", "--last", "25m", "--style", "compact", "--predicate", predicate],
                "file-provider", timeout=180, required=False)
        if result.exists():
            run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result), "--output-path", str(output / "attachments")],
                "export-attachments", timeout=180, required=False)
            run(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(result)], "test-summary", required=False)
        test_log = output / "file-ui-tests.log"
        if test_log.is_file():
            text = test_log.read_text(encoding="utf-8", errors="replace")
            report["tests"] = {name: "passed" if re.search(r"Test Case '.* " + name + r"\]' passed", text) else "not-passed" for name in TESTS}
        try:
            events = json.loads((output / "ios-export-events.json").read_text())
            created = [v for v in events if v.get("event") == "import-fixture-created"]
            reused = [v for v in events if v.get("event") == "import-fixture-reused"]
            fixture_verified = (len(created) == 1 and len(reused) == 1
                                and created[0].get("filename") == reused[0].get("filename")
                                and created[0].get("reused") is False and reused[0].get("reused") is True
                                and all(v.get("bytes") == 72 and v.get("verified") is True for v in [*created, *reused]))
            downloads = json.loads((output / "ios-download-result.json").read_text())
            expected = '{"fixture":"marinar-ios","text":"파일 내보내기"}'.encode()
            blob_verified = (len(downloads) == 1 and downloads[0].get("filename") == "marinar-ios-export.json"
                             and downloads[0].get("size") == len(expected)
                             and downloads[0].get("sha256") == hashlib.sha256(expected).hexdigest())
            report["nativeEvidence"] = {"sameVerifiedFixtureReused": fixture_verified, "smallBlobBytesMatch": blob_verified,
                                        "fixtureFilename": created[0].get("filename") if created else None}
        except (ValueError, OSError, TypeError, KeyError) as error:
            report["nativeEvidenceError"] = type(error).__name__
        evidence = report.get("nativeEvidence", {})
        report["passed"] = (report.get("xcodebuildSucceeded", False)
                            and all(report.get("tests", {}).get(name) == "passed" for name in TESTS)
                            and evidence.get("sameVerifiedFixtureReused") is True
                            and evidence.get("smallBlobBytesMatch") is True)
        if report["passed"]:
            report["coverage"].update({"actualEmbeddedNodeAndWKWebViewReady": True, "htmlFilePickerCancel": True,
                                       "htmlFilePickerReadText": True, "sameFixtureFilesQuickLookExactText": True,
                                       "smallBlobExportAndNativeShare": True, "nativeDialogs": True})
        if device:
            if boot_requested:
                run(["xcrun", "simctl", "shutdown", device], "shutdown-device", required=False)
            run(["xcrun", "simctl", "delete", device], "delete-device", required=False)
        report["finishedAt"] = now()
        save()
        print(json.dumps({"passed": report["passed"], "scope": report["scope"], "tests": report.get("tests"),
                          "failure": report.get("failure"), "report": str(output / "report.json")}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
