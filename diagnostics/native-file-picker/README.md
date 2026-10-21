# Native document picker with Node startup control

This diagnostic branch extends the successful standalone UIKit control at `cd85475f`. Both modes use one identical app binary linked to the production NodeMobile framework and original NodeBridge. One cold app process never calls `node_start`; a second cold process calls it with a minimal script that writes one private readiness record and runs an empty timer. Neither mode uses WebKit or a server. It is not a product release or a replacement for the main application's validation gate.

Each process uses the same private AppSupport working directory and readiness-file protocol, then creates one unique JSON in Documents and verifies its bytes by reading it back. XCTest opens and cancels the real system picker, verifies the cancellation delegate, then reopens it and touches that exact file. The selection must call `UIDocumentPickerDelegate` with a readable copy whose filename and bytes match the source. A displayed filename, thumbnail, or QuickLook preview does not pass. Each testcase and native result are recorded separately; a failed or unexecuted mode remains a failure.

`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` match the product app. The picker uses `.json` and `asCopy: true`. CI uses one iPhone 16 Pro simulator on iOS 26.2 with Xcode 26.2, opens Simulator.app before boot, builds once, and runs both testcases in one XCTest session with explicit app termination between cases. It downloads only the pinned NodeMobile archive, verifies its SHA256, and audits the app executable and Debug dylib with `otool`; no server runtime or IPA is generated.

Run on that macOS/Xcode environment:

```sh
node ios-app/scripts/download-node.mjs
CI=true DEVELOPER_DIR=/Applications/Xcode_26.2.app/Contents/Developer python3 diagnostics/native-file-picker/run.py
```

The runner records distinct process IDs, matching working directories, Node-on's actual JavaScript readiness/version, unchanged binary hashes, both native callback results, XCTest attachments, screenshots, and FileProvider logs in `diagnostics/native-file-picker/build/report`. Readiness and callback JSON live in private AppSupport; the timer performs no ongoing writes. Every simulator is stopped and deleted after evidence collection. Results are diagnostic evidence only; they do not establish physical-device compatibility.
