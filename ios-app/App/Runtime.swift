import Foundation
import CryptoKit
import Security
import Darwin

struct RuntimeManifest: Decodable {
    struct Entry: Decodable {
        let path: String
        let size: Int64
        let sha256: String
    }
    let formatVersion: Int
    let version: String
    let deploymentId: String
    let files: [Entry]
}

struct RuntimeConfiguration: Codable {
    let dataDir: String
    let envFile: String
    let port: Int
    let token: String
    let deploymentId: String
    let runtimeRoot: String
    let clientRoot: String
    let installationId: String
    let bootId: String?

    var origin: URL { URL(string: "http://127.0.0.1:\(port)")! }
}

enum RuntimeError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let message): return message }
    }
}

enum Runtime {
    static func prepare() throws -> (RuntimeConfiguration, URL) {
        let fm = FileManager.default
        guard let resources = Bundle.main.resourceURL else {
            throw RuntimeError.invalid("앱 리소스를 찾을 수 없습니다.")
        }
        let root = resources.appendingPathComponent("runtime", isDirectory: true)
        let manifest = try JSONDecoder().decode(RuntimeManifest.self,
            from: Data(contentsOf: root.appendingPathComponent("runtime-manifest.json")))
        try verify(root: root, manifest: manifest)
        let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let documents = try fm.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let data = documents.appendingPathComponent("Marinar", isDirectory: true)
        try fm.createDirectory(at: data, withIntermediateDirectories: true)
        let installationURL = support.appendingPathComponent("installation-id.txt")
        let installationId: String
        if fm.fileExists(atPath: installationURL.path) {
            installationId = try String(contentsOf: installationURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard UUID(uuidString: installationId) != nil else {
                throw RuntimeError.invalid("저장소 설치 식별자가 손상되었습니다. 기존 데이터를 백업한 뒤 복구해 주세요.")
            }
        } else {
            installationId = UUID().uuidString.lowercased()
            try Data(installationId.utf8).write(to: installationURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        // A fresh boot token means stale WebViews and other localhost clients
        // cannot retain access after the app process has restarted.
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RuntimeError.invalid("로컬 서버 인증 정보를 만들 수 없습니다.")
        }
        let configuration = RuntimeConfiguration(
            dataDir: data.path,
            envFile: support.appendingPathComponent("marinar.env").path,
            port: 7860,
            token: bytes.map { String(format: "%02x", $0) }.joined(),
            deploymentId: manifest.deploymentId,
            runtimeRoot: root.path,
            clientRoot: root.appendingPathComponent("client", isDirectory: true).path,
            installationId: installationId,
            bootId: kernelBootId())
        let configURL = support.appendingPathComponent("launch-config.json")
        try JSONEncoder().encode(configuration).write(to: configURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return (configuration, configURL)
    }

    private static func kernelBootId() -> String? {
        var length = 0
        if sysctlbyname("kern.bootsessionuuid", nil, &length, nil, 0) == 0, length > 1, length < 256 {
            var bytes = [CChar](repeating: 0, count: length)
            if sysctlbyname("kern.bootsessionuuid", &bytes, &length, nil, 0) == 0 {
                let value = String(cString: bytes)
                if !value.isEmpty { return value }
            }
        }
        var boot = timeval()
        length = MemoryLayout<timeval>.size
        if sysctlbyname("kern.boottime", &boot, &length, nil, 0) == 0 {
            return "boottime:\(boot.tv_sec).\(boot.tv_usec)"
        }
        // A wall-clock-minus-uptime estimate drifts and could incorrectly
        // authorize stealing another live writer's storage lease.
        return nil
    }

    private static func verify(root: URL, manifest: RuntimeManifest) throws {
        func validHash(_ value: String) -> Bool {
            value.count == 64 && value.allSatisfy { "0123456789abcdef".contains($0) }
        }
        guard manifest.formatVersion == 1, !manifest.version.isEmpty,
              validHash(manifest.deploymentId), !manifest.files.isEmpty else {
            throw RuntimeError.invalid("런타임 manifest 형식이 올바르지 않습니다.")
        }
        var paths = Set<String>()
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        for file in manifest.files {
            let parts = file.path.split(separator: "/", omittingEmptySubsequences: false)
            guard !file.path.hasPrefix("/"), !file.path.contains("\\"), !file.path.contains(":"),
                  !parts.isEmpty, !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }),
                  file.path.unicodeScalars.allSatisfy({ !CharacterSet.controlCharacters.contains($0) }),
                  file.path != "runtime-manifest.json", file.size >= 0, validHash(file.sha256),
                  paths.insert(file.path).inserted else {
                throw RuntimeError.invalid("런타임 파일 목록이 올바르지 않습니다.")
            }
            let url = root.appendingPathComponent(file.path)
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(canonicalRoot),
                  (attributes[.size] as? NSNumber)?.int64Value == file.size else {
                throw RuntimeError.invalid("런타임 파일 검증 실패: \(file.path)")
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var hash = SHA256()
            while let chunk = try handle.read(upToCount: 128 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
            guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == file.sha256 else {
                throw RuntimeError.invalid("런타임 파일 손상: \(file.path)")
            }
        }
        guard Set(["bootstrap.cjs", "server.mjs", "client/index.html"]).isSubset(of: paths) else {
            throw RuntimeError.invalid("필수 서버 또는 화면 파일이 없습니다.")
        }
        let canonical = manifest.files.sorted { $0.path.utf16.lexicographicallyPrecedes($1.path.utf16) }
            .map { "\($0.path)\t\($0.sha256)\t\($0.size)\n" }.joined()
        guard SHA256.hash(data: Data(canonical.utf8)).map({ String(format: "%02x", $0) }).joined() == manifest.deploymentId else {
            throw RuntimeError.invalid("런타임 배포 식별자가 일치하지 않습니다.")
        }
    }
}
