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
    private var probing = false
    private var loaded = false
    private var webSessionReady = false
    private var active = true
    private var terminalFailure = false
    private var restoreScriptID: String?
    private var testSelectionInstalled = false
    #if DEBUG
    private var testImportFixtureFilename: String?
    #endif
    private var elapsed: TimeInterval = 0
    private var lastPoll = Date()
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
        self.configuration = configuration
        if let encoded = try? JSONSerialization.data(withJSONObject: [configuration.origin.absoluteString]),
           let origin = String(data: encoded, encoding: .utf8) {
            let hint = "if (location.origin === \(origin)[0]) window.__MARINARA_IOS_APP__ = true;"
            webView.configuration.userContentController.addUserScript(WKUserScript(source: hint, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Only the exact localhost origin receives this HttpOnly cookie. No
        // credential is injected into JavaScript or URL query strings.
        let properties: [HTTPCookiePropertyKey: Any] = [
            .name: "marinara_ios_session", .value: configuration.token,
            .domain: "127.0.0.1", .path: "/",
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
            HTTPCookiePropertyKey("SameSite"): "Strict"
        ]
        guard let cookie = HTTPCookie(properties: properties), cookie.isHTTPOnly else {
            fail("로컬 서버 세션을 만들 수 없습니다.")
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
            fail("로컬 서버 세션 보호 규칙을 만들 수 없습니다.")
            return
        }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "marinar-loopback-port", encodedContentRuleList: rulesJSON) { [weak self] list, error in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard let list = list, error == nil else {
                    self.fail("로컬 서버 세션 보호 규칙을 준비하지 못했습니다.")
                    return
                }
                self.webView.configuration.userContentController.add(list)
                self.webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
                    DispatchQueue.main.async {
                        self.webSessionReady = true
                        self.beginPolling()
                    }
                }
            }
        }
    }

    private func beginPolling() {
        guard !terminalFailure else { return }
        timer?.invalidate()
        elapsed = 0
        lastPoll = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    private func poll() {
        let now = Date()
        defer { lastPoll = now }
        guard active, !terminalFailure, webSessionReady, let configuration = configuration, !probing else { return }
        elapsed += now.timeIntervalSince(lastPoll)
        if elapsed > 300 { fail("서버 시작 시간이 초과되었습니다. 다시 시도하거나 앱을 완전히 종료한 뒤 실행해 주세요.", canRetry: true); return }
        probing = true
        var request = URLRequest(url: configuration.origin.appendingPathComponent("api/ios/health"))
        request.setValue(configuration.token, forHTTPHeaderField: "x-marinara-ios-token")
        session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.terminalFailure else { return }
                self.probing = false
                guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                      let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      body["ready"] as? Bool == true,
                      body["deploymentId"] as? String == configuration.deploymentId else { return }
                self.timer?.invalidate()
                self.timer = nil
                if !self.loaded {
                    self.status.text = "화면을 불러오고 있습니다…"
                    self.loaded = true
                    self.installRestoreResetIfNeeded(body["restoreAppliedAt"] as? String)
                    if !self.testSelectionInstalled {
                        self.installTestSelectionIfNeeded()
                        self.testSelectionInstalled = true
                    }
                    self.webView.load(URLRequest(url: configuration.origin))
                } else {
                    self.checkFrontend()
                }
            }
        }.resume()
    }

    private func checkFrontend(attempt: Int = 0) {
        guard active, !terminalFailure else { return }
        webView.evaluateJavaScript("Boolean(document.getElementById('root')?.children.length && document.querySelector('button,textarea,input,a'))") { [weak self] result, _ in
            guard let self = self, !self.terminalFailure else { return }
            if result as? Bool == true {
                self.overlay.isHidden = true
                self.webView.accessibilityValue = "ready"
                self.installFileDiagnosticsIfNeeded()
                self.recordRestoreDiagnosticsIfNeeded()
            } else if attempt < 120 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.checkFrontend(attempt: attempt + 1) }
            } else {
                self.fail("서버는 실행 중이지만 화면을 표시하지 못했습니다. 화면을 다시 불러와 주세요.", canRetry: true)
            }
        }
    }

    func fail(_ message: String, canRetry: Bool = false) {
        guard !terminalFailure || !canRetry else { return }
        timer?.invalidate()
        timer = nil
        overlay.isHidden = false
        spinner.stopAnimating()
        status.text = message
        terminalFailure = !canRetry
        retryButton.isHidden = !canRetry
        webView.accessibilityValue = "failed"
    }

    @objc private func retryFrontend() {
        guard webSessionReady, !terminalFailure else { return }
        loaded = false
        webView.stopLoading()
        retryButton.isHidden = true
        spinner.startAnimating()
        status.text = "화면을 다시 불러오고 있습니다…"
        webView.accessibilityValue = "starting"
        beginPolling()
    }

    func enteredBackground() {
        active = false
        guard let configuration = configuration, backgroundTask == .invalid else { return }
        // iOS may suspend the process shortly. Request an actual durable flush
        // while the finite background grace period is available.
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Persist chat") { [weak self] in self?.finishBackgroundTask() }
        var request = URLRequest(url: configuration.origin.appendingPathComponent("api/ios/flush"))
        request.httpMethod = "POST"
        request.setValue(configuration.token, forHTTPHeaderField: "x-marinara-ios-token")
        request.setValue(configuration.origin.absoluteString, forHTTPHeaderField: "Origin")
        request.setValue("1", forHTTPHeaderField: "x-marinara-csrf")
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
            if ProcessInfo.processInfo.environment["MARINARA_TEST_DIAGNOSTICS"] == "1" {
                let result: [String: Any] = ["succeeded": error == nil && responseCode == 200,
                                           "status": responseCode, "maintenance": maintenance]
                let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
                if let json = try? JSONSerialization.data(withJSONObject: result) {
                    try? json.write(to: documents.appendingPathComponent("ios-background-flush-result.json"), options: .atomic)
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
        if webSessionReady && !terminalFailure { beginPolling() }
        presentNextShare()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { checkFrontend() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("화면 연결 실패: \(error.localizedDescription)", canRetry: true) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("화면 로드 실패: \(error.localizedDescription)", canRetry: true) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !terminalFailure else { return }
        loaded = false
        overlay.isHidden = false
        spinner.startAnimating()
        status.text = "화면을 복구하고 있습니다…"
        beginPolling()
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
        recordExportEventIfNeeded("native-touch", fields: fields)
    }
    #endif

    private func recordExportEventIfNeeded(_ name: String, fields: [String: Any] = [:]) {
        #if DEBUG
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_NO_FILE_TRACING"] != "1" else { return }
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_FILE_PANEL"] == "1" else { return }
        // Keep URLs, credentials, user filenames and server response bodies out
        // of this artifact. Test fixture names, stages and native touches are safe diagnostics.
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let file = documents.appendingPathComponent("ios-export-events.json")
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
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            let fixtureURL = documents.appendingPathComponent("ios-restore-cache-fixture.json")
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
        webView.evaluateJavaScript("window.__MARINARA_RESTORE_TEST__ ?? null") { value, _ in
            guard let value = value as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: value) else { return }
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            try? data.write(to: documents.appendingPathComponent("ios-restore-cache-result.json"), options: .atomic)
        }
        #endif
    }

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
        let options = (try? Data(contentsOf: documents.appendingPathComponent("ios-file-test-config.json"))).flatMap {
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
        guard ProcessInfo.processInfo.environment["MARINARA_TEST_NO_FILE_TRACING"] != "1" else { return }
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
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        if url.pathExtension == "zip", size >= 16 * 1024 * 1024 {
            // Preserve both sides of this DEBUG fixture transfer. The host
            // independently hashes them after XCTest restarts the app again.
            let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            let archives = (try? FileManager.default.contentsOfDirectory(at: support.appendingPathComponent("ios-backup"), includingPropertiesForKeys: nil))?.filter { $0.pathExtension == "zip" } ?? []
            let source = archives.first { $0.lastPathComponent == url.lastPathComponent } ?? (archives.count == 1 ? archives.first : nil)
            if let source = source {
                for (from, name) in [(source, "ios-streamed-source.zip"), (url, "ios-streamed-download.zip")] {
                    let target = documents.appendingPathComponent(name)
                    try? FileManager.default.removeItem(at: target)
                    try? FileManager.default.copyItem(at: from, to: target)
                }
            }
        }
        let resultURL = documents.appendingPathComponent("ios-download-result.json")
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
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        let selectionURL = documents.appendingPathComponent("ios-test-selection.json")
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
