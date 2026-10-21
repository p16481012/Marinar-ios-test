import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var controller: MarinarViewController?
    private var nodeThread: Thread?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let controller = MarinarViewController()
        self.controller = controller
        let window = UIWindow(frame: UIScreen.main.bounds)
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
