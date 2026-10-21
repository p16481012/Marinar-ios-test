import XCTest
import UIKit

final class MarinarUITests: XCTestCase {
    private let app = XCUIApplication()
    private var systemFilesApp: XCUIApplication?
    private var moreTouchRetryUsed = false
    private let prompt = "[IOS_STREAM_TEST] Hello. Please remember the blue lantern."
    private let reply = "The blue lantern is remembered."

    override func setUpWithError() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["MARINARA_TEST_DIAGNOSTICS"] = "1"
    }

    override func tearDownWithError() throws {
        if let files = systemFilesApp {
            attachSystemFilesEvidence("system-files-final")
            files.terminate()
            systemFilesApp = nil
        }
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

    func testStartupTimeoutCanRetryBeforeSessionReady() throws {
        app.terminate()
        app.launchEnvironment["MARINARA_TEST_STARTUP_STALL"] = "rules"
        defer { app.launchEnvironment.removeValue(forKey: "MARINARA_TEST_STARTUP_STALL") }
        app.launch()

        let webView = app.webViews["marinar-webview"]
        let status = app.staticTexts["marinar-startup-status"]
        let retry = app.buttons["marinar-retry"]
        // The one-shot DEBUG stall withholds session preparation. Observe the
        // real watchdog's failure and native control before touching Retry.
        XCTAssertTrue(retry.waitForExistence(timeout: 120), "Startup before session readiness never exposed Retry")
        XCTAssertTrue(status.exists)
        XCTAssertTrue(status.label.contains("초과"), "The startup watchdog did not show its timeout failure")
        XCTAssertEqual(webView.value as? String, "failed")
        XCTAssertTrue(retry.isEnabled && retry.isHittable, "Retry was not available before the session was ready")
        attachScreen("startup-timeout-before-session-ready")
        attachGeometry("startup-timeout-retry-geometry", elements: [("status", status), ("retry", retry)])

        retry.tap()
        expectation(for: NSPredicate(format: "value == %@", "ready"), evaluatedWith: webView)
        waitForExpectations(timeout: 300)
        // Stay in this process: no second app launch, fake cookie, navigation,
        // DOM success injection, or automatic retry can complete this check.
        expectation(for: NSPredicate { _, _ in
            webView.buttons.allElementsBoundByIndex.contains { button in
                button.exists && button.isEnabled && button.isHittable
                    && button.frame.width > 0 && button.frame.height > 0
            }
        }, evaluatedWith: webView)
        waitForExpectations(timeout: 30)
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertFalse(retry.exists, "Retry remained visible after real frontend readiness")
        XCTAssertFalse(status.isHittable, "The native startup overlay still covered the recovered frontend")
        attachScreen("startup-recovered-after-native-retry")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "startup-recovered-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        // The ready screen and real controls above are the success verdict.
        // Termination is intentional cleanup after that evidence was captured.
        app.terminate()
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

    private func prepareComposerForInput() -> XCUIElement {
        let input = app.webViews.textViews.firstMatch
        let welcome = app.webViews.staticTexts["Welcome to Marinara Engine!"].firstMatch
        let skipTutorial = app.webViews.buttons["Skip Tutorial"].firstMatch
        let closeChats = app.webViews.buttons["Close chats"].firstMatch
        let deadline = Date().addingTimeInterval(60)
        var readySince: Date?
        var skippedTutorial = false
        var closedChats = false
        while Date() < deadline {
            // Native "ready" means React has rendered controls, not that its
            // asynchronously hydrated tutorial and mobile sidebar are closed.
            // Dismiss only the actual controls observed in the failed UI.
            if welcome.exists {
                readySince = nil
                if !skippedTutorial && skipTutorial.exists && skipTutorial.isEnabled && skipTutorial.isHittable {
                    attachScreen("composer-before-skip-tutorial")
                    skipTutorial.tap()
                    skippedTutorial = true
                }
            } else if closeChats.exists {
                readySince = nil
                if !closedChats && closeChats.isEnabled && closeChats.isHittable {
                    attachScreen("composer-before-close-chats")
                    closeChats.tap()
                    closedChats = true
                }
            } else if input.exists && input.isEnabled && input.isHittable
                        && input.frame.width > 0 && input.frame.height > 0 {
                if let readySince, Date().timeIntervalSince(readySince) >= 1 { return input }
                if readySince == nil { readySince = Date() }
            } else {
                readySince = nil
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        attachKeyboardDiagnostics("composer-input-not-ready")
        XCTFail("The real chat composer did not become hittable after closing the observed tutorial and chat list")
        return input
    }

    func testSettingsFullBackupRestoresAfterProcessRelaunch() throws {
        app.terminate()
        app.launchEnvironment["MARINARA_TEST_SETTINGS_RESTORE"] = "1"
        app.launchEnvironment["MARINARA_TEST_MORE_TOUCH_TRACE"] = "1"
        defer {
            app.launchEnvironment.removeValue(forKey: "MARINARA_TEST_SETTINGS_RESTORE")
            app.launchEnvironment.removeValue(forKey: "MARINARA_TEST_MORE_TOUCH_TRACE")
        }
        launchReady()
        _ = prepareComposerForInput()
        openSettingsBackupSection()

        let filename = "marinar-ios-full-restore-ui.zip"
        let restore = hittableWebElement(named: "Restore full iOS backup")
        let expectedFile = XCTAttachment(string: filename)
        expectedFile.name = "settings-restore-expected-archive"
        expectedFile.lifetime = .keepAlways
        add(expectedFile)
        // This opens the product's hidden ZIP input through its real button.
        // No DEBUG HTML panel, file-input injection or direct stage API is used.
        _ = openDocumentPicker(restore)
        selectSystemDocument(named: filename)
        let confirmationText = "Restore \(filename)? This replaces current data at the next complete app restart. Save a backup of your current data first. The file will be validated before anything is replaced, and you can cancel the pending restore before restarting."
        let confirmation = app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", confirmationText)).firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 30), "The real restore confirmation did not name the selected ZIP")
        XCTAssertEqual(confirmation.label, confirmationText)
        attachScreen("settings-restore-confirmation")
        let confirmEvidence = XCTAttachment(string: confirmation.label)
        confirmEvidence.name = "settings-restore-confirmed-filename"
        confirmEvidence.lifetime = .keepAlways
        add(confirmEvidence)
        hittableWebElement(named: "Validate and prepare restore").tap()

        let pending = app.webViews.staticTexts["Backup ready to restore"].firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 180), "The selected ZIP was not uploaded, validated and staged by Settings")
        _ = hittableWebElement(named: "Cancel restore and keep current data")
        let restartText = "Fully close Marinar from the app switcher, then reopen it. The validated backup will replace current data before the server starts. Editing is paused until you restart or cancel this restore. Reloading the page or briefly going to the Home Screen is not enough."
        XCTAssertTrue(app.webViews.staticTexts.matching(NSPredicate(format: "label == %@", restartText)).firstMatch.exists, "The product did not explain that a full process restart is required")
        attachScreen("settings-restore-pending-before-cold-launch")
        let pendingEvidence = XCTAttachment(string: app.debugDescription)
        pendingEvidence.name = "settings-restore-pending-accessibility-hierarchy"
        pendingEvidence.lifetime = .keepAlways
        add(pendingEvidence)

        app.terminate()
        launchReady()
        _ = prepareComposerForInput()
        XCTAssertFalse(app.webViews.staticTexts["Backup ready to restore"].firstMatch.exists,
                       "The pending restore did not apply at the actual cold launch")
        openSettingsBackupSection()
        let applied = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "The full backup was restored.")).firstMatch
        XCTAssertTrue(applied.waitForExistence(timeout: 30), "Settings did not report that the archive was restored")
        attachScreen("settings-restore-applied-after-cold-launch")
        let appliedEvidence = XCTAttachment(string: applied.label)
        appliedEvidence.name = "settings-restore-applied-status"
        appliedEvidence.lifetime = .keepAlways
        add(appliedEvidence)
        hittableWebElement(named: "Close panel").tap()

        // Select the restored chat from the real list even if DEBUG setup also
        // selected it. Merely reaching the restore-success banner is not enough.
        hittableWebElement(named: "Chats").tap()
        // WebKit exposes the sidebar's role=button row as one Button whose
        // name combines the avatar initial, full chat name and Delete label.
        // Require the exact observed fixture row, not a nonexistent StaticText.
        let chatLabel = "i iOS full restore UI original chat Delete iOS full restore UI original chat"
        let chatRows = app.webViews.buttons.matching(NSPredicate(format: "label == %@", chatLabel))
        let chat = chatRows.firstMatch
        XCTAssertTrue(chat.waitForExistence(timeout: 30), "The original backup chat did not return to the actual chat list")
        XCTAssertEqual(chatRows.count, 1, "The exact restored chat row is not unique")
        XCTAssertTrue(chat.isEnabled && chat.isHittable, "The restored chat cannot be selected")
        let closeChats = app.webViews.buttons["Close chats"].firstMatch
        XCTAssertTrue(closeChats.exists && closeChats.isHittable, "The actual mobile chat list is not open")
        attachScreen("settings-restore-before-selecting-original-chat")
        let selectedChatEvidence = XCTAttachment(string: chat.label)
        selectedChatEvidence.name = "settings-restore-selected-chat-row"
        selectedChatEvidence.lifetime = .keepAlways
        add(selectedChatEvidence)
        chat.tap()
        // A successful mobile row selection closes the sidebar. Check that
        // before prepareComposerForInput, which can itself dismiss the list.
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: closeChats)
        waitForExpectations(timeout: 20)
        let input = prepareComposerForInput()
        let originalReply = "The blue lantern is remembered. 대화 저장을 확인했습니다."
        let restored = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", originalReply)).firstMatch
        XCTAssertTrue(restored.waitForExistence(timeout: 30), "The selected restored chat lost its original assistant reply")
        attachScreen("settings-restore-original-chat-and-reply")
        input.tap()
        prepareSoftwareKeyboard()
        input.typeText("[IOS_RESTORE_TEST] What did we remember before restarting?")
        let send = hittableWebElement(named: "Send")
        assertComposerAboveKeyboard()
        send.tap()
        let followup = "After restarting, I still remember the blue lantern."
        let received = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", followup)).firstMatch
        XCTAssertTrue(received.waitForExistence(timeout: 90), "The restored connection could not send and display a new real mock-provider reply")
        attachScreen("settings-restore-followup-with-recovered-connection")
        let replyEvidence = XCTAttachment(string: received.label)
        replyEvidence.name = "settings-restore-followup-reply"
        replyEvidence.lifetime = .keepAlways
        add(replyEvidence)
        XCUIDevice.shared.press(.home)
        sleep(2)
    }

    private func hittableWebElement(named label: String, timeout: TimeInterval = 20) -> XCUIElement {
        let web = app.webViews["marinar-webview"]
        let buttons = web.buttons.matching(NSPredicate(format: "label == %@", label))
        let elements = web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label))
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            // WebKit maps ordinary buttons, role=tab and role=menuitem to
            // different AX types. All candidates still use the exact product label.
            if let element = buttons.allElementsBoundByIndex.first(where: { $0.isEnabled && $0.isHittable }) {
                return element
            }
            if let element = elements.allElementsBoundByIndex.first(where: {
                $0.elementType != .staticText && $0.isEnabled && $0.isHittable
            }) { return element }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        attachScreen("settings-control-unavailable")
        XCTFail("The actual product control is not enabled and hittable: \(label)")
        return elements.firstMatch
    }

    private struct MoreTouchSnapshot: Decodable {
        struct Gesture: Decodable {
            let sequence: Int
            let maxDistance: Double
            let trusted, sameTarget, unknown, opened: Bool
            let pointerdown, pointerup, pointercancel, touchstart, touchend, touchcancel, click: Int
        }
        let version, sequence: Int
        let targetPresent, targetStable, open: Bool
        let current: Gesture?

        var permitsSingleRedelivery: Bool {
            guard let gesture = current else { return false }
            return version == 1 && sequence == 1 && gesture.sequence == sequence
                && targetPresent && targetStable && !open && !gesture.opened
                && gesture.trusted && gesture.sameTarget && !gesture.unknown
                && gesture.maxDistance == 0
                && gesture.pointerdown == 1 && gesture.touchstart == 1
                && gesture.pointercancel == 1 && gesture.touchcancel == 1
                && gesture.pointerup == 0 && gesture.touchend == 0 && gesture.click == 0
        }
    }

    private func openMoreMenuWithObservedTouch() {
        let web = app.webViews["marinar-webview"]
        let prefix = "Marinar More touch: "
        // Use a predicate, not an identifier subscript: JSON labels can exceed
        // XCTest's 128-character identifier-query limit.
        let trace = web.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        func snapshot() -> MoreTouchSnapshot? {
            guard trace.exists, trace.label.hasPrefix(prefix),
                  let data = String(trace.label.dropFirst(prefix.count)).data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(MoreTouchSnapshot.self, from: data)
        }
        func settingsVisible() -> Bool {
            web.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Settings"))
                .allElementsBoundByIndex.contains { $0.elementType != .staticText && $0.isEnabled && $0.isHittable }
        }
        func evidence(_ name: String) {
            attachScreen(name)
            let attachment = XCTAttachment(string: trace.exists ? trace.label : "More passive trace missing")
            attachment.name = "\(name)-touch-trace"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        func tapObservedCenter(_ suffix: String) {
            let more = hittableWebElement(named: "More")
            // Use whole screen points so PointerEvent and Touch coordinates
            // can be compared without introducing a fractional tap position.
            let center = CGPoint(x: more.frame.midX.rounded(), y: more.frame.midY.rounded())
            let visible = app.frame.intersection(web.frame)
            XCTAssertTrue(more.frame.width > 0 && more.frame.height > 0
                && center.x.isFinite && center.y.isFinite && visible.contains(center)
                && more.frame.contains(center), "The observed More center is outside the app's visible WebView")
            attachGeometry("settings-more-\(suffix)-geometry", elements: [("app", app), ("webView", web), ("more", more)])
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: center.x - app.frame.minX, dy: center.y - app.frame.minY)).tap()
        }

        XCTAssertTrue(trace.waitForExistence(timeout: 15), "The DEBUG passive More trace was not installed")
        guard let initial = snapshot(), initial.version == 1, initial.sequence == 0,
              initial.current == nil, initial.targetPresent, initial.targetStable, !initial.open else {
            evidence("settings-more-invalid-initial-state")
            XCTFail("More was already interacted with or its initial state is unknown")
            return
        }
        evidence("settings-more-before-first-tap")
        tapObservedCenter("first-tap")
        let opened = NSPredicate { _, _ in settingsVisible() }
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: opened, object: app)], timeout: 20)
        if result == .completed { return }
        evidence("settings-more-first-tap-failed")
        // Retry at most once in this entire test, only for a stationary,
        // trusted touch cancelled before any click or menu opening. A moved,
        // wrong-target, unknown or delivered click remains a test failure.
        guard result == .timedOut, !moreTouchRetryUsed, !settingsVisible(),
              snapshot()?.permitsSingleRedelivery == true else {
            XCTFail("Settings did not appear and the first More touch is not safely retryable")
            return
        }
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "settings-more-cancelled-before-redelivery-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        // Recheck after collecting evidence, so a late click cannot cause a
        // second tap that closes a menu which has meanwhile opened.
        guard !settingsVisible(), snapshot()?.permitsSingleRedelivery == true else {
            if settingsVisible() { return }
            XCTFail("More changed state before the proposed cancelled-touch redelivery")
            return
        }
        moreTouchRetryUsed = true
        tapObservedCenter("single-redelivery")
        let retried = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: opened, object: app)], timeout: 20)
        evidence("settings-more-after-single-redelivery")
        XCTAssertEqual(retried, .completed, "Settings did not appear after one evidenced cancelled-touch redelivery")
    }


    private func openSettingsBackupSection() {
        let web = app.webViews["marinar-webview"]
        let settings = web.buttons["Settings"].firstMatch
        if !(settings.exists && settings.isEnabled && settings.isHittable) {
            openMoreMenuWithObservedTouch()
        }
        hittableWebElement(named: "Settings").tap()
        hittableWebElement(named: "Advanced").tap()
        let quickAccess = web.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quick Access' OR label == 'Expand Quick Access' OR label == 'Collapse Quick Access'")).firstMatch
        XCTAssertTrue(quickAccess.waitForExistence(timeout: 20), "Settings Quick Access is missing")
        let backupShortcut = web.buttons["Backup & Export"].firstMatch
        if !(backupShortcut.exists && backupShortcut.isHittable) {
            XCTAssertTrue(quickAccess.isEnabled && quickAccess.isHittable)
            quickAccess.tap()
        }
        hittableWebElement(named: "Backup & Export").tap()
        // Collapse the observed shortcuts to leave space for the real backup
        // controls. This preserves the user's own section-navigation behavior.
        if backupShortcut.exists && backupShortcut.isHittable && quickAccess.isHittable { quickAccess.tap() }
        let restore = web.buttons["Restore full iOS backup"].firstMatch
        XCTAssertTrue(restore.waitForExistence(timeout: 30), "The real iOS full-backup section did not render")
        for _ in 0..<3 {
            if restore.isHittable { break }
            web.swipeUp()
        }
        XCTAssertTrue(restore.isEnabled && restore.isHittable, "The Settings restore action is outside the visible panel")
        attachScreen("settings-full-backup-section")
    }

    func testSendPersistsAfterProcessRelaunch() throws {
        launchReady()
        let input = prepareComposerForInput()
        input.tap()
        prepareSoftwareKeyboard()
        input.typeText(prompt)
        let send = app.webViews.buttons["Send"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 15))
        XCTAssertTrue(send.isEnabled)
        XCTAssertTrue(send.isHittable, "Send is covered by the keyboard or outside the safe area")
        assertComposerAboveKeyboard()
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
        let letterKey = keyboard.keys.matching(NSPredicate(format: "label == 'Q' OR label == 'q'")).firstMatch
        let deadline = Date().addingTimeInterval(60)
        var readySince: Date?
        var dismissedTutorial = false
        while Date() < deadline {
            if let snapshot = try? app.snapshot() {
                let nodes = snapshotTree(snapshot)
                let keyboardFrame = nodes.first { $0.elementType == .keyboard }?.frame ?? .zero
                let webFrame = nodes.first { $0.identifier == "marinar-webview" }?.frame ?? .zero
                // The observed QuickPath introduction can arrive after the
                // keyboard's preview keys, including after typeText(). Its
                // actual native subtree is distinct from any page Continue.
                let introduction = nodes.first { $0.identifier == "UIContinuousPathIntroductionView" }
                let tutorialVisible = nodes.contains { $0.label.contains("Speed up your typing") }
                if introduction != nil || tutorialVisible {
                    readySince = nil
                    if let introduction, !dismissedTutorial {
                        let tutorialNodes = snapshotTree(introduction)
                        if tutorialNodes.contains(where: { $0.label.contains("Speed up your typing") }),
                           let button = tutorialNodes.first(where: { $0.elementType == .button && $0.label == "Continue" }),
                           button.frame.width > 0, button.frame.height > 0 {
                            let nativeContinue = app.otherElements["UIContinuousPathIntroductionView"].buttons["Continue"].firstMatch
                            if nativeContinue.exists && nativeContinue.isEnabled && nativeContinue.isHittable {
                                let buttonFrame = nativeContinue.frame
                                let introductionFrame = app.otherElements["UIContinuousPathIntroductionView"].frame
                                // On the large iPhone, Continue extends below
                                // the key grid. It must belong to the native
                                // introduction, inside the screen, outside WebKit.
                                if introductionFrame.contains(buttonFrame), app.frame.contains(buttonFrame),
                                   !webFrame.intersects(buttonFrame) {
                                    nativeContinue.tap()
                                    dismissedTutorial = true
                                }
                            }
                        }
                    }
                } else if keyboardFrame.width > 0, keyboardFrame.height > 0,
                          letterKey.exists, letterKey.frame.width > 0, letterKey.frame.height > 0,
                          letterKey.isHittable {
                    if let readySince, Date().timeIntervalSince(readySince) >= 1 { return }
                    if readySince == nil { readySince = Date() }
                } else {
                    readySince = nil
                }
            } else {
                readySince = nil
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        attachKeyboardDiagnostics("keyboard-not-ready")
        XCTFail("The software keyboard did not expose a usable letter key with its tutorial dismissed")
    }

    private func snapshotTree(_ snapshot: any XCUIElementSnapshot) -> [any XCUIElementSnapshot] {
        [snapshot] + snapshot.children.flatMap { snapshotTree($0) }
    }

    private func attachKeyboardDiagnostics(_ name: String) {
        attachScreen(name)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private func assertComposerAboveKeyboard() {
        // Recheck after typing/rotation: first-use UI may appear later than
        // the initial focus. A zero-size Padding-Left key is not readiness.
        prepareSoftwareKeyboard()
        let deadline = Date().addingTimeInterval(45)
        let web = app.webViews["marinar-webview"]
        let composer = web.textViews.firstMatch
        let keyboard = app.keyboards.firstMatch
        var previousFrames: [CGRect]?
        var lastObservation = "No complete layout observation"
        while Date() < deadline {
            // Snapshot frames can retain the keyboard window's unrotated
            // coordinate system. XCUIElement.frame converts to screen space.
            // Require two complete, identical observations so a delayed AX
            // response cannot mix pre-resize and post-resize geometry.
            if let snapshot = try? app.snapshot() {
                let nodes = snapshotTree(snapshot)
                let appFrame = app.frame
                let webFrame = web.frame
                let composerFrame = composer.frame
                let keyboardFrame = keyboard.frame
                let frames = [appFrame, webFrame, composerFrame, keyboardFrame]
                lastObservation = "app=\(appFrame), webView=\(webFrame), input=\(composerFrame), keyboard=\(keyboardFrame)"
                let tutorialVisible = nodes.contains { $0.identifier == "UIContinuousPathIntroductionView"
                    || $0.label.contains("Speed up your typing") }
                let valid = frames.allSatisfy { $0.width > 0 && $0.height > 0 }
                    && !tutorialVisible
                    && appFrame.contains(webFrame) && appFrame.contains(composerFrame) && appFrame.contains(keyboardFrame)
                    && composerFrame.maxY <= keyboardFrame.minY + 2
                    && composerFrame.minY >= webFrame.minY - 2
                    && composerFrame.maxY <= webFrame.maxY + 2
                    && composerFrame.minX >= webFrame.minX - 2
                    && composerFrame.maxX <= webFrame.maxX + 2
                if valid && previousFrames == frames { return }
                previousFrames = valid ? frames : nil
            } else {
                previousFrames = nil
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        attachKeyboardDiagnostics("composer-keyboard-layout-not-ready")
        XCTFail("The composer did not settle fully inside the WebView above the keyboard: \(lastObservation)")
    }

    func testComposerAcrossOrientations() throws {
        launchReady()
        waitForAppOrientation(landscape: false)
        let input = prepareComposerForInput()
        input.tap()
        prepareSoftwareKeyboard()
        input.typeText("Layout check")
        assertComposerAboveKeyboard()
        XCTAssertTrue(app.webViews.buttons["Send"].firstMatch.isHittable)
        attachComposerGeometry("composer-portrait-geometry", input: input)
        attachScreen("composer-portrait-keyboard")
        XCUIDevice.shared.orientation = .landscapeLeft
        waitForAppOrientation(landscape: true)
        let send = app.webViews.buttons["Send"].firstMatch
        expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: send)
        waitForExpectations(timeout: 20)
        assertComposerAboveKeyboard()
        attachComposerGeometry("composer-landscape-geometry", input: input)
        attachScreen("composer-landscape-keyboard")
        XCUIDevice.shared.orientation = .portrait
        waitForAppOrientation(landscape: false)
    }

    func testBlobDownloadShareAndFilePicker() throws {
        app.terminate()
        app.launchEnvironment["MARINARA_TEST_FILE_PANEL"] = "1"
        launchReady()
        let export = app.webViews.buttons["Export test JSON"].firstMatch
        XCTAssertTrue(export.waitForExistence(timeout: 30))
        expectation(for: NSPredicate { _, _ in export.exists && export.isEnabled && export.isHittable }, evaluatedWith: export)
        waitForExpectations(timeout: 30)
        attachScreen("blob-export-before-tap")
        attachGeometry("blob-export-before-tap-geometry", elements: [("app", app),
            ("webView", app.webViews["marinar-webview"]), ("export", export)])
        // Deliver the first real touch at the observed button center. The automatic
        // WebKit accessibility hit point previously delivered no DOM events.
        export.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let handler = app.webViews.staticTexts["Export handler started"].firstMatch
        let exportedFilename = app.descendants(matching: .any).matching(NSPredicate(format:
            "label CONTAINS 'marinar-ios-export'")).firstMatch
        let exportStarted = NSPredicate { _, _ in handler.exists || exportedFilename.exists }
        let firstResult = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: exportStarted, object: app)], timeout: 15)
        if firstResult != .completed {
            let idle = app.webViews.staticTexts["Export handler idle"].firstMatch
            let cancelled = app.webViews.staticTexts.matching(NSPredicate(format:
                "label CONTAINS 'pointercancel:ios-test-export@' AND label CONTAINS 'touchcancel:ios-test-export@'")).firstMatch
            // The recorded first touch can be cancelled before WebKit emits
            // click. Retry exactly once only with that evidence and an idle
            // handler; never duplicate a started or unknown export operation.
            if firstResult == .timedOut && idle.exists && !handler.exists && !exportedFilename.exists && cancelled.exists
                && !cancelled.label.contains("click:ios-test-export@") && export.exists && export.isEnabled && export.isHittable {
                attachScreen("blob-export-cancelled-before-retry")
                let trace = XCTAttachment(string: cancelled.label)
                trace.name = "blob-export-cancelled-touch-trace"
                trace.lifetime = .keepAlways
                add(trace)
                // Recheck after collecting evidence in case a delayed click
                // started the original export while the attachment was made.
                if idle.exists && !handler.exists && !exportedFilename.exists {
                    export.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
                }
                expectation(for: exportStarted, evaluatedWith: app)
                waitForExpectations(timeout: 15)
            } else {
                XCTFail("Export did not start, and no safely retryable cancelled touch was observed")
            }
        }
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

        // Preserve the same-process export -> dialog -> import regression gate.
        assertActualFilePickerRoundTrip()
    }

    func testHTMLFilePickerRoundTrip() throws {
        // Keep real file selection independent of export/share/dialog failures.
        // This launch creates the latest fixture marker used by the Files control.
        app.terminate()
        app.launchEnvironment["MARINARA_TEST_FILE_PANEL"] = "1"
        launchReady()
        attachScreen("html-picker-before-input")
        assertActualFilePickerRoundTrip()
    }

    private func assertActualFilePickerRoundTrip() {
        // Read the exact file created and verified by this installed app.
        // Using its displayed unique filename avoids a stale provider item
        // from an earlier app installation or another test launch.
        let fixturePrefix = "Import fixture: "
        let fixtureDescription = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", fixturePrefix)).firstMatch
        XCTAssertTrue(fixtureDescription.waitForExistence(timeout: 15), "The app did not create and verify the import fixture")
        let fixtureFilename = String(fixtureDescription.label.dropFirst(fixturePrefix.count))
        XCTAssertNotNil(fixtureFilename.range(of: "^marinar-ios-import-[0-9a-f]{8}\\.json$", options: .regularExpression),
                        "The import fixture filename is invalid")
        let filenameEvidence = XCTAttachment(string: fixtureFilename)
        filenameEvidence.name = "html-picker-expected-fixture"
        filenameEvidence.lifetime = .keepAlways
        add(filenameEvidence)
        let file = app.webViews.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Choose File' OR label CONTAINS[c] 'Choose test file'")).firstMatch
        XCTAssertTrue(file.waitForExistence(timeout: 15), "HTML file input is missing")
        let picker = app.otherElements["Browse View (Picker)"].firstMatch
        let cancel = openDocumentPicker(file)
        attachScreen("system-file-picker")
        cancel.tap()
        expectation(for: NSPredicate { _, _ in
            !cancel.exists && !picker.exists && file.exists && file.isEnabled && file.isHittable
        }, evaluatedWith: file)
        waitForExpectations(timeout: 15)
        let cancelled = XCTAttachment(string: "Native Cancel dismissed the picker; the original HTML file input is enabled and hittable.")
        cancelled.name = "html-picker-cancelled"
        cancelled.lifetime = .keepAlways
        add(cancelled)
        _ = openDocumentPicker(file)
        selectSystemDocument(named: fixtureFilename)
        let expectedJSON = #"{"fixture":"restored-file-fixture","text":"실제 파일 선택 확인"}"#
        let expectedImport = "Imported: \(fixtureFilename) \(expectedJSON)"
        let imported = app.webViews.staticTexts[expectedImport].firstMatch
        XCTAssertTrue(imported.waitForExistence(timeout: 15), "WKWebView did not receive the selected file bytes")
        XCTAssertEqual(imported.label, expectedImport, "File.text() did not return the exact selected filename and JSON")
        let importedEvidence = XCTAttachment(string: imported.label)
        importedEvidence.name = "html-file-reader-verified-content"
        importedEvidence.lifetime = .keepAlways
        add(importedEvidence)
        attachScreen("system-file-imported")
    }

    private func selectSystemDocument(named filename: String) {
        let stem = (filename as NSString).deletingPathExtension
        let picker = app.otherElements["Browse View (Picker)"].firstMatch
        let fixture = app.staticTexts.matching(NSPredicate(format: "label == %@ OR label == %@", filename, stem)).firstMatch
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
        // Deliver one real touch at the observed thumbnail center. This path
        // has been confirmed to reach Files' selection handler; keep the
        // URL delivery and actual byte-reading assertions below as well.
        let fixtureCell = revealFixtureCell(named: fixture.label)
        XCTAssertTrue(fixtureCell.waitForExistence(timeout: 10), "Fixture file cell is missing")
        XCTAssertTrue(fixtureCell.isEnabled, "Fixture file cannot be selected")
        let thumbnail = fixtureCell.images.firstMatch
        if thumbnail.exists {
            let fileView = app.collectionViews["File View"].firstMatch
            XCTAssertTrue(fileView.exists, "The visible Files collection is missing")
            let thumbnailFrame = thumbnail.frame
            XCTAssertTrue(thumbnailFrame.width > 0 && thumbnailFrame.height > 0, "The file thumbnail has no visible area")
            XCTAssertTrue(fixtureCell.frame.contains(thumbnailFrame), "The thumbnail is outside the expected file cell")
            XCTAssertTrue(fileView.frame.contains(thumbnailFrame) && app.frame.contains(thumbnailFrame),
                          "The file thumbnail is outside the visible picker")
            XCTAssertTrue(filePickerViewport(fileView).contains(thumbnailFrame),
                          "The file thumbnail is covered by the Files navigation or tab bar")
            attachScreen("system-file-before-selection")
            attachGeometry("system-file-before-selection-geometry", elements: [("app", app), ("fileView", fileView),
                ("fixtureCell", fixtureCell), ("thumbnail", thumbnail)])
            let coordinate = thumbnail.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let point = coordinate.screenPoint
            let coordinateEvidence = XCTAttachment(string: "expectedCenter=(\(thumbnailFrame.midX), \(thumbnailFrame.midY)), screenPoint=\(point)")
            coordinateEvidence.name = "system-file-selection-coordinate"
            coordinateEvidence.lifetime = .keepAlways
            add(coordinateEvidence)
            XCTAssertTrue(thumbnailFrame.contains(point), "The calculated touch is outside the observed thumbnail")
            coordinate.tap()
        } else {
            // Files list presentations may omit the thumbnail.
            XCTAssertTrue(fixtureCell.isHittable, "The fixture file row is not available")
            fixtureCell.tap()
        }
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
        // The iPad simulator can take over 20 seconds to copy an already
        // selected Documents file into Inbox and dismiss Files. Keep this
        // bounded, and still require dismissal and the exact bytes below.
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: picker)
        waitForExpectations(timeout: 60)
    }

    private func filePickerViewport(_ fileView: XCUIElement) -> CGRect {
        var visible = fileView.frame.intersection(app.frame)
        let navigation = app.navigationBars["FullDocumentManagerViewControllerNavigationBar"].firstMatch
        let tabBar = app.tabBars["DOC.browsingModeTabBar"].firstMatch
        if navigation.exists && visible.intersects(navigation.frame) {
            let top = max(visible.minY, navigation.frame.maxY)
            visible = CGRect(x: visible.minX, y: top, width: visible.width, height: max(0, visible.maxY - top))
        }
        if tabBar.exists && visible.intersects(tabBar.frame) {
            visible.size.height = max(0, min(visible.maxY, tabBar.frame.minY) - visible.minY)
        }
        return visible
    }

    private func revealFixtureCell(named label: String) -> XCUIElement {
        let cell = app.cells.containing(.staticText, identifier: label).firstMatch
        let fileView = app.collectionViews["File View"].firstMatch
        XCTAssertTrue(fileView.waitForExistence(timeout: 10), "The Files collection is missing")
        XCTAssertTrue(cell.waitForExistence(timeout: 10), "Fixture file cell is missing")
        var observations: [String] = []
        defer {
            let evidence = XCTAttachment(string: observations.joined(separator: "\n"))
            evidence.name = "system-file-reveal-geometry"
            evidence.lifetime = .keepAlways
            add(evidence)
        }
        // Files exposes cells below its viewport through accessibility. Scroll
        // the real collection before selecting; existence alone is insufficient.
        // Refresh all geometry after each gesture, with at most six scrolls.
        for attempt in 0...6 {
            let fileFrame = fileView.frame
            let visible = filePickerViewport(fileView)
            let cellFrame = cell.frame
            let thumbnail = cell.images.firstMatch
            observations.append("attempt=\(attempt), app=\(app.frame), fileView=\(fileFrame), visible=\(visible), cell=\(cellFrame), thumbnail=\(thumbnail.exists ? thumbnail.frame : .zero)")
            guard visible.width > 0, visible.height > 0, cellFrame.width > 0, cellFrame.height > 0 else { break }
            if visible.contains(cellFrame) && cell.isHittable { return cell }
            guard attempt < 6 else { break }
            let direction: CGFloat
            if cellFrame.maxY > visible.maxY { direction = -1 }
            else if cellFrame.minY < visible.minY { direction = 1 }
            else { break } // Do not guess a gesture for an otherwise obscured cell.
            let origin = fileView.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            let distance = visible.height * 0.3
            let start = origin.withOffset(CGVector(dx: visible.midX - fileFrame.minX,
                dy: visible.midY - direction * distance - fileFrame.minY))
            let end = origin.withOffset(CGVector(dx: visible.midX - fileFrame.minX,
                dy: visible.midY + direction * distance - fileFrame.minY))
            observations.append("scroll=\(attempt + 1), start=\(start.screenPoint), end=\(end.screenPoint)")
            attachScreen("system-file-before-scroll-\(attempt + 1)")
            start.press(forDuration: 0.1, thenDragTo: end)
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        }
        attachScreen("system-file-could-not-reveal")
        XCTFail("The exact fixture file row did not become fully visible and hittable after bounded Files scrolling")
        return cell
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

    func testSystemFilesProviderCanOpenFixture() throws {
        app.terminate()
        // Exercise the same installed app's Documents provider without
        // WebKit or UIDocumentPicker. Merely listing its filename is not a pass.
        app.launchEnvironment["MARINARA_TEST_FILE_PANEL"] = "1"
        app.launchEnvironment["MARINARA_TEST_FILES_CONTROL"] = "1"
        launchReady()
        let prefix = "Import fixture: "
        let description = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
        XCTAssertTrue(description.waitForExistence(timeout: 30), "The app did not create its import fixture")
        let filename = String(description.label.dropFirst(prefix.count))
        XCTAssertNotNil(filename.range(of: "^marinar-ios-import-[0-9a-f]{8}\\.json$", options: .regularExpression),
                        "The app did not expose a valid unique fixture filename")
        let stem = (filename as NSString).deletingPathExtension
        let fixtureEvidence = XCTAttachment(string: "Expected installed-app fixture: \(filename)")
        fixtureEvidence.name = "system-files-expected-fixture"
        fixtureEvidence.lifetime = .keepAlways
        add(fixtureEvidence)

        let files = XCUIApplication(bundleIdentifier: "com.apple.DocumentsApp")
        systemFilesApp = files
        defer {
            attachSystemFilesEvidence("system-files-final")
            files.terminate()
            systemFilesApp = nil
        }
        files.launchArguments = app.launchArguments
        files.launch()
        XCTAssertTrue(files.wait(for: .runningForeground, timeout: 30), "The system Files app did not launch")
        attachSystemFilesEvidence("system-files-launched")

        let location = files.staticTexts.matching(NSPredicate(format:
            "label == 'On My iPhone' OR label == 'On My iPad'")).firstMatch
        // iPad Files can open Recents with its locations sidebar collapsed.
        // Open the observed sidebar once; Back there navigates history, not
        // the folder hierarchy, and otherwise loops between Recents/Browse.
        let sidebar = files.buttons["ToggleSideBar"].firstMatch
        if !(location.exists && location.isHittable), sidebar.exists && sidebar.isEnabled && sidebar.isHittable {
            sidebar.tap()
            let visibleLocation = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == true AND hittable == true"), object: location)
            _ = XCTWaiter.wait(for: [visibleLocation], timeout: 10)
            attachSystemFilesEvidence("system-files-sidebar-opened")
        }
        // Files may start in Recents or retain a browsed folder. Navigate
        // only through native elements actually exposed by the current UI.
        for _ in 0..<6 {
            if location.exists && location.isHittable { break }
            let back = files.navigationBars.buttons.matching(NSPredicate(format:
                "(label == 'Browse' OR label == 'Locations' OR label == 'Back' OR label == 'On My iPhone' OR label == 'On My iPad') AND identifier != 'DOC.navBarButton.backInHistory'")).firstMatch
            let browseTab = files.tabBars.buttons["Browse"].firstMatch
            let browse = files.buttons["Browse"].firstMatch
            if back.exists && back.isEnabled && back.isHittable { back.tap() }
            else if browseTab.exists && browseTab.isEnabled && browseTab.isHittable { browseTab.tap() }
            else if browse.exists && browse.isEnabled && browse.isHittable { browse.tap() }
            else { break }
        }
        attachSystemFilesEvidence("system-files-locations")
        XCTAssertTrue(location.waitForExistence(timeout: 30), "Files did not expose the local device location")
        XCTAssertTrue(location.isHittable, "The local device location is not available")
        location.tap()

        let folder = files.staticTexts["Marinar iOS Test"].firstMatch
        XCTAssertTrue(folder.waitForExistence(timeout: 30), "Files did not expose this installed app's Documents folder")
        XCTAssertTrue(folder.isHittable, "The installed app's Documents folder is not available")
        folder.tap()
        let fixture = files.staticTexts.matching(NSPredicate(format: "label == %@ OR label == %@", filename, stem)).firstMatch
        XCTAssertTrue(fixture.waitForExistence(timeout: 30), "Files did not list the app-created unique fixture")
        attachSystemFilesEvidence("system-files-before-open")
        let cell = files.cells.containing(.staticText, identifier: fixture.label).firstMatch
        if cell.exists {
            XCTAssertTrue(cell.isHittable, "The exact fixture file row is not available")
            cell.tap()
        } else {
            XCTAssertTrue(fixture.isHittable, "The exact fixture filename is not available")
            fixture.tap()
        }

        // The root snapshot can omit remote QuickLook text attributes even
        // while its content is visible. Query the observed TextView directly
        // and require the full JSON inside QuickLook, not a filename/thumbnail.
        let expectedJSON = #"{"fixture":"restored-file-fixture","text":"실제 파일 선택 확인"}"#
        let quickLook = files.otherElements["QLPreviewControllerView"].firstMatch
        let content = quickLook.textViews.matching(NSPredicate(format:
            "label == %@ OR value == %@", expectedJSON, expectedJSON)).firstMatch
        let opened = content.waitForExistence(timeout: 60)
        attachSystemFilesEvidence("system-files-after-open")
        XCTAssertTrue(opened,
                      "Files/QuickLook did not expose the full fixture JSON; inspect the attached system Files screen and accessibility tree")
        let label = content.label
        let value = content.value as? String ?? ""
        let evidence = XCTAttachment(string: "label: \(label)\nvalue: \(value)")
        evidence.name = "system-files-verified-content"
        evidence.lifetime = .keepAlways
        add(evidence)
        XCTAssertTrue(label == expectedJSON || value == expectedJSON,
                      "The QuickLook TextView does not contain the exact fixture JSON")
    }

    private func attachSystemFilesEvidence(_ name: String) {
        guard let files = systemFilesApp else { return }
        attachScreen(name)
        let hierarchy = XCTAttachment(string: files.debugDescription)
        hierarchy.name = "\(name)-accessibility-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
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
            let popover = app.popovers.firstMatch
            let webView = app.webViews["marinar-webview"]
            XCTAssertTrue(popover.exists && webView.exists, "The visible popover and WebView geometry are required")
            let regionFrame = dismissPopup.frame
            let visible = regionFrame.intersection(app.frame).intersection(webView.frame)
            XCTAssertFalse(visible.isNull || visible.isEmpty, "The dismissal region has no visible area inside the app")
            // The automatic hit point reached the extreme left edge and was
            // cancelled. Choose one observed exposed rectangle, with margins
            // from both the popover and the region bounds; do not retry a tap.
            let excluded = popover.frame.insetBy(dx: -12, dy: -12)
            let overlap = visible.intersection(excluded)
            let candidates: [CGRect]
            if overlap.isNull || overlap.isEmpty {
                candidates = [visible]
            } else {
                candidates = [
                    CGRect(x: visible.minX, y: visible.minY, width: visible.width, height: overlap.minY - visible.minY),
                    CGRect(x: visible.minX, y: overlap.maxY, width: visible.width, height: visible.maxY - overlap.maxY),
                    CGRect(x: visible.minX, y: visible.minY, width: overlap.minX - visible.minX, height: visible.height),
                    CGRect(x: overlap.maxX, y: visible.minY, width: visible.maxX - overlap.maxX, height: visible.height),
                ]
            }
            guard let exposed = candidates.filter({ $0.width > 16 && $0.height > 16 })
                .max(by: { $0.width * $0.height < $1.width * $1.height }) else {
                XCTFail("The popover leaves no visible dismissal rectangle with a safe boundary margin")
                return
            }
            let target = exposed.insetBy(dx: 8, dy: 8)
            let coordinate = dismissPopup.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                .withOffset(CGVector(dx: target.midX - regionFrame.minX, dy: target.midY - regionFrame.minY))
            let point = coordinate.screenPoint
            attachGeometry("\(screenshotName)-dismiss-geometry", elements: [("app", app), ("webView", webView),
                ("dismissPopup", dismissPopup), ("popover", popover)])
            let evidence = XCTAttachment(string: "visible=\(visible), excludedPopover=\(excluded), exposed=\(exposed), target=\(target), screenPoint=\(point)")
            evidence.name = "\(screenshotName)-dismiss-coordinate"
            evidence.lifetime = .keepAlways
            add(evidence)
            XCTAssertTrue(target.contains(point) && regionFrame.contains(point) && app.frame.contains(point)
                && webView.frame.contains(point) && visible.contains(point), "The dismissal touch is outside the observed visible region")
            XCTAssertFalse(excluded.contains(point), "The dismissal touch overlaps the popover or its margin")
            coordinate.tap()
        } else { XCTFail("The native share UI has no available dismissal action") }
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: filename)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: save)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: close)
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: dismissPopup)
        waitForExpectations(timeout: 15)
    }
}
