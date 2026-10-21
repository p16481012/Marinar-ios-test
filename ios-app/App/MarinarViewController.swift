import UIKit
import WebKit
import CryptoKit

final class MarinarViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, UIPopoverPresentationControllerDelegate {
    private var configuration: RuntimeConfiguration?
    private var webView: WKWebView!
    private let overlay = UIStackView()
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let retryButton = UIButton(type: .system)
    private var timer: Timer?
    private var startup = StartupAttempt()
    private enum StartupPhase: String { case idle, rules, cookie, health, navigation, frontend, ready, failed }
    private var startupPhase: StartupPhase = .idle
    private var healthTask: URLSessionDataTask?
    private var startupNavigation: WKNavigation?
    private var navigationPending = false
    private var abandonedNavigations: [WKNavigation] = []
    private var frontendCheckPending = false
    private var loopbackRules: WKContentRuleList?
    private var originHintInstalled = false
    private var probing = false
    private var webSessionReady = false
    private var active = true
    private var terminalFailure = false
    private var restoreScriptID: String?
    private var testSelectionInstalled = false
    #if DEBUG
    private var testImportFixtureFilename: String?
    private var testSettingsRestoreFixturePrepared = false
    private var startupStallConsumed = false
    // Test outputs and configuration stay outside the user-visible Documents
    // provider. Preserve them across app launches for independent host checks.
    private static let diagnosticsDirectory: URL = {
        let manager = FileManager.default
        let directory = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Diagnostics", isDirectory: true)
        try? manager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }()
    #endif
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var downloadURLs: [ObjectIdentifier: URL] = [:]
    private var reportedDownloadFailures = Set<ObjectIdentifier>()
    private var pendingShares: [URL] = []
    private var pendingExportErrors: [String] = []
    private var sharing = false
    private let exportDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("MarinarExports", isDirectory: true)
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        return URLSession(configuration: config)
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
        // Only this app's own temporary exports are removed after an interrupted
        // share. Persistent user data lives in Documents/Marinar.
        try? FileManager.default.removeItem(at: exportDirectory)
        view.backgroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1)
        let settings = WKWebViewConfiguration()
        settings.websiteDataStore = .default()
        settings.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: settings)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = view.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.accessibilityIdentifier = "marinar-webview"
        webView.accessibilityValue = "starting"
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        // Web content receives a safe rectangle, including the software keyboard.
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        overlay.axis = .vertical
        overlay.alignment = .center
        overlay.spacing = 20
        overlay.translatesAutoresizingMaskIntoConstraints = false
        spinner.color = .white
        spinner.startAnimating()
        status.text = "Marinar를 준비하고 있습니다…"
        status.textColor = .white
        status.textAlignment = .center
        status.numberOfLines = 0
        status.accessibilityIdentifier = "marinar-startup-status"
        overlay.addArrangedSubview(spinner)
        overlay.addArrangedSubview(status)
        retryButton.setTitle("화면 다시 불러오기", for: .normal)
        retryButton.accessibilityIdentifier = "marinar-retry"
        retryButton.addTarget(self, action: #selector(retryFrontend), for: .touchUpInside)
        retryButton.isHidden = true
        overlay.addArrangedSubview(retryButton)
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            overlay.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            overlay.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48)
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        presentNextShare()
    }

    func start(configuration: RuntimeConfiguration) {
        guard !terminalFailure else { return }
        if let existing = self.configuration,
           existing.origin != configuration.origin || existing.token != configuration.token
            || existing.deploymentId != configuration.deploymentId {
            fail("실행 중인 서버 설정이 변경되었습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요.")
            return
        }
        self.configuration = configuration
        if !originHintInstalled,
           let encoded = try? JSONSerialization.data(withJSONObject: [configuration.origin.absoluteString]),
           let origin = String(data: encoded, encoding: .utf8) {
            let hint = "if (location.origin === \(origin)[0]) window.__MARINARA_IOS_APP__ = true;"
            webView.configuration.userContentController.addUserScript(WKUserScript(source: hint, injectionTime: .atDocumentStart, forMainFrameOnly: true))
            originHintInstalled = true
        }
        beginStartup()
    }

    private var uptime: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func beginStartup() {
        guard configuration != nil, !terminalFailure else { return }
        startup.cancel(at: uptime)
        clearStartupWork(stopNavigation: true)
        webSessionReady = false
        var budget: TimeInterval = 300
        var stallRules = false
        #if DEBUG
        if !startupStallConsumed && ProcessInfo.processInfo.environment["MARINARA_TEST_STARTUP_STALL"] == "rules" {
            startupStallConsumed = true
            stallRules = true
            budget = 4
        }
        #endif
        let generation = startup.begin(at: uptime, budget: budget, active: active)
        overlay.isHidden = false
        retryButton.isHidden = true
        spinner.startAnimating()
        status.text = "Marinar를 준비하고 있습니다…"
        webView.accessibilityValue = "starting"
        setStartupPhase(.rules)
        startWatchdog()
        // Only DEBUG's explicit one-shot test simulates a missing completion.
        // A user retry always executes the real protected session setup.
        guard !stallRules else { return }
        prepareWebSession(generation: generation)
    }

    private func prepareWebSession(generation: UInt64) {
        guard acceptsStartup(generation), let configuration = configuration else { return }
        // Only the exact localhost origin receives this HttpOnly cookie. No
        // credential is injected into JavaScript or URL query strings.
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: "marinara_ios_session", .value: configuration.token,
            .domain: "127.0.0.1", .path: "/",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            HTTPCookiePropertyKey("SameSite"): "Strict"
        ]
        guard let cookie = HTTPCookie(properties: properties), cookie.isHTTPOnly else {
            fail("로컬 서버 세션을 만들 수 없습니다.", canRetry: true)
            return
        }
        // This controller's origin cannot change. Keep an installed rule list
        // active while retrying; old documents may still run subresources.
        if loopbackRules != nil {
            installSessionCookie(cookie, generation: generation)
            return
        }
        // HTTP cookies are scoped to hosts, not ports. Prevent an imported
        // image/iframe/fetch from leaking this cookie to a different localhost
        // service. Navigation delegates alone do not cover subresources.
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": "^https?://([^/]+@)?127[.]0[.]0[.]1(:[0-9]+)?/"],
             "action": ["type": "block"]],
            ["trigger": ["url-filter": "^http://127[.]0[.]0[.]1:\(configuration.port)/"],
             "action": ["type": "ignore-previous-rules"]]
        ]
        guard let rulesData = try? JSONSerialization.data(withJSONObject: rules),
              let rulesJSON = String(data: rulesData, encoding: .utf8) else {
            fail("로컬 서버 세션 보호 규칙을 만들 수 없습니다.", canRetry: true)
            return
        }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "marinar-loopback-port", encodedContentRuleList: rulesJSON) { [weak self] list, error in
            DispatchQueue.main.async {
                guard let self = self, self.acceptsStartup(generation) else { return }
                guard let list = list, error == nil else {
                    self.fail("로컬 서버 세션 보호 규칙을 준비하지 못했습니다.", canRetry: true)
                    return
                }
                self.webView.configuration.userContentController.add(list)
                self.loopbackRules = list
                self.installSessionCookie(cookie, generation: generation)
            }
        }
    }

    private func installSessionCookie(_ cookie: HTTPCookie, generation: UInt64) {
        guard acceptsStartup(generation), loopbackRules != nil else { return }
        setStartupPhase(.cookie)
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            DispatchQueue.main.async {
                guard let self = self, self.acceptsStartup(generation) else { return }
                self.webSessionReady = true
                self.setStartupPhase(.health)
                self.poll()
            }
        }
    }

    private func startWatchdog() {
        timer?.invalidate()
        let generation = startup.generation
        let watchdog = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self, self.startup.accepts(generation) else { return }
            self.poll()
        }
        timer = watchdog
        RunLoop.main.add(watchdog, forMode: .common)
        poll()
    }

    private func acceptsStartup(_ generation: UInt64) -> Bool {
        guard !terminalFailure, startup.accepts(generation) else { return false }
        if startup.isExpired(at: uptime) {
            fail("시작 시간이 초과되었습니다. 다시 시도하거나 앱을 완전히 종료한 뒤 실행해 주세요.", canRetry: true)
            return false
        }
        return true
    }

    private func poll() {
        let generation = startup.generation
        // The deadline applies even while a WebKit or network callback is
        // outstanding. It is independent of the request's own timeouts.
        guard active, acceptsStartup(generation) else { return }
        if startupPhase == .frontend { checkFrontend(generation: generation); return }
        guard startupPhase == .health, webSessionReady, let configuration = configuration, !probing else { return }
        probing = true
        var request = URLRequest(url: configuration.origin.appendingPathComponent("api/ios/health"))
        request.setValue(configuration.token, forHTTPHeaderField: "x-marinara-ios-token")
        let task = session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, self.acceptsStartup(generation), self.startupPhase == .health else { return }
                self.probing = false
                self.healthTask = nil
                guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      body["ready"] as? Bool == true,
                      body["deploymentId"] as? String == configuration.deploymentId else { return }
                self.status.text = "화면을 불러오고 있습니다…"
                self.installRestoreResetIfNeeded(body["restoreAppliedAt"] as? String)
                if !self.testSelectionInstalled {
                    self.installTestSelectionIfNeeded()
                    self.testSelectionInstalled = true
                }
                self.setStartupPhase(.navigation)
                self.startupNavigation = self.webView.load(URLRequest(url: configuration.origin))
                self.navigationPending = self.startupNavigation != nil
            }
        }
        healthTask = task
        task.resume()
    }

    private func checkFrontend(generation: UInt64) {
        guard active, acceptsStartup(generation), startupPhase == .frontend, !frontendCheckPending else { return }
        frontendCheckPending = true
        let navigation = startupNavigation
        webView.evaluateJavaScript("Boolean(document.getElementById('root')?.children.length && document.querySelector('button,textarea,input,a'))") { [weak self] result, _ in
            guard let self = self, self.acceptsStartup(generation), self.startupNavigation === navigation,
                  self.startupPhase == .frontend else { return }
            self.frontendCheckPending = false
            if result as? Bool == true {
                guard self.startup.finish(generation, at: self.uptime) else { return }
                self.clearStartupWork(stopNavigation: false)
                self.navigationPending = false
                self.setStartupPhase(.ready)
                self.overlay.isHidden = true
                self.spinner.stopAnimating()
                self.webView.accessibilityValue = "ready"
                #if DEBUG
                self.prepareSettingsRestoreFixtureIfNeeded()
                self.installMoreTouchDiagnosticsIfNeeded()
                #endif
                self.installFileDiagnosticsIfNeeded()
                self.recordRestoreDiagnosticsIfNeeded()
            }
        }
    }

    private func clearStartupWork(stopNavigation: Bool) {
        timer?.invalidate()
        timer = nil
        healthTask?.cancel()
        healthTask = nil
        probing = false
        frontendCheckPending = false
        if stopNavigation {
            if let navigation = startupNavigation {
                abandonedNavigations.append(navigation)
                abandonedNavigations = Array(abandonedNavigations.suffix(16))
            }
            startupNavigation = nil
            navigationPending = false
            webView.stopLoading()
        }
    }

    private func setStartupPhase(_ phase: StartupPhase) {
        startupPhase = phase
        recordStartupState()
    }

    private func recordStartupState() {
        #if DEBUG
        // No URLs, tokens, API credentials or user content enter diagnostics.
        NSLog("[Marinar startup] attempt=%llu phase=%@ state=%@ active=%d", startup.generation,
              startupPhase.rawValue, startup.status.rawValue, active ? 1 : 0)
        let record: [String: Any] = ["generation": startup.generation, "phase": startupPhase.rawValue,
            "state": startup.status.rawValue, "active": active, "elapsedActive": startup.elapsed(at: uptime),
            "budget": startup.budget, "terminalFailure": terminalFailure, "injectedStall": startupStallConsumed,
            "pid": ProcessInfo.processInfo.processIdentifier]
        if let data = try? JSONSerialization.data(withJSONObject: record) {
            try? data.write(to: Self.diagnosticsDirectory.appendingPathComponent("startup-state.json"), options: .atomic)
            // XCTest can intentionally terminate the app after proving the UI
            // is ready. Preserve that real success separately from exit-time
            // callbacks, while keeping the ordinary final-state log intact.
            if startupPhase == .ready, startup.status == .ready, !terminalFailure {
                try? data.write(to: Self.diagnosticsDirectory.appendingPathComponent("startup-ready-state.json"), options: .atomic)
            }
        }
        #endif
    }

    func fail(_ message: String, canRetry: Bool = false) {
        guard !terminalFailure || !canRetry else { return }
        if !startup.fail(startup.generation, at: uptime) {
            // An external fatal error (for example Node exiting) also retires
            // a previously ready screen. Its completed attempt cannot resume.
            startup.cancel(at: uptime)
        }
        clearStartupWork(stopNavigation: true)
        overlay.isHidden = false
        spinner.stopAnimating()
        status.text = message
        terminalFailure = !canRetry
        retryButton.isHidden = !canRetry
        webView.accessibilityValue = "failed"
        setStartupPhase(.failed)
    }

    @objc private func retryFrontend() {
        guard configuration != nil, !terminalFailure else { return }
        beginStartup()
    }

    func enteredBackground() {
        active = false
        startup.pause(at: uptime)
        recordStartupState()
        guard let configuration = configuration, backgroundTask == .invalid else { return }
        // iOS may suspend the process shortly. Request an actual durable flush
        // while the finite background grace period is available.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Persist chat") { [weak self] in self?.finishBackgroundTask() }
        var request = URLRequest(url: configuration.origin.appendingPathComponent("api/ios/flush"))
        request.httpMethod = "POST"
        request.setValue(configuration.token, forHTTPHeaderField: "x-marinara-ios-token")
        request.setValue(configuration.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("1", forHTTPHeaderField: "x-marinara-csrf")
        #if DEBUG
        let backgroundDiagnostics = ProcessInfo.processInfo.environment["MARINARA_TEST_DIAGNOSTICS"] == "1"
            ? MarinarViewController.diagnosticsDirectory : nil
        #endif
        session.dataTask(with: request) { [weak self] data, response, error in
            // Do not claim success on a transport/server error. Regular server
            // persistence still applies, but this flush is only best effort.
            let responseCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let maintenance = error == nil && ((responseCode == 409 && body?["code"] as? String == "IOS_RESTORE_PENDING")
                || (responseCode == 503 && body?["code"] as? String == "IOS_MAINTENANCE_BUSY"))
            if maintenance {
                NSLog("[Marinar] Background flush deferred during backup or restore")
            } else if error != nil || responseCode != 200 {
                NSLog("[Marinar] Background flush did not complete")
            }
            #if DEBUG
            if let diagnostics = backgroundDiagnostics {
                let result: [String: Any] = ["succeeded": error == nil && responseCode == 200,
                                           "status": responseCode, "maintenance": maintenance]
                if let json = try? JSONSerialization.data(withJSONObject: result) {
                    try? json.write(to: diagnostics.appendingPathComponent("ios-background-flush-result.json"), options: .atomic)
                }
            }
            #endif
            DispatchQueue.main.async { self?.finishBackgroundTask() }
        }.resume()
    }

    private func finishBackgroundTask() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    func becameActive() {
        active = true
        startup.resume(at: uptime)
        recordStartupState()
        if startup.status == .running && !terminalFailure { poll() }
        presentNextShare()
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === self.webView, let navigation = navigation, !terminalFailure,
              !abandonedNavigations.contains(where: { $0 === navigation }) else { return }
        guard startup.status == .ready || (startup.status == .running
              && (startupPhase == .navigation || startupPhase == .frontend)) else { return }
        if let previous = startupNavigation, previous !== navigation {
            abandonedNavigations.append(previous)
            abandonedNavigations = Array(abandonedNavigations.suffix(16))
        }
        startupNavigation = navigation
        navigationPending = true
        frontendCheckPending = false
        if startup.status == .running { setStartupPhase(.navigation) }
        // A ready page may navigate to a downloadable response. Keep that page
        // ready until a replacement document actually finishes; WKDownload
        // conversions never produce didFinish and must not leave an overlay.
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === self.webView, let navigation = navigation, startupNavigation === navigation,
              navigationPending, !terminalFailure else { return }
        if startup.status == .ready {
            startup.begin(at: uptime, active: active)
            setStartupPhase(.frontend)
            startWatchdog()
        }
        guard acceptsStartup(startup.generation) else { return }
        setStartupPhase(.frontend)
        checkFrontend(generation: startup.generation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView, let navigation = navigation, startupNavigation === navigation,
              navigationPending, !terminalFailure, (error as NSError).code != NSURLErrorCancelled else { return }
        if startup.status == .ready { startup.begin(at: uptime, active: active) }
        if acceptsStartup(startup.generation) { fail("화면 연결 실패: \(error.localizedDescription)", canRetry: true) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard webView === self.webView, let navigation = navigation, startupNavigation === navigation,
              navigationPending, !terminalFailure, (error as NSError).code != NSURLErrorCancelled else { return }
        if startup.status == .ready { startup.begin(at: uptime, active: active) }
        if acceptsStartup(startup.generation) { fail("화면 로드 실패: \(error.localizedDescription)", canRetry: true) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard webView === self.webView, !terminalFailure,
              startup.status == .running || startup.status == .ready else { return }
        if startup.status == .running {
            fail("화면 준비가 중단되었습니다. 화면을 다시 불러와 주세요.", canRetry: true)
            return
        }
        beginStartup()
        status.text = "화면을 복구하고 있습니다…"
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == configuration?.port
    }

    private func isLocalBlob(_ url: URL) -> Bool {
        guard let origin = configuration?.origin.absoluteString else { return false }
        return url.scheme == "blob" && url.absoluteString.hasPrefix("blob:" + origin + "/")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        recordExportEventIfNeeded("navigation-action", fields: ["scheme": navigationAction.request.url?.scheme ?? "none",
            "newWindow": navigationAction.targetFrame == nil, "shouldPerformDownload": navigationAction.shouldPerformDownload])
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload || (isLocalBlob(url) && navigationAction.targetFrame == nil) {
            decisionHandler(isLocal(url) || isLocalBlob(url) ? .download : .cancel)
            return
        }
        if isLocal(url) || url.absoluteString == "about:blank" || isLocalBlob(url) {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        recordExportEventIfNeeded("navigation-response", fields: ["scheme": navigationResponse.response.url?.scheme ?? "none",
            "canShowMIMEType": navigationResponse.canShowMIMEType])
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        recordExportEventIfNeeded("new-window", fields: ["scheme": navigationAction.request.url?.scheme ?? "none",
            "shouldPerformDownload": navigationAction.shouldPerformDownload])
        if let url = navigationAction.request.url, isLocal(url) { webView.load(navigationAction.request) }
        return nil
    }

    // WKWebView needs these delegates for window.confirm/alert/prompt. The
    // upstream UI uses confirm when importing embedded lore and discarding edits.
    private func canPresentDialog(from frame: WKFrameInfo) -> Bool {
        active && presentedViewController == nil && frame.isMainFrame && frame.request.url.map(isLocal) == true
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard canPresentDialog(from: frame) else { completionHandler(); return }
        let alert = UIAlertController(title: "Marinar", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard canPresentDialog(from: frame) else { completionHandler(false); return }
        let alert = UIAlertController(title: "Marinar", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "확인", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard canPresentDialog(from: frame) else { completionHandler(nil); return }
        let alert = UIAlertController(title: "Marinar", message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "취소", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "확인", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
        present(alert, animated: true)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        recordExportEventIfNeeded("action-became-download")
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        recordExportEventIfNeeded("response-became-download")
        download.delegate = self
    }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        recordExportEventIfNeeded("download-destination", fields: ["scheme": response.url?.scheme ?? "none",
            "status": (response as? HTTPURLResponse)?.statusCode ?? 0])
        if let response = response as? HTTPURLResponse, !(200...299).contains(response.statusCode) {
            reportedDownloadFailures.insert(ObjectIdentifier(download))
            completionHandler(nil)
            showExportError("서버가 파일을 준비하지 못했습니다 (HTTP \(response.statusCode)). 다시 시도해 주세요.")
            return
        }
        let directory = exportDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            let basename = ((suggestedFilename.replacingOccurrences(of: "\\", with: "/")) as NSString).lastPathComponent
            let clean = String(String.UnicodeScalarView(basename.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }))
            let name = String(clean.prefix(180))
            let url = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "export" : name)
            downloadURLs[ObjectIdentifier(download)] = url
            completionHandler(url)
        } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        recordExportEventIfNeeded("download-finished")
        guard let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) else { return }
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        recordTestDownloadIfNeeded(url)
        pendingShares.append(url)
        presentNextShare()
    }

    private func presentNextShare() {
        guard active, !sharing, !pendingShares.isEmpty || !pendingExportErrors.isEmpty, viewIfLoaded?.window != nil else { return }
        guard presentedViewController == nil else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.presentNextShare() }
            return
        }
        if !pendingExportErrors.isEmpty {
            let alert = UIAlertController(title: "내보내기 실패", message: pendingExportErrors.removeFirst(), preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "확인", style: .default) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self?.presentNextShare() }
            })
            present(alert, animated: true)
            return
        }
        sharing = true
        // Keep a popover dismissal touch from reaching a web control behind it.
        // UIKit's passthrough setting alone can still allow this during transitions.
        webView.isUserInteractionEnabled = false
        recordExportEventIfNeeded("share-presenting")
        let url = pendingShares.removeFirst()
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.view.accessibilityIdentifier = "marinar-export-share"
        if let popover = share.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
            popover.passthroughViews = []
            popover.delegate = self
        }
        share.completionWithItemsHandler = { [weak self] _, _, _, error in
            try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                self?.sharing = false
                self?.webView.isUserInteractionEnabled = true
                if let error = error { self?.showExportError(error.localizedDescription) }
                self?.presentNextShare()
            }
        }
        present(share, animated: true) { [weak self, weak share] in
            #if DEBUG
            guard let share = share else { return }
            let popover = share.popoverPresentationController
            let passthroughViews = popover?.passthroughViews
            let sourceView = popover?.sourceView
            self?.recordExportEventIfNeeded("share-presented", fields: [
                "hasPopoverPresentationController": popover != nil,
                "passthroughViewsIsNil": passthroughViews == nil,
                "passthroughCount": passthroughViews?.count ?? 0,
                "passthroughClasses": passthroughViews?.map { NSStringFromClass(type(of: $0)) } ?? [],
                "isModalInPresentation": share.isModalInPresentation,
                "sourceViewBounds": sourceView.map { NSCoder.string(for: $0.bounds) } ?? ""
            ])
            #endif
        }
    }

    func prepareForPopoverPresentation(_ popoverPresentationController: UIPopoverPresentationController) {
        // Sharing is modal: a tap outside the popover must not activate a
        // web control behind it. Apply this again at UIKit's preparation point.
        popoverPresentationController.passthroughViews = []
    }

    func download(_ download: WKDownload, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, decisionHandler: @escaping (WKDownload.RedirectPolicy) -> Void) {
        decisionHandler(request.url.map(isLocal) == true ? .allow : .cancel)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        recordExportEventIfNeeded("download-failed", fields: ["code": (error as NSError).code])
        if let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        if reportedDownloadFailures.remove(ObjectIdentifier(download)) != nil { return }
        showExportError(error.localizedDescription)
    }

    private func showExportError(_ message: String) {
        pendingExportErrors.append(message)
        presentNextShare()
    }

    #if DEBUG
    func recordNativeTouchIfNeeded(_ fields: [String: Any]) {
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_NATIVE_TOUCH_TRACE"] == "1" else { return }
        recordExportEventIfNeeded("native-touch", fields: fields)
    }
    #endif

    private func recordExportEventIfNeeded(_ name: String, fields: [String: Any] = [:]) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_FILE_PANEL"] == "1" else { return }
        // Keep URLs, credentials, user filenames and server response bodies out
        // of this artifact. Test fixture names, stages and native touches are safe diagnostics.
        let diagnostics = MarinarViewController.diagnosticsDirectory
        let file = diagnostics.appendingPathComponent("ios-export-events.json")
        var events = (try? Data(contentsOf: file)).flatMap {
            (try? JSONSerialization.jsonObject(with: $0)) as? [[String: Any]]
        } ?? []
        var event = fields
        event["event"] = name
        event["time"] = Date().timeIntervalSince1970
        event["pid"] = ProcessInfo.processInfo.processIdentifier
        events.append(event)
        if let data = try? JSONSerialization.data(withJSONObject: Array(events.suffix(200))) {
            try? data.write(to: file, options: .atomic)
        }
        #endif
    }

    private func installRestoreResetIfNeeded(_ restoreID: String?) {
        guard let restoreID = restoreID, !restoreID.isEmpty, restoreID != restoreScriptID,
              let origin = configuration?.origin.absoluteString,
              let encoded = try? JSONSerialization.data(withJSONObject: [origin, restoreID]),
              let values = String(data: encoded, encoding: .utf8) else { return }
        // Run before React/Zustand hydrates. Otherwise an old, newer-dated
        // browser settings snapshot can overwrite the restored server settings.
        // The marker prevents later ordinary app launches from clearing drafts.
        var diagnostic = ""
        var fixtureSeed = ""
        #if DEBUG
        if ProcessInfo.processInfo.environment["MARINARA_TEST_DIAGNOSTICS"] == "1" {
            diagnostic = "window.__MARINARA_RESTORE_TEST__ = {restoreID, skipped, removedKeys, remainingKeys: skipped ? [] : keys.filter(key => localStorage.getItem(key) !== null)};"
            let diagnostics = MarinarViewController.diagnosticsDirectory
            let fixtureURL = diagnostics.appendingPathComponent("ios-restore-cache-fixture.json")
            if let data = try? Data(contentsOf: fixtureURL),
               let fixture = (try? JSONSerialization.jsonObject(with: data)) as? [String: String],
               let encoded = try? JSONSerialization.data(withJSONObject: fixture),
               let json = String(data: encoded, encoding: .utf8) {
                fixtureSeed = "for (const [key, value] of Object.entries(\(json))) localStorage.setItem(key, value);"
                try? FileManager.default.removeItem(at: fixtureURL)
            }
        }
        #endif
        let source = """
        (() => {
          const [origin, restoreID] = \(values);
          if (location.origin !== origin) return;
          \(fixtureSeed)
          const marker = 'marinara-ios-restore-applied';
          const keys = ['marinara-engine-ui', 'marinara-engine-ui:host', 'marinara-engine-ui-updated-at',
                        'marinara-active-chat-id', 'marinara-input-drafts', 'marinara-pending-spatial-transitions',
                        'marinara:pending-game-state-patches:v1', 'marinara-library-folders-v1'];
          const skipped = localStorage.getItem(marker) === restoreID;
          const removedKeys = skipped ? [] : keys.filter(key => localStorage.getItem(key) !== null);
          if (!skipped) {
            for (const key of keys) { localStorage.removeItem(key); sessionStorage.removeItem(key); }
            localStorage.setItem(marker, restoreID);
          }
          \(diagnostic)
        })();
        """
        webView.configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        restoreScriptID = restoreID
    }

    private func recordRestoreDiagnosticsIfNeeded() {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_DIAGNOSTICS"] == "1" else { return }
        let diagnostics = MarinarViewController.diagnosticsDirectory
        webView.evaluateJavaScript("window.__MARINARA_RESTORE_TEST__ ?? null") { value, _ in
            guard let value = value as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: value) else { return }
            try? data.write(to: diagnostics.appendingPathComponent("ios-restore-cache-result.json"), options: .atomic)
        }
        #endif
    }

    #if DEBUG
    private func installMoreTouchDiagnosticsIfNeeded() {
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_MORE_TOUCH_TRACE"] == "1" else { return }
        let script = """
        (() => {
          if (document.getElementById('ios-more-touch-trace')) return;
          const output = document.createElement('p');
          output.id = 'ios-more-touch-trace';
          output.style = 'position:fixed;left:8px;bottom:2px;right:8px;height:12px;overflow:hidden;font-size:8px;line-height:12px;z-index:2147483647;pointer-events:none';
          document.body.append(output);
          let sequence = 0, current = null, trigger = null, queued = false;
          const button = () => document.querySelector('button[data-topbar-more]');
          const opened = () => button()?.getAttribute('aria-expanded') === 'true'
            || !!document.querySelector('[data-component="TopbarMoreMenu"][role="menu"]');
          const publish = () => {
            queued = false;
            if (current && opened()) current.opened = true;
            output.textContent = 'Marinar More touch: ' + JSON.stringify({
              version: 1, sequence, targetPresent: !!button(),
              targetStable: !current || (button() === trigger && trigger.isConnected),
              open: opened(), current
            });
          };
          const schedule = () => {
            if (!queued) { queued = true; queueMicrotask(publish); }
          };
          // Observe only test metadata. Never dispatch events, call a product
          // handler, prevent defaults, capture a pointer, or change app state.
          let observedButton = button();
          const observer = new MutationObserver(records => {
            const next = button();
            let changed = next !== observedButton;
            if (current) {
              const removed = records.some(r => Array.from(r.removedNodes).some(n => n === trigger || n.contains(trigger)));
              if ((next !== trigger || removed) && !current.unknown) { current.unknown = true; changed = true; }
              const attributes = records.filter(r => r.type === 'attributes' && r.target === trigger);
              if (attributes.length) {
                if (opened() || attributes.some(r => r.oldValue === 'true')) current.opened = true;
                changed = true;
              }
            }
            observedButton = next;
            if (changed) schedule();
          });
          observer.observe(document.body, {childList:true, subtree:true, attributes:true,
            attributeFilter:['aria-expanded'], attributeOldValue:true});
          const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel',
                         'touchstart', 'touchmove', 'touchend', 'touchcancel', 'click'];
          for (const type of types) document.addEventListener(type, event => {
            const target = event.target instanceof Element ? event.target.closest('button[data-topbar-more]') : null;
            if (type === 'pointerdown' && target) {
              trigger = target;
              current = {sequence: ++sequence, pointerId:event.pointerId, touchId:null,
                x:event.clientX, y:event.clientY, maxDistance:0, trusted:true, sameTarget:true,
                unknown:false, opened:opened(), pointerdown:0, pointerup:0, pointercancel:0,
                touchstart:0, touchend:0, touchcancel:0, click:0, events:[]};
            }
            if (!current) return;
            if (target !== trigger) current.sameTarget = false;
            if (!event.isTrusted) current.trusted = false;
            let point = event;
            if (type.startsWith('pointer')) {
              if (event.pointerId !== current.pointerId || event.pointerType !== 'touch' || !event.isPrimary) current.unknown = true;
            } else if (type.startsWith('touch')) {
              if (event.changedTouches.length !== 1 || (event.touches.length !== 1 && !['touchend', 'touchcancel'].includes(type))) current.unknown = true;
              point = event.changedTouches[0];
              if (type === 'touchstart' && point) current.touchId = point.identifier;
              if (!point || point.identifier !== current.touchId) current.unknown = true;
            }
            if (!point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) current.unknown = true;
            else current.maxDistance = Math.max(current.maxDistance, Math.hypot(point.clientX-current.x, point.clientY-current.y));
            if (Object.hasOwn(current, type)) current[type]++;
            if (current.events.length < 16) current.events.push({
              type, x:point?.clientX ?? null, y:point?.clientY ?? null,
              sameTarget:target === trigger, trusted:event.isTrusted
            }); else current.unknown = true;
            schedule();
          }, {capture:true, passive:true});
          publish();
        })();
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }
    #endif


    #if DEBUG
    private func prepareSettingsRestoreFixtureIfNeeded() {
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_SETTINGS_RESTORE"] == "1",
              !testSettingsRestoreFixturePrepared else { return }
        testSettingsRestoreFixturePrepared = true
        let manager = FileManager.default
        let diagnostics = MarinarViewController.diagnosticsDirectory
        let resultURL = diagnostics.appendingPathComponent("ios-settings-restore-fixture.json")
        var result: [String: Any] = ["verified": false, "pid": ProcessInfo.processInfo.processIdentifier]
        do {
            let source = diagnostics.appendingPathComponent("ios-settings-restore-source.zip")
            let attributes = try manager.attributesOfItem(atPath: source.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  let size = (attributes[.size] as? NSNumber)?.intValue,
                  size >= 22, size <= 128 * 1024 * 1024 else {
                throw NSError(domain: "MarinarSettingsRestoreFixture", code: 1)
            }
            func digest(_ url: URL) throws -> (size: Int, sha256: String) {
                let file = try FileHandle(forReadingFrom: url)
                defer { try? file.close() }
                var hash = SHA256()
                var bytes = 0
                while let chunk = try file.read(upToCount: 128 * 1024), !chunk.isEmpty {
                    bytes += chunk.count
                    guard bytes <= 128 * 1024 * 1024 else {
                        throw NSError(domain: "MarinarSettingsRestoreFixture", code: 4)
                    }
                    hash.update(data: chunk)
                }
                return (bytes, hash.finalize().map { String(format: "%02x", $0) }.joined())
            }
            let expected = try digest(source)
            guard expected.size == size else {
                throw NSError(domain: "MarinarSettingsRestoreFixture", code: 5)
            }
            let filename = "marinar-ios-full-restore-ui.zip"
            let documents = manager.urls(for: .documentDirectory, in: .userDomainMask).first!
            let destination = documents.appendingPathComponent(filename)
            let reused = manager.fileExists(atPath: destination.path)
            // Create this file after XCTest installs and launches the app. A
            // subsequent cold launch verifies it without replacing its inode.
            if reused {
                let existing = try manager.attributesOfItem(atPath: destination.path)
                guard existing[.type] as? FileAttributeType == .typeRegular,
                      (existing[.size] as? NSNumber)?.intValue == expected.size else {
                    throw NSError(domain: "MarinarSettingsRestoreFixture", code: 2)
                }
            } else {
                try manager.copyItem(at: source, to: destination)
            }
            let received = try digest(destination)
            guard received.size == expected.size, received.sha256 == expected.sha256 else {
                throw NSError(domain: "MarinarSettingsRestoreFixture", code: 3)
            }
            result = ["verified": true, "filename": filename, "size": received.size,
                      "sha256": received.sha256,
                      "reused": reused, "pid": ProcessInfo.processInfo.processIdentifier]
        } catch {
            result["code"] = (error as NSError).code
        }
        if let encoded = try? JSONSerialization.data(withJSONObject: result) {
            try? encoded.write(to: resultURL, options: .atomic)
        }
    }
    #endif

    private func installFileDiagnosticsIfNeeded() {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_FILE_PANEL"] == "1" else { return }
        let fileManager = FileManager.default
        let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let filesControl = ProcessInfo.processInfo.environment["MARINARA_TEST_FILES_CONTROL"] == "1"
        // The picker gets a new fixture on each launch. The separate Files
        // control reuses that exact verified file when it still exists, so a
        // successful QuickLook cannot be mistaken for reading a different item.
        // Store only its name in private tmp, outside user data and backups.
        // Cache the successful choice so later page loads never replace it.
        if testImportFixtureFilename == nil {
            do {
                let marker = fileManager.temporaryDirectory.appendingPathComponent("marinar-ios-last-import-fixture.txt")
                let expected = try JSONSerialization.data(withJSONObject: [
                    "fixture": "restored-file-fixture", "text": "실제 파일 선택 확인",
                ], options: [.sortedKeys])
                var filename = "marinar-ios-import-\(UUID().uuidString.prefix(8).lowercased()).json"
                var reused = false
                if filesControl && fileManager.fileExists(atPath: marker.path) {
                    let previous = try String(contentsOf: marker, encoding: .utf8)
                    guard previous.range(of: "\\Amarinar-ios-import-[0-9a-f]{8}\\.json\\z", options: .regularExpression) != nil else {
                        throw NSError(domain: "MarinarTestFixture", code: 2)
                    }
                    let previousFile = documents.appendingPathComponent(previous)
                    if fileManager.fileExists(atPath: previousFile.path) {
                        let attributes = try fileManager.attributesOfItem(atPath: previousFile.path)
                        guard attributes[.type] as? FileAttributeType == .typeRegular,
                              (attributes[.size] as? NSNumber)?.intValue == expected.count,
                              try Data(contentsOf: previousFile) == expected else {
                            throw NSError(domain: "MarinarTestFixture", code: 3)
                        }
                        filename = previous
                        reused = true
                    }
                }
                let file = documents.appendingPathComponent(filename)
                if !reused {
                    try expected.write(to: file, options: .atomic)
                    guard try Data(contentsOf: file) == expected else {
                        throw NSError(domain: "MarinarTestFixture", code: 1)
                    }
                    try Data(filename.utf8).write(to: marker, options: .atomic)
                }
                testImportFixtureFilename = filename
                recordExportEventIfNeeded(reused ? "import-fixture-reused" : "import-fixture-created",
                    fields: ["bytes": expected.count, "verified": true, "reused": reused, "filename": filename])
            } catch {
                recordExportEventIfNeeded("import-fixture-failed", fields: ["code": (error as NSError).code])
                return
            }
        }
        guard let fixtureFilename = testImportFixtureFilename else { return }
        let options = (try? Data(contentsOf: MarinarViewController.diagnosticsDirectory.appendingPathComponent("ios-file-test-config.json"))).flatMap {
            (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
        } ?? [:]
        let prepareBackup = options["prepareBackup"] as? Bool == true && !filesControl
        let panelValues: [Any] = [prepareBackup, fixtureFilename]
        guard let encoded = try? JSONSerialization.data(withJSONObject: panelValues),
              let values = String(data: encoded, encoding: .utf8) else { return }
        let script = """
        (() => {
          if (document.getElementById('ios-file-diagnostics')) return;
          const panel = document.createElement('section');
          panel.id = 'ios-file-diagnostics';
          panel.style = 'position:fixed;inset:8px;z-index:2147483647;background:white;color:black;padding:16px;overflow:auto';
          panel.innerHTML = '<h1>iOS file diagnostics</h1><button id="ios-test-export">Export test JSON</button><button id="ios-test-error">Test failed export</button><hr><p id="ios-import-fixture"></p><label>Choose test file<input id="ios-test-file" type="file" accept="application/json,.json"></label><hr><button id="ios-test-confirm">Test confirmation</button><p id="ios-file-result"></p><aside id="ios-event-result" style="position:fixed;bottom:16px;left:24px;right:24px;height:70px;font-size:12px;overflow:auto;pointer-events:none"></aside><p id="ios-export-result" style="position:fixed;bottom:90px;left:24px;right:24px;height:30px;font-size:14px;pointer-events:none">Export handler idle</p>';
          panel.querySelector('#ios-import-fixture').textContent = 'Import fixture: ' + \(values)[1];
          const events = [];
          let displayEvents;
          for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel', 'click']) {
            document.addEventListener(type, event => {
              const point = event.changedTouches?.[0] || event;
              events.push(type + ':' + (event.target.id || event.target.tagName) + '@' + Math.round(point.clientX) + ',' + Math.round(point.clientY));
              if (events.length > 32) events.shift();
              clearTimeout(displayEvents);
              displayEvents = setTimeout(() => {
                panel.querySelector('#ios-event-result').textContent = events.slice(-8).join(' > ');
              }, 400);
            }, {capture:true, passive:true});
          }
          const directDownload = (url, name) => {
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
            document.body.append(anchor); anchor.click(); anchor.remove();
          };
          if (\(values)[0]) {
            const button = document.createElement('button'); button.textContent = 'Preparing streamed archive'; button.disabled = true;
            panel.insertBefore(button, panel.querySelector('#ios-test-error'));
            (async () => {
              const started = await fetch('/api/ios/backup/start', {method:'POST', headers:{'Content-Type':'application/json','x-marinara-csrf':'1'}, body:'{}'});
              if (started.status !== 202) throw new Error('Backup start HTTP ' + started.status);
              for (let attempt = 0; attempt < 360; attempt++) {
                const response = await fetch('/api/ios/backup/status');
                if (!response.ok) throw new Error('Backup status HTTP ' + response.status);
                const state = await response.json();
                if (state.status === 'failed') throw new Error(state.error || 'Backup failed');
                if (state.status === 'ready') {
                  if (state.downloadUrl !== '/api/ios/backup/download') throw new Error('Unexpected download URL');
                  button.textContent = 'Export streamed archive'; button.disabled = false;
                  button.onclick = () => directDownload(state.downloadUrl, state.filename);
                  return;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
              }
              throw new Error('Backup preparation timed out');
            })().catch(error => { button.textContent = 'Streamed archive failed: ' + error.message; });
          }
          for (const button of panel.querySelectorAll('button,input')) button.style = 'font-size:18px;min-height:44px;margin:8px;display:block;max-width:calc(100% - 16px);box-sizing:border-box';
          document.body.append(panel);
          panel.querySelector('#ios-test-export').onclick = () => {
            const result = panel.querySelector('#ios-export-result');
            result.textContent = 'Export handler started';
            try {
              const url = URL.createObjectURL(new Blob(['{"fixture":"marinar-ios","text":"파일 내보내기"}'], {type:'application/json'}));
              const anchor = document.createElement('a');
              anchor.href = url; anchor.download = 'marinar-ios-export.json'; anchor.target = '_blank'; anchor.rel = 'noopener';
              document.body.append(anchor); anchor.click(); anchor.remove();
              setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (error) { result.textContent = 'Export handler failed: ' + error.message; }
          };
          panel.querySelector('#ios-test-file').onchange = async (event) => {
            const file = event.target.files[0];
            const result = panel.querySelector('#ios-file-result');
            try {
              result.textContent = file ? 'Imported: ' + file.name + ' ' + await file.text() : 'No file selected';
            } catch (error) { result.textContent = 'Import failed: ' + error.message; }
          };
          panel.querySelector('#ios-test-confirm').onclick = () => {
            panel.querySelector('#ios-file-result').textContent = confirm('Confirm the iOS test?') ? 'Confirmation accepted' : 'Confirmation cancelled';
          };
          panel.querySelector('#ios-test-error').onclick = () => directDownload('/api/ios/missing-download-fixture', 'marinar-ios-error.json');
        })();
        """
        webView.evaluateJavaScript(script) { [weak self] _, error in
            self?.recordExportEventIfNeeded("diagnostics-installed", fields: ["succeeded": error == nil])
        }
        #endif
    }

    private func recordTestDownloadIfNeeded(_ url: URL) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_FILE_PANEL"] == "1",
              let handle = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? handle.close() }
        var hash = SHA256()
        var size = 0
        do {
            while let chunk = try handle.read(upToCount: 128 * 1024), !chunk.isEmpty { hash.update(data: chunk); size += chunk.count }
        } catch { return }
        let result: [String: Any] = ["filename": url.lastPathComponent, "size": size,
            "sha256": hash.finalize().map { String(format: "%02x", $0) }.joined()]
        let diagnostics = MarinarViewController.diagnosticsDirectory
        if url.pathExtension == "zip", size >= 16 * 1024 * 1024 {
            // Preserve both sides of this DEBUG fixture transfer. The host
            // independently hashes them after XCTest restarts the app again.
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let archives = (try? FileManager.default.contentsOfDirectory(at: support.appendingPathComponent("ios-backup"), includingPropertiesForKeys: nil))?.filter { $0.pathExtension == "zip" } ?? []
            let source = archives.first { $0.lastPathComponent == url.lastPathComponent } ?? (archives.count == 1 ? archives.first : nil)
            if let source = source {
                for (from, name) in [(source, "ios-streamed-source.zip"), (url, "ios-streamed-download.zip")] {
                    let target = diagnostics.appendingPathComponent(name)
                    try? FileManager.default.removeItem(at: target)
                    try? FileManager.default.copyItem(at: from, to: target)
                }
            }
        }
        let resultURL = diagnostics.appendingPathComponent("ios-download-result.json")
        var previous = (try? Data(contentsOf: resultURL)).flatMap {
            (try? JSONSerialization.jsonObject(with: $0)) as? [[String: Any]]
        } ?? []
        previous.append(result)
        if let json = try? JSONSerialization.data(withJSONObject: previous) {
            try? json.write(to: resultURL, options: .atomic)
        }
        #endif
    }

    private func installTestSelectionIfNeeded() {
        #if DEBUG
        // Test-only setup chooses an existing chat; it never fakes a reply or
        // bypasses the real UI send path. This code is absent in Release IPA.
        let diagnostics = MarinarViewController.diagnosticsDirectory
        let selectionURL = diagnostics.appendingPathComponent("ios-test-selection.json")
        let selection = (try? Data(contentsOf: selectionURL)).flatMap {
            (try? JSONSerialization.jsonObject(with: $0)) as? [String: Any]
        } ?? [:]
        guard let id = ProcessInfo.processInfo.environment["MARINARA_TEST_CHAT_ID"] ?? selection["chatId"] as? String, !id.isEmpty,
              let version = selection["uiStateVersion"] as? Int,
              let data = try? JSONSerialization.data(withJSONObject: [id, Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""]),
              let json = String(data: data, encoding: .utf8) else { return }
        let script = """
        if (location.origin === 'http://127.0.0.1:7860') {
            localStorage.setItem('marinara-active-chat-id', \(json)[0]);
            const key = 'marinara-engine-ui';
            const previous = JSON.parse(localStorage.getItem(key) || '{"state":{}}');
            previous.version = \(version);
            previous.state = {...previous.state, hasCompletedOnboarding:true, language:'en', sidebarOpen:false,
                rightPanelOpen:false, chatHelpSeenModes:['conversation','roleplay','game'], trackerPanelEnabled:false,
                chibiProfessorMariEnabled:false, chatWindowIntroDismissed:true, seasonalThemesDisabled:true};
            localStorage.setItem(key, JSON.stringify(previous));
            localStorage.setItem(key + ':host', JSON.stringify(previous));
            localStorage.setItem('marinara:whats-new:seen-version', \(json)[1]);
        }
        """
        webView.configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        #endif
    }
}
