import UIKit
import UniformTypeIdentifiers

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = PickerViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class PickerViewController: UIViewController, UIDocumentPickerDelegate {
    private let statusLabel = UILabel()
    private let filenameLabel = UILabel()
    private let contentsLabel = UILabel()
    private let openButton = UIButton(type: .system)
    private var expectedData = Data()
    private var fixtureURL: URL?
    private var reportURL: URL?
    private var report: [String: Any] = [:]
    private var events: [[String: String]] = []

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        statusLabel.accessibilityIdentifier = "picker-status"
        filenameLabel.accessibilityIdentifier = "fixture-filename"
        contentsLabel.accessibilityIdentifier = "fixture-contents"
        for label in [statusLabel, filenameLabel, contentsLabel] {
            label.numberOfLines = 0
            label.font = .preferredFont(forTextStyle: .body)
        }
        openButton.setTitle("Choose created JSON", for: .normal)
        openButton.accessibilityIdentifier = "open-picker"
        openButton.addTarget(self, action: #selector(openPicker), for: .touchUpInside)
        openButton.isEnabled = false
        let stack = UIStackView(arrangedSubviews: [statusLabel, filenameLabel, contentsLabel, openButton])
        stack.axis = .vertical
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24)
        ])
        createFixture()
    }

    private func createFixture() {
        do {
            let manager = FileManager.default
            let documents = try manager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            reportURL = support.appendingPathComponent("native-picker-result.json")
            let nonce = String(UUID().uuidString.lowercased().prefix(8))
            let filename = "native-picker-\(nonce).json"
            let url = documents.appendingPathComponent(filename)
            let text = "{\"fixture\":\"native-uidocumentpicker\",\"nonce\":\"\(nonce)\",\"text\":\"실제 파일 선택 확인\"}\n"
            expectedData = Data(text.utf8)
            try expectedData.write(to: url, options: .atomic)
            let readback = try Data(contentsOf: url)
            guard readback == expectedData else { throw CocoaError(.fileReadCorruptFile) }
            _ = try JSONSerialization.jsonObject(with: readback)
            fixtureURL = url
            filenameLabel.text = filename
            contentsLabel.text = text
            report = ["fixtureFilename": filename, "fixtureURL": url.path,
                      "expectedText": text, "expectedBytes": expectedData.count,
                      "sourceReadbackMatches": true, "delegateCallbackCount": 0, "cancelCallbackCount": 0,
                      "systemVersion": UIDevice.current.systemVersion,
                      "pickerAsCopy": true, "allowedContentType": UTType.json.identifier]
            try record("fixture-ready")
            openButton.isEnabled = true
        } catch {
            statusLabel.text = "fixture-error: \(error.localizedDescription)"
            NSLog("Native picker fixture failed: %@", String(describing: error))
        }
    }

    private func record(_ phase: String) throws {
        events.append(["phase": phase, "time": ISO8601DateFormatter().string(from: Date())])
        report["phase"] = phase
        report["events"] = events
        guard let url = reportURL else { throw CocoaError(.fileNoSuchFile) }
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        statusLabel.text = phase
        NSLog("Native picker phase: %@", phase)
    }

    private func recordFailure(_ error: Error) {
        report["error"] = String(describing: error)
        do { try record("read-or-report-error") }
        catch { statusLabel.text = "report-write-error: \(error.localizedDescription)" }
    }

    @objc private func openPicker() {
        guard fixtureURL != nil else { return }
        do { try record("picker-presented") }
        catch { recordFailure(error); return }
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true)
        picker.allowsMultipleSelection = false
        picker.delegate = self
        present(picker, animated: true)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        report["cancelCallbackCount"] = (report["cancelCallbackCount"] as? Int ?? 0) + 1
        do { try record("cancelled") }
        catch { recordFailure(error) }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        report["delegateCallbackCount"] = (report["delegateCallbackCount"] as? Int ?? 0) + 1
        report["returnedURLCount"] = urls.count
        do {
            try record("delegate-received")
            guard urls.count == 1, let url = urls.first else { throw CocoaError(.fileReadUnknown) }
            report["returnedURL"] = url.path
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let actual = try Data(contentsOf: url)
            report["actualText"] = String(data: actual, encoding: .utf8) ?? "<non-UTF8>"
            report["actualBytes"] = actual.count
            report["bytesMatch"] = actual == expectedData
            report["filenameMatches"] = url.lastPathComponent == fixtureURL?.lastPathComponent
            try record(actual == expectedData ? "bytes-match" : "bytes-mismatch")
        } catch { recordFailure(error) }
    }
}
