import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var controller: MarinarViewController?
    private var nodeThread: Thread?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = MarinarViewController()
        self.controller = controller
        #if DEBUG
        let window: UIWindow
        if ProcessInfo.processInfo.environment["MARINARA_TEST_FILE_PANEL"] == "1" {
            let diagnosticWindow = MarinarDiagnosticWindow(frame: UIScreen.main.bounds)
            diagnosticWindow.diagnosticsController = controller
            window = diagnosticWindow
        } else {
            window = UIWindow(frame: UIScreen.main.bounds)
        }
        #else
        let window = UIWindow(frame: UIScreen.main.bounds)
        #endif
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let (configuration, configURL) = try Runtime.prepare()
                let thread = Thread {
                    // An interrupted restore can temporarily move dataDir aside.
                    // Start outside the replaced directory so bootstrap can
                    // recover its journal before entering the restored data.
                    let workingDirectory = URL(fileURLWithPath: configuration.envFile).deletingLastPathComponent().path
                    let code = NodeBridge.run(withArguments: ["node", configuration.runtimeRoot + "/bootstrap.cjs", configURL.path], workingDirectory: workingDirectory)
                    DispatchQueue.main.async {
                        controller.fail("내장 서버가 종료되었습니다 (\(code)). 앱을 완전히 종료한 뒤 다시 실행해 주세요.")
                    }
                }
                thread.name = "Marinar embedded Node"
                thread.stackSize = 8 * 1024 * 1024
                self.nodeThread = thread
                thread.start()
                DispatchQueue.main.async { controller.start(configuration: configuration) }
            } catch {
                DispatchQueue.main.async { controller.fail(error.localizedDescription) }
            }
        }
        return true
    }

    func applicationDidEnterBackground(_ application: UIApplication) { controller?.enteredBackground() }
    func applicationDidBecomeActive(_ application: UIApplication) { controller?.becameActive() }
}

#if DEBUG
// Observe only. Keep normal UIKit event delivery and record no file contents,
// labels, URLs, or typed text. Buffer writes until the finger leaves the screen.
private final class MarinarDiagnosticWindow: UIWindow {
    weak var diagnosticsController: MarinarViewController?
    private var pendingTouchEvents: [[String: Any]] = []

    override func sendEvent(_ event: UIEvent) {
        super.sendEvent(event)
        guard event.type == .touches, let touches = event.allTouches else { return }
        var finished = false
        for touch in touches {
            let phase: String
            switch touch.phase {
            case .began: phase = "began"
            case .ended: phase = "ended"; finished = true
            case .cancelled: phase = "cancelled"; finished = true
            default: continue
            }
            let location = touch.location(in: self)
            let recognizers = (touch.gestureRecognizers ?? []).map { recognizer -> [String: Any] in
                ["class": NSStringFromClass(type(of: recognizer)), "state": recognizer.state.rawValue]
            }
            pendingTouchEvents.append([
                "phase": phase, "x": Double(location.x), "y": Double(location.y),
                "timestamp": event.timestamp, "windowIsKey": isKeyWindow,
                "windowBounds": NSStringFromCGRect(bounds),
                "viewClass": touch.view.map { NSStringFromClass(type(of: $0)) } ?? "none",
                "recognizers": recognizers,
            ])
        }
        if pendingTouchEvents.count > 100 { pendingTouchEvents = Array(pendingTouchEvents.suffix(100)) }
        if finished {
            let records = pendingTouchEvents
            pendingTouchEvents.removeAll()
            DispatchQueue.main.async { [weak self] in
                for fields in records { self?.diagnosticsController?.recordNativeTouchIfNeeded(fields) }
            }
        }
    }
}
#endif
