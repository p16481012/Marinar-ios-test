import UIKit
import WebKit

final class MarinarViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    private var configuration: RuntimeConfiguration?
    private var webView: WKWebView!
    private let overlay = UIStackView()
    private let status = UILabel()
    private let spinner = UIActivityIndicatorView(style: .large)
    private var timer: Timer?
    private var probing = false
    private var loaded = false
    private var webSessionReady = false
    private var active = true
    private var elapsed: TimeInterval = 0
    private var lastPoll = Date()
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var downloadURLs: [ObjectIdentifier: URL] = [:]
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 4
        return URLSession(configuration: config)
    }()

    override func viewDidLoad() {
        super.viewDidLoad()
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
        view.addSubview(overlay)
        NSLayoutConstraint.activate([
            overlay.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            overlay.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            overlay.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -48)
        ])
    }

    func start(configuration: RuntimeConfiguration) {
        self.configuration = configuration
        installTestSelectionIfNeeded()
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
        timer?.invalidate()
        elapsed = 0
        lastPoll = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    private func poll() {
        let now = Date()
        defer { lastPoll = now }
        guard active, webSessionReady, let configuration = configuration, !probing else { return }
        elapsed += now.timeIntervalSince(lastPoll)
        if elapsed > 300 { fail("서버 시작 시간이 초과되었습니다. 앱을 완전히 종료한 뒤 다시 실행해 주세요."); return }
        probing = true
        var request = URLRequest(url: configuration.origin.appendingPathComponent("api/ios/health"))
        request.setValue(configuration.token, forHTTPHeaderField: "x-marinara-ios-token")
        session.dataTask(with: request) { [weak self] data, response, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
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
                    self.webView.load(URLRequest(url: configuration.origin))
                } else {
                    self.checkFrontend()
                }
            }
        }.resume()
    }

    private func checkFrontend(attempt: Int = 0) {
        guard active else { return }
        webView.evaluateJavaScript("Boolean(document.getElementById('root')?.children.length && document.querySelector('button,textarea,input,a'))") { [weak self] result, _ in
            guard let self = self else { return }
            if result as? Bool == true {
                self.overlay.isHidden = true
                self.webView.accessibilityValue = "ready"
            } else if attempt < 120 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.checkFrontend(attempt: attempt + 1) }
            } else {
                self.fail("서버는 실행 중이지만 화면을 표시하지 못했습니다. 앱을 다시 실행해 주세요.")
            }
        }
    }

    func fail(_ message: String) {
        timer?.invalidate()
        timer = nil
        overlay.isHidden = false
        spinner.stopAnimating()
        status.text = message
        webView.accessibilityValue = "failed"
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
        session.dataTask(with: request) { [weak self] _, response, error in
            // Do not claim success on a transport/server error. Regular server
            // persistence still applies, but this flush is only best effort.
            if error != nil || (response as? HTTPURLResponse)?.statusCode != 200 {
                NSLog("[Marinar] Background flush did not complete")
            }
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
        if webSessionReady { beginPolling() }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { checkFrontend() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { fail("화면 연결 실패: \(error.localizedDescription)") }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        overlay.isHidden = false
        spinner.startAnimating()
        status.text = "화면을 복구하고 있습니다…"
        beginPolling()
    }

    private func isLocal(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == configuration?.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        if isLocal(url) || url.scheme == "about" || url.scheme == "blob" {
            decisionHandler(.allow)
        } else {
            decisionHandler(.cancel)
            if navigationAction.targetFrame?.isMainFrame != false, ["http", "https", "mailto"].contains(url.scheme ?? "") {
                UIApplication.shared.open(url)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, isLocal(url) || url.scheme == "blob" { webView.load(navigationAction.request) }
        return nil
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let name = (suggestedFilename as NSString).lastPathComponent
            let url = directory.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "export" : name)
            downloadURLs[ObjectIdentifier(download)] = url
            completionHandler(url)
        } catch { completionHandler(nil) }
    }
    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        present(share, animated: true)
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let alert = UIAlertController(title: "내보내기 실패", message: error.localizedDescription, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "확인", style: .default))
        present(alert, animated: true)
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
