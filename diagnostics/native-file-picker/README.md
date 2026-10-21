# Native document picker control

This diagnostic branch contains a standalone UIKit app with no WebKit, embedded Node runtime, backend, or third-party dependencies. It is not a product release or a replacement for the main application's validation gate.

The app creates one unique JSON in its own Documents directory after XCTest launches it and verifies the bytes by reading it back. XCTest opens and cancels the real system picker, verifies the cancellation delegate, then reopens it and touches that exact file. The selection must call `UIDocumentPickerDelegate` with a readable copy whose bytes match the source. A displayed filename, thumbnail, or QuickLook preview does not pass the test. Unexpected cancellation, missing callback, and read failures remain failures.

`UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace` match the product app. The picker uses `.json` and `asCopy: true`. CI uses one iPhone 16 Pro simulator on iOS 26.2 with Xcode 26.2, opens Simulator.app before boot, and builds unsigned. It does not download the server runtime or generate an IPA.

Run on that macOS/Xcode environment:

```sh
DEVELOPER_DIR=/Applications/Xcode_26.2.app/Contents/Developer python3 diagnostics/native-file-picker/run.py
```

The runner records command timeouts, actual runtime metadata, native callback results, XCTest attachments/accessibility trees, screenshots, and FileProvider/DocumentManager logs in `diagnostics/native-file-picker/build/report`. Every simulator created by the runner is stopped and deleted after evidence collection. Results are diagnostic evidence only; they do not establish physical-device compatibility.
