#!/usr/bin/env python3
"""One bounded native UIDocumentPicker baseline. Python standard library only."""
import argparse
import datetime
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys
import time


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = (args.report_dir or root / "build" / "report").resolve()
    if platform.system() != "Darwin":
        parser.error("This control requires macOS, Xcode 26.2 and iOS 26.2 Simulator.")
    output.mkdir(parents=True, exist_ok=True)
    report = {"startedAt": now(), "passed": False, "commands": [], "errors": [],
              "control": "UIKit UIDocumentPicker; no WebKit or embedded Node",
              "sourceCommit": os.environ.get("GITHUB_SHA"), "simulatorUI": True}
    device = None
    boot_requested = False
    derived = root / "build" / "DerivedData"
    result = output / "native-picker.xcresult"

    def save():
        (output / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    def run(arguments, name, timeout=90, required=True):
        entry = {"name": name, "arguments": [str(v) for v in arguments],
                 "timeoutSeconds": timeout, "startedAt": now()}
        report["commands"].append(entry)
        save()
        started = time.monotonic()
        log = output / (name + ".log")
        try:
            with log.open("w", encoding="utf-8") as stream:
                process = subprocess.Popen(entry["arguments"], stdout=stream, stderr=subprocess.STDOUT,
                                           cwd=root, start_new_session=True, text=True)
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
            if failed:
                detail = f"{name}: timeout after {timeout}s" if entry.get("timedOut") else f"{name}: exit {process.returncode}"
                report["errors"].append(detail)
                if required:
                    raise RuntimeError(detail)
            return text if not failed else None
        except OSError as error:
            entry["error"] = str(error)
            report["errors"].append(f"{name}: {error}")
            if required:
                raise
            return None
        finally:
            entry["elapsedSeconds"] = round(time.monotonic() - started, 3)
            save()

    try:
        report["xcode"] = run(["xcodebuild", "-version"], "xcode-version").strip()
        if not re.search(r"^Xcode 26\.2\s*$", report["xcode"], re.MULTILINE):
            raise RuntimeError("This control requires the specified Xcode 26.2 baseline")
        report["simulatorSDK"] = run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-version"], "sdk-version").strip()
        runtimes = json.loads(run(["xcrun", "simctl", "list", "runtimes", "--json"], "runtime-list"))["runtimes"]
        runtime = next((v for v in runtimes if v.get("isAvailable") and v.get("version") == "26.2" and ".iOS-" in v["identifier"]), None)
        if runtime is None:
            raise RuntimeError("Installed iOS 26.2 runtime was not found; no alternative is selected")
        report["runtime"] = runtime
        types = json.loads(run(["xcrun", "simctl", "list", "devicetypes", "--json"], "device-types"))["devicetypes"]
        device_type = next((v for v in types if v.get("name") == "iPhone 16 Pro"), None)
        if device_type is None:
            raise RuntimeError("The iPhone 16 Pro device type is unavailable")
        report["deviceType"] = device_type
        device = run(["xcrun", "simctl", "create", "NativePickerControl", device_type["identifier"], runtime["identifier"]], "create-device").strip()
        if not re.fullmatch(r"[A-Fa-f0-9-]{36}", device):
            raise RuntimeError("simctl did not return a valid device identifier")
        report["deviceID"] = device
        developer = Path(os.environ.get("DEVELOPER_DIR") or run(["xcode-select", "-p"], "developer-dir").strip())
        simulator_app = developer / "Applications" / "Simulator.app"
        if not simulator_app.is_dir():
            raise RuntimeError(f"Simulator.app missing from selected Xcode: {simulator_app}")
        run(["open", "-a", str(simulator_app), "--args", "-CurrentDeviceUDID", device], "open-simulator")
        boot_requested = True
        # Simulator.app may already have started this UUID. bootstatus remains required.
        run(["xcrun", "simctl", "boot", device], "boot-device", required=False)
        run(["xcrun", "simctl", "bootstatus", device, "-b"], "boot-status", timeout=480)
        common = ["-project", str(root / "NativePicker.xcodeproj"), "-scheme", "NativePicker", "-configuration", "Debug",
                  "-destination", f"platform=iOS Simulator,id={device}", "-derivedDataPath", str(derived),
                  "-parallel-testing-enabled", "NO", "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "CODE_SIGN_IDENTITY="]
        run(["xcodebuild", "build-for-testing", *common], "build-for-testing", timeout=480)
        executable = derived / "Build" / "Products" / "Debug-iphonesimulator" / "NativePicker.app" / "NativePicker"
        # Xcode 26 places Debug app code in a sibling .debug.dylib; inspect that too.
        binaries = [executable, *sorted(executable.parent.glob("*.dylib"))]
        report["inspectedBinaries"] = [p.name for p in binaries]
        report["linkedLibraries"] = run(["otool", "-L", *[str(p) for p in binaries]], "linked-libraries").strip()
        if "NodeMobile" in report["linkedLibraries"] or "WebKit.framework" in report["linkedLibraries"]:
            raise RuntimeError("The control unexpectedly links NodeMobile or WebKit")
        # XCTest installs/launches the app before the app creates its unique fixture.
        run(["xcodebuild", "test-without-building", *common, "-resultBundlePath", str(result),
             "-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "300",
             "-maximum-test-execution-time-allowance", "360",
             "-only-testing:NativePickerUITests/NativePickerUITests/testNativeDocumentPickerReturnsExactCreatedBytes"],
            "ui-test", timeout=600)
        report["xctestPassed"] = True
    except Exception as error:
        report["failure"] = str(error)
    finally:
        # Collect native state even on failed assertions. Listing/QuickLook never count as success.
        if device and boot_requested:
            container = run(["xcrun", "simctl", "get_app_container", device, "com.p16481012.nativepicker.control", "data"], "app-container", required=False)
            if container:
                app_result = Path(container.strip()) / "Library" / "Application Support" / "native-picker-result.json"
                if app_result.is_file():
                    shutil.copy2(app_result, output / "native-picker-result.json")
                    try:
                        native = json.loads(app_result.read_text(encoding="utf-8"))
                        report["nativeResult"] = native
                        report["nativeBytesVerified"] = all([
                            native.get("sourceReadbackMatches") is True, native.get("phase") == "bytes-match",
                            native.get("cancelCallbackCount") == 1, native.get("delegateCallbackCount") == 1,
                            native.get("returnedURLCount") == 1, native.get("bytesMatch") is True,
                            native.get("filenameMatches") is True, native.get("actualText") == native.get("expectedText"),
                            native.get("actualBytes") == native.get("expectedBytes")])
                    except (ValueError, OSError) as error:
                        report["errors"].append(f"native result: {error}")
            run(["xcrun", "simctl", "io", device, "screenshot", str(output / "final-screen.png")], "final-screenshot", timeout=45, required=False)
            predicate = ('process == "NativePicker" OR process == "fileproviderd" OR process CONTAINS[c] "DocumentManager" OR '
                         'process CONTAINS[c] "Spotlight" OR subsystem CONTAINS[c] "FileProvider" OR subsystem CONTAINS[c] "DocumentManager"')
            run(["xcrun", "simctl", "spawn", device, "log", "show", "--last", "25m", "--style", "compact", "--predicate", predicate],
                "file-provider", timeout=90, required=False)
        if result.exists():
            run(["xcrun", "xcresulttool", "export", "attachments", "--path", str(result), "--output-path", str(output / "attachments")],
                "export-attachments", timeout=90, required=False)
            run(["xcrun", "xcresulttool", "get", "test-results", "summary", "--path", str(result)], "test-summary", timeout=60, required=False)
        if device:
            if boot_requested:
                run(["xcrun", "simctl", "shutdown", device], "shutdown-device", timeout=45, required=False)
            run(["xcrun", "simctl", "delete", device], "delete-device", timeout=45, required=False)
        report["passed"] = report.get("xctestPassed", False) and report.get("nativeBytesVerified", False)
        report["finishedAt"] = now()
        save()
        print(json.dumps({"passed": report["passed"], "failure": report.get("failure"),
                          "nativePhase": report.get("nativeResult", {}).get("phase"), "report": str(output / "report.json")}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
