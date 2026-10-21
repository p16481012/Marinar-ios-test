import XCTest
import UIKit

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
        // Capture the whole display; an application's accessibility frame can
        // retain portrait bounds while UIKit rotates, cropping the evidence.
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attachGeometry(_ name: String, elements: [(String, XCUIElement)]) {
        let text = elements.map { label, element in
            let frame = element.frame
            return "\(label): frame=\(frame), center=(\(frame.midX), \(frame.midY))"
        }.joined(separator: "\n")
        let attachment = XCTAttachment(string: text)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func waitForAppOrientation(landscape: Bool) {
        // The WebView shrinks above the keyboard and can look wide even in
        // portrait. Verify the actual application frame before layout checks.
        expectation(for: NSPredicate { _, _ in
            let frame = self.app.frame
            return frame.width > 0 && frame.height > 0
                && (landscape ? frame.width > frame.height : frame.height > frame.width)
        }, evaluatedWith: app)
        waitForExpectations(timeout: 30)
    }

    private func attachComposerGeometry(_ name: String, input: XCUIElement) {
        attachGeometry(name, elements: [("app", app), ("webView", app.webViews["marinar-webview"]),
            ("input", input), ("keyboard", app.keyboards.firstMatch), ("send", app.webViews.buttons["Send"].firstMatch)])
    }

    func testSendPersistsAfterProcessRelaunch() throws {
        launchReady()
        let input = app.webViews.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 60), "Actual chat composer missing after fixture chat selection")
        input.tap()
        prepareSoftwareKeyboard()
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

    private func prepareSoftwareKeyboard() {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15), "The software keyboard is not visible")
        // A fresh simulator can show Apple's QuickPath introduction instead
        // of keys. Its AX subtree varies, so require the observed tutorial
        // text and a Continue button entirely in the keyboard, outside WebKit.
        let tutorial = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Speed up your typing'")).firstMatch
        let continueButton = app.buttons["Continue"].firstMatch
        if tutorial.waitForExistence(timeout: 3) && continueButton.exists {
            let buttonFrame = continueButton.frame
            let webFrame = app.webViews["marinar-webview"].frame
            let nativeButton = buttonFrame.width > 0 && buttonFrame.height > 0
                && keyboard.frame.contains(buttonFrame) && !webFrame.intersects(buttonFrame)
            if !nativeButton {
                attachKeyboardDiagnostics("keyboard-tutorial-unexpected-placement")
                XCTFail("Keyboard tutorial Continue is not inside the native keyboard")
                return
            }
            XCTAssertTrue(continueButton.isEnabled)
            XCTAssertTrue(continueButton.isHittable)
            continueButton.tap()
            expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: continueButton)
            waitForExpectations(timeout: 15)
        }
        let hasKeys = keyboard.keys.firstMatch.waitForExistence(timeout: 15)
        if !hasKeys { attachKeyboardDiagnostics("keyboard-keys-missing-before-input") }
        XCTAssertTrue(hasKeys, "The keyboard has no usable keys")
    }

    private func attachKeyboardDiagnostics(_ name: String) {
        attachScreen(name)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func assertComposerAboveKeyboard(_ input: XCUIElement) {
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 15), "The software keyboard is not visible")
        XCTAssertTrue(keyboard.keys.firstMatch.waitForExistence(timeout: 15), "The keyboard has no usable keys")
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
        waitForAppOrientation(landscape: false)
        let input = app.webViews.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 60))
        input.tap()
        prepareSoftwareKeyboard()
        input.typeText("Layout check")
        assertComposerAboveKeyboard(input)
        XCTAssertTrue(app.webViews.buttons["Send"].firstMatch.isHittable)
        attachComposerGeometry("composer-portrait-geometry", input: input)
        attachScreen("composer-portrait-keyboard")
        XCUIDevice.shared.orientation = .landscapeLeft
        waitForAppOrientation(landscape: true)
        let send = app.webViews.buttons["Send"].firstMatch
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: send)
        waitForExpectations(timeout: 20)
        assertComposerAboveKeyboard(input)
        attachComposerGeometry("composer-landscape-geometry", input: input)
        attachScreen("composer-landscape-keyboard")
        XCUIDevice.shared.orientation = .portrait
        waitForAppOrientation(landscape: false)
    }

    func testBlobDownloadShareAndFilePicker() throws {
        app.launchEnvironment["MARINARA_TEST_FILE_PANEL"] = "1"
        launchReady()
        let export = app.webViews.buttons["Export test JSON"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 30))
        expectation(for: NSPredicate { _, _ in export.exists && export.isEnabled && export.isHittable }, evaluatedWith: export)
        waitForExpectations(timeout: 30)
        attachScreen("blob-export-before-tap")
        attachGeometry("blob-export-before-tap-geometry", elements: [("app", app),
            ("webView", app.webViews["marinar-webview"]), ("export", export)])
        // Deliver one real touch at the observed button center. The automatic
        // WebKit accessibility hit point previously delivered no DOM events.
        export.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let handler = app.webViews.staticTexts["Export handler started"].firstMatch
        let exportedFilename = app.descendants(matching: .any).matching(NSPredicate(format:
            "label CONTAINS 'marinar-ios-export'")).firstMatch
        expectation(for: NSPredicate { _, _ in handler.exists || exportedFilename.exists }, evaluatedWith: app)
        waitForExpectations(timeout: 15)
        dismissExportShare("blob-export-share", expectedFilename: "marinar-ios-export")
        XCTAssertTrue(export.waitForExistence(timeout: 15))
        let streamed = app.webViews.buttons["Export streamed archive"].firstMatch
        let preparing = app.webViews.buttons["Preparing streamed archive"].firstMatch
        if streamed.exists || preparing.exists {
            XCTAssertTrue(streamed.waitForExistence(timeout: 180), "The real full backup did not become ready")
            streamed.tap()
            dismissExportShare("streamed-backup-share", expectedFilename: "Marinar-iOS-full")
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
        // The Files grid exposes its filename as a separate StaticText. In
        // the simulator that label tap left the file unselected. Activate the
        // visible file thumbnail inside its actual collection cell instead.
        let fixtureCell = app.cells.containing(.staticText, identifier: fixture.label).firstMatch
        XCTAssertTrue(fixtureCell.waitForExistence(timeout: 10), "Fixture file cell is missing")
        XCTAssertTrue(fixtureCell.isEnabled, "Fixture file cannot be selected")
        let thumbnail = fixtureCell.images.firstMatch
        if thumbnail.exists && thumbnail.isHittable { thumbnail.tap() }
        else { fixtureCell.tap() } // Files list presentations may omit the thumbnail.
        attachScreen("system-file-selected")
        let selection = XCTAttachment(string: app.debugDescription)
        selection.name = "system-file-selected-accessibility-hierarchy"
        selection.lifetime = .keepAlways
        add(selection)
        // Some Files picker presentations select the file first and expose a
        // separate Open action. Complete that visible action when available;
        // the page must still receive and read the real fixture bytes below.
        let open = app.buttons["Open"].firstMatch
        if open.waitForExistence(timeout: 5) && open.isEnabled { open.tap() }
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

    private func dismissExportShare(_ screenshotName: String, expectedFilename: String) {
        // Assert visible user actions and the actual filename. Remote iOS
        // share controllers do not reliably retain wrapper identifiers.
        let filename = app.descendants(matching: .any).matching(NSPredicate(format:
            "label CONTAINS %@", expectedFilename)).firstMatch
        XCTAssertTrue(filename.waitForExistence(timeout: 60), "The share sheet does not contain the expected exported file")
        let save = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Save to Files'")).firstMatch
        XCTAssertTrue(save.waitForExistence(timeout: 30), "The exported file cannot be saved through the native share sheet")
        attachScreen(screenshotName)
        let close = app.buttons["Close"].firstMatch
        let dismissPopup = app.otherElements["PopoverDismissRegion"].firstMatch
        if close.waitForExistence(timeout: 15) { close.tap() }
        else if dismissPopup.waitForExistence(timeout: 5) {
            // iOS can present this share UI as a popover on either device
            // family. Use its observed native dismissal region, not a guessed
            // point on the underlying page or an iPad-only assumption.
            XCTAssertTrue(dismissPopup.isHittable, "The popover dismissal region is not available")
            attachGeometry("\(screenshotName)-dismiss-geometry", elements: [("dismissPopup", dismissPopup),
                ("popover", app.popovers.firstMatch)])
            dismissPopup.tap()
        } else { XCTFail("The native share UI has no available dismissal action") }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: filename)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: save)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: dismissPopup)
        waitForExpectations(timeout: 15)
    }
}
