import XCTest

final class MarinarUITests: XCTestCase {
    private let app = XCUIApplication()
    private let prompt = "[IOS_STREAM_TEST] Hello. Please remember the blue lantern."
    private let reply = "The blue lantern is remembered."

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["MARINARA_TEST_DIAGNOSTICS"] = "1"
    }

    override func tearDownWithError() throws {
        if (testRun?.failureCount ?? 0) > 0 {
            attachScreen("failure-\(name)")
            let hierarchy = XCTAttachment(string: app.debugDescription)
            hierarchy.name = "failure-accessibility-hierarchy"
            hierarchy.lifetime = .keepAlways
            add(hierarchy)
        }
    }

    private func launchReady() {
        app.launch()
        let webView = app.webViews["marinar-webview"]
        XCTAssertTrue(webView.waitForExistence(timeout: 300), "WKWebView did not appear")
        let predicate = NSPredicate(format: "value == %@", "ready")
        expectation(for: predicate, evaluatedWith: webView)
        waitForExpectations(timeout: 300)
    }

    private func attachScreen(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testSendPersistsAfterProcessRelaunch() throws {
        launchReady()
        let input = app.webViews.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 60), "Actual chat composer missing after fixture chat selection")
        input.tap()
        input.typeText(prompt)
        let send = app.webViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15))
        XCTAssertTrue(send.isEnabled)
        XCTAssertTrue(send.isHittable, "Send is covered by the keyboard or outside the safe area")
        assertComposerAboveKeyboard(input)
        send.tap()
        let response = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", reply)).firstMatch
        XCTAssertTrue(response.waitForExistence(timeout: 90), "Real UI send did not display the mock provider response")
        attachScreen("chat-generated")
        // Backgrounding gives the native lifecycle hook an opportunity to flush.
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.terminate()
        launchReady()
        let restored = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", reply)).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 60), "Saved response missing after app process relaunch")
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Please remember the blue lantern.")).firstMatch.exists)
        attachScreen("chat-restored")
    }

    private func assertComposerAboveKeyboard(_ input: XCUIElement) {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15), "The software keyboard is not visible")
        if keyboard.exists {
            XCTAssertLessThanOrEqual(input.frame.maxY, keyboard.frame.minY + 2,
                                     "The software keyboard covers the chat composer")
        }
        let web = app.webViews["marinar-webview"]
        XCTAssertGreaterThanOrEqual(input.frame.minX, web.frame.minX - 2)
        XCTAssertLessThanOrEqual(input.frame.maxX, web.frame.maxX + 2)
    }

    func testComposerAcrossOrientations() throws {
        launchReady()
        let input = app.webViews.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 60))
        input.tap()
        input.typeText("Layout check")
        assertComposerAboveKeyboard(input)
        XCTAssertTrue(app.webViews.buttons["Send"].firstMatch.isHittable)
        attachScreen("composer-portrait-keyboard")
        XCUIDevice.shared.orientation = .landscapeLeft
        let send = app.webViews.buttons["Send"].firstMatch
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: send)
        waitForExpectations(timeout: 20)
        assertComposerAboveKeyboard(input)
        attachScreen("composer-landscape-keyboard")
        XCUIDevice.shared.orientation = .portrait
    }

    func testBlobDownloadShareAndFilePicker() throws {
        app.launchEnvironment["MARINARA_TEST_FILE_PANEL"] = "1"
        launchReady()
        let export = app.webViews.buttons["Export test JSON"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 30))
        export.tap()
        dismissExportShare("blob-export-share")
        XCTAssertTrue(export.waitForExistence(timeout: 15))
        let streamed = app.webViews.buttons["Export streamed archive"].firstMatch
        let preparing = app.webViews.buttons["Preparing streamed archive"].firstMatch
        if streamed.exists || preparing.exists {
            XCTAssertTrue(streamed.waitForExistence(timeout: 180), "The real full backup did not become ready")
            streamed.tap()
            dismissExportShare("streamed-backup-share")
        }
        app.webViews.buttons["Test failed export"].firstMatch.tap()
        let failedExport = app.alerts["내보내기 실패"]
        XCTAssertTrue(failedExport.waitForExistence(timeout: 20), "HTTP error response was not surfaced as a failed export")
        XCTAssertTrue(failedExport.staticTexts.matching(NSPredicate(format: "label CONTAINS 'HTTP 404'")).firstMatch.exists)
        failedExport.buttons["확인"].tap()

        app.webViews.buttons["Test confirmation"].firstMatch.tap()
        let confirmation = app.alerts["Marinar"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        confirmation.buttons["취소"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Confirmation cancelled"].waitForExistence(timeout: 10))
        app.webViews.buttons["Test confirmation"].firstMatch.tap()
        XCTAssertTrue(confirmation.waitForExistence(timeout: 10))
        confirmation.buttons["확인"].tap()
        XCTAssertTrue(app.webViews.staticTexts["Confirmation accepted"].waitForExistence(timeout: 10))

        // Read a real file from the app's Files document provider. The runner
        // places only this public fixture in Documents before launching tests.
        let file = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Choose File' OR label CONTAINS[c] 'Choose test file'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), "HTML file input is missing")
        let cancel = openDocumentPicker(file)
        attachScreen("system-file-picker")
        cancel.tap()
        XCTAssertTrue(export.waitForExistence(timeout: 15), "Cancelling file selection did not return to the page")
        _ = openDocumentPicker(file)
        let fixture = app.staticTexts.matching(NSPredicate(format: "label == 'marinar-ios-import' OR label == 'marinar-ios-import.json'")).firstMatch
        if !fixture.waitForExistence(timeout: 3) {
            // The initial picker can be Recents or the last visited directory.
            for _ in 0..<3 {
                let location = app.staticTexts.matching(NSPredicate(format: "label == 'On My iPhone' OR label == 'On My iPad'")).firstMatch
                if location.exists { location.tap(); break }
                let back = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'Browse' OR label == 'Locations' OR label == 'Back'")).firstMatch
                if back.exists { back.tap() }
                else if app.buttons["Browse"].firstMatch.exists { app.buttons["Browse"].firstMatch.tap() }
            }
            let folder = app.staticTexts.matching(NSPredicate(format: "label == 'Marinar iOS Test' OR label == 'Marinar'")).firstMatch
            if folder.waitForExistence(timeout: 10) { folder.tap() }
        }
        XCTAssertTrue(fixture.waitForExistence(timeout: 20), "Fixture not found in the app's Files folder")
        fixture.tap()
        let imported = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'restored-file-fixture'")).firstMatch
        XCTAssertTrue(imported.waitForExistence(timeout: 15), "WKWebView did not receive the selected file bytes")
        attachScreen("system-file-imported")
    }

    private func openDocumentPicker(_ input: XCUIElement) -> XCUIElement {
        input.tap()
        let browse = app.buttons["Browse"].firstMatch
        if browse.waitForExistence(timeout: 3) { browse.tap() }
        let cancel = app.buttons["Cancel"].firstMatch
        // On a clean simulator, the first DocumentManager service boot took
        // 41 seconds in the unified log. Wait for the real picker rather than
        // failing while its remote view controller is still starting.
        XCTAssertTrue(cancel.waitForExistence(timeout: 90), "System document picker did not become ready")
        return cancel
    }

    private func dismissExportShare(_ screenshotName: String) {
        let share = app.otherElements["marinar-export-share"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 60), "Download did not open the native share sheet")
        attachScreen(screenshotName)
        let close = app.buttons.matching(NSPredicate(format: "label == 'Close' OR label == 'Cancel'")).firstMatch
        if close.waitForExistence(timeout: 5) { close.tap() }
        else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.98)).tap() } // iPad popover
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: share)
        waitForExpectations(timeout: 15)
    }
}
