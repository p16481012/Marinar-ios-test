import XCTest

final class NativePickerUITests: XCTestCase {
    private let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        if app.state != .notRunning { app.terminate() }
    }

    override func tearDownWithError() throws {
        evidence("final")
        if app.state != .notRunning { app.terminate() }
    }

    private func evidence(_ name: String) {
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-accessibility"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    func testNodeNotStartedDocumentPickerReturnsExactCreatedBytes() throws {
        assertDocumentPickerRoundTrip(startNode: false)
    }

    func testNodeStartedDocumentPickerReturnsExactCreatedBytes() throws {
        assertDocumentPickerRoundTrip(startNode: true)
    }

    private func assertDocumentPickerRoundTrip(startNode: Bool) {
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["NATIVE_PICKER_START_NODE"] = startNode ? "1" : "0"
        app.launch()
        let status = app.staticTexts["picker-status"]
        XCTAssertTrue(status.waitForExistence(timeout: 30), "Native app did not launch")
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'fixture-ready'"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 90), .completed, "Runtime and fixture readiness failed")
        let filename = app.staticTexts["fixture-filename"].label
        XCTAssertNotNil(filename.range(of: "^native-picker-[0-9a-f]{8}\\.json$", options: .regularExpression))
        let stem = (filename as NSString).deletingPathExtension
        evidence("fixture-ready")

        app.buttons["open-picker"].tap()
        let cancel = app.buttons["Cancel"].firstMatch
        XCTAssertTrue(cancel.waitForExistence(timeout: 90), "Native UIDocumentPicker did not become ready")
        evidence("picker-ready")
        cancel.tap()
        let cancelled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'cancelled'"), object: status)
        XCTAssertEqual(XCTWaiter.wait(for: [cancelled], timeout: 15), .completed, "Native cancellation delegate was not called")
        XCTAssertTrue(app.buttons["open-picker"].isHittable, "Cancelling did not return to the native app")
        evidence("cancel-callback-confirmed")
        app.buttons["open-picker"].tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 90), "Reopened UIDocumentPicker did not become ready")
        evidence("picker-reopened")
        // The presenting native filename label remains in the AX tree behind the sheet.
        // Search only the real File View collection observed in the system picker.
        let fileView = app.collectionViews["File View"].firstMatch
        XCTAssertTrue(fileView.waitForExistence(timeout: 15), "System Files collection is missing")
        let fixture = fileView.staticTexts.matching(NSPredicate(format: "label == %@ OR label == %@", filename, stem)).firstMatch
        if !fixture.waitForExistence(timeout: 3) {
            for _ in 0..<5 {
                let location = app.staticTexts.matching(NSPredicate(format: "label == 'On My iPhone' OR label == 'On My iPad'")).firstMatch
                if location.exists && location.isHittable { location.tap(); break }
                let back = app.navigationBars.buttons.matching(NSPredicate(format: "(label == 'Browse' OR label == 'Locations' OR label == 'Back') AND enabled == true")).firstMatch
                let browse = app.buttons["Browse"].firstMatch
                if back.exists && back.isHittable { back.tap() }
                else if browse.exists && browse.isEnabled && browse.isHittable { browse.tap() }
                else { break }
            }
            let folder = app.staticTexts["Native Picker Control"].firstMatch
            XCTAssertTrue(folder.waitForExistence(timeout: 20), "Exact app Documents folder was not available")
            folder.tap()
        }
        XCTAssertTrue(fixture.waitForExistence(timeout: 30), "App-created JSON is absent from the system picker")
        let cell = fileView.cells.containing(.staticText, identifier: fixture.label).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 10), "The exact fixture file cell was not available")
        XCTAssertTrue(cell.isEnabled, "The JSON content type was rejected")
        evidence("before-real-file-touch")
        let thumbnail = cell.images.firstMatch
        if thumbnail.exists {
            let frame = thumbnail.frame
            XCTAssertTrue(frame.width > 0 && frame.height > 0 && cell.frame.contains(frame) && fileView.frame.contains(frame) && app.frame.contains(frame))
            let coordinate = thumbnail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            XCTAssertTrue(frame.contains(coordinate.screenPoint), "Touch lies outside the observed file thumbnail")
            let geometry = XCTAttachment(string: "thumbnail=\(frame); touch=\(coordinate.screenPoint); filename=\(filename)")
            geometry.name = "real-file-touch-geometry"
            geometry.lifetime = .keepAlways
            add(geometry)
            coordinate.tap()
        } else {
            XCTAssertTrue(cell.isHittable)
            cell.tap()
        }
        evidence("after-real-file-touch")
        let open = app.buttons["Open"].firstMatch
        if open.waitForExistence(timeout: 5) && open.isEnabled && open.isHittable { open.tap() }
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'bytes-match'"), object: status)
        let result = XCTWaiter.wait(for: [completed], timeout: 45)
        evidence("delegate-result")
        XCTAssertEqual(result, .completed,
                       "Expected real delegate callback and exact source bytes; current native status=\(status.exists ? status.label : "not-visible"). Cancellation, missing callback, and read errors are separate failures.")
        XCTAssertFalse(cancel.exists, "System picker remained visible after success")
        XCTAssertTrue(app.buttons["open-picker"].isHittable, "Native app did not regain interaction after selection")
    }
}
