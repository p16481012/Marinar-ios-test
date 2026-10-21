#!/usr/bin/env python3
"""One UIKit/NodeMobile linked control with cold Node-off and Node-on tests."""
import argparse
import datetime
import hashlib
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

BASE_SHA = "cd85475f"
NODE_SHA = "f21ba80d2fa3d1fc313c48567576605209c07f41be66282ce7e0d687f2f42bd9"
TESTS = {"node-off": "testNodeNotStartedDocumentPickerReturnsExactCreatedBytes",
         "node-on": "testNodeStartedDocumentPickerReturnsExactCreatedBytes"}


def validate_native(native, mode):
    started = mode == "node-on"
    ready = native.get("runtimeReady", {})
    startup_verified = all([
        native.get("mode") == mode, isinstance(native.get("pid"), int), native.get("pid", 0) > 0,
        native.get("nodeStartRequested") is started, native.get("nodeStartInvoked") is started,
        native.get("plainUIWindow") is True, native.get("webKitUsed") is False,
        ready.get("ready") is True, ready.get("mode") == mode, ready.get("pid") == native.get("pid"),
        ready.get("cwd") == native.get("workingDirectory"), ready.get("nodeStartInvoked") is started,
        "nodeExitCode" not in native,
        ready.get("nodeVersion") == "v24.22.0" if started else "nodeVersion" not in ready])
    filename = native.get("fixtureFilename", "")
    match = re.fullmatch(r"native-picker-([0-9a-f]{8})\.json", filename)
    expected = ('{"fixture":"native-uidocumentpicker","nonce":"' + match.group(1)
                + '","text":"실제 파일 선택 확인"}\n') if match else None
    bytes_verified = all([
        native.get("sourceReadbackMatches") is True, native.get("phase") == "bytes-match",
        native.get("cancelCallbackCount") == 1, native.get("delegateCallbackCount") == 1,
        native.get("returnedURLCount") == 1, native.get("bytesMatch") is True,
        native.get("filenameMatches") is True, expected is not None,
        native.get("actualText") == expected, native.get("expectedText") == expected,
        Path(native.get("returnedURL", "")).name == filename,
        native.get("actualBytes") == len(expected.encode()) if expected else False,
        native.get("expectedBytes") == len(expected.encode()) if expected else False])
    return {"startupVerified": startup_verified, "nativeBytesVerified": bytes_verified}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report-dir", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    output = (args.report_dir or root / "build" / "report").resolve()
    if platform.system() != "Darwin" or os.environ.get("CI") != "true":
        parser.error("This control requires a disposable macOS CI host, Xcode 26.2 and iOS 26.2 Simulator.")
    output.mkdir(parents=True, exist_ok=True)
    report = {"startedAt": now(), "passed": False, "commands": [], "errors": [],
              "control": "UIKit UIDocumentPicker with identical linked NodeMobile: node_start off versus minimal timer on; no WebKit/server",
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
                if arguments[0] == "xcodebuild":
                    print("\n".join(text.splitlines()[-60:]), flush=True)
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
        repo = root.parents[1]
        run(["git", "diff", "--exit-code", BASE_SHA, "--", "../../ios-app", "../../packages"], "product-source-identical")
        metadata = json.loads((repo / "ios-app/Vendor/node-source.json").read_text())
        assert metadata["version"] == "24.22.0-0" and metadata["sha256"] == NODE_SHA
        archive = repo / "ios-app/.cache/nodejs-mobile-ios-24.22.0-0.zip"
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == NODE_SHA
        report["nodeFrameworkSource"] = metadata
        report["nodeBridgeSHA256"] = hashlib.sha256((repo / "ios-app/App/NodeBridge.mm").read_bytes()).hexdigest()
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
        device = run(["xcrun", "simctl", "create", "NativePickerNodeToggle", device_type["identifier"], runtime["identifier"]], "create-device").strip()
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
        if "@rpath/NodeMobile.framework/NodeMobile" not in report["linkedLibraries"] or "WebKit.framework" in report["linkedLibraries"]:
            raise RuntimeError("Both control modes must link the same NodeMobile without WebKit")
        embedded_node = executable.parent / "Frameworks/NodeMobile.framework/NodeMobile"
        assert embedded_node.is_file(), "The pinned NodeMobile must be embedded as well as linked"
        binaries.append(embedded_node)
        report["binarySHA256BeforeTests"] = {str(p.relative_to(executable.parent)): hashlib.sha256(p.read_bytes()).hexdigest() for p in binaries}
        # One install/session and one binary. Each XCTest cold-launches separately;
        # a failed assertion stops that case but does not skip the second case.
        run(["xcodebuild", "test-without-building", *common, "-resultBundlePath", str(result),
             "-test-timeouts-enabled", "YES", "-default-test-execution-time-allowance", "300",
             "-maximum-test-execution-time-allowance", "360",
             *[f"-only-testing:NativePickerUITests/NativePickerUITests/{test}" for test in TESTS.values()]],
            "ui-test", timeout=1080, required=False)
        report["binarySHA256AfterTests"] = {str(p.relative_to(executable.parent)): hashlib.sha256(p.read_bytes()).hexdigest() for p in binaries}
        assert report["binarySHA256BeforeTests"] == report["binarySHA256AfterTests"]
    except Exception as error:
        report["failure"] = str(error)
    finally:
        # Collect native state even on failed assertions. Listing/QuickLook never count as success.
        if device and boot_requested:
            container = run(["xcrun", "simctl", "get_app_container", device, "com.p16481012.nativepicker.control", "data"], "app-container", required=False)
            if container:
                report["modes"] = {}
                support = Path(container.strip()) / "Library/Application Support"
                for mode in TESTS:
                    entry = report["modes"][mode] = {"nativeBytesVerified": False, "startupVerified": False}
                    for kind in ["result", "ready"]:
                        file = support / f"native-picker-{kind}-{mode}.json"
                        if file.is_file():
                            shutil.copy2(file, output / file.name)
                    app_result = support / f"native-picker-result-{mode}.json"
                    try:
                        native = json.loads(app_result.read_text(encoding="utf-8"))
                        entry["nativeResult"] = native
                        entry.update(validate_native(native, mode))
                    except (ValueError, OSError) as error:
                        entry["resultError"] = str(error)
                        report["errors"].append(f"{mode} native result: {error}")
                off = report["modes"]["node-off"].get("nativeResult", {})
                on = report["modes"]["node-on"].get("nativeResult", {})
                report["distinctColdProcesses"] = isinstance(off.get("pid"), int) and isinstance(on.get("pid"), int) and off["pid"] != on["pid"]
                report["sameWorkingDirectory"] = bool(off.get("workingDirectory")) and off.get("workingDirectory") == on.get("workingDirectory")
                report["sameExecutablePath"] = bool(off.get("executablePath")) and off.get("executablePath") == on.get("executablePath")
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
        test_log = output / "ui-test.log"
        if test_log.is_file():
            log = test_log.read_text(encoding="utf-8", errors="replace")
            report["tests"] = {mode: "passed" if re.search(r"Test Case '.* " + test + r"\]' passed", log) else "not-passed"
                               for mode, test in TESTS.items()}
        command = next((v for v in report["commands"] if v["name"] == "ui-test"), {})
        report["passed"] = (command.get("exitCode") == 0 and not command.get("timedOut", False)
                            and report.get("distinctColdProcesses") is True
                            and report.get("sameWorkingDirectory") is True and report.get("sameExecutablePath") is True
                            and report.get("binarySHA256BeforeTests") == report.get("binarySHA256AfterTests")
                            and all(report.get("tests", {}).get(mode) == "passed"
                                    and report.get("modes", {}).get(mode, {}).get("startupVerified") is True
                                    and report.get("modes", {}).get(mode, {}).get("nativeBytesVerified") is True for mode in TESTS))
        report["finishedAt"] = now()
        save()
        print(json.dumps({"passed": report["passed"], "failure": report.get("failure"),
                          "tests": report.get("tests"), "modes": {key: value.get("nativeResult", {}).get("phase") for key, value in report.get("modes", {}).items()},
                          "report": str(output / "report.json")}, indent=2))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
