import XCTest

final class MarinarUITests: XCTestCase {
    private let app = XCUIApplication()
    private let prompt = "[IOS_STREAM_TEST] Hello. Please remember the blue lantern."
    private let reply = "The blue lantern is remembered."

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
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
}
