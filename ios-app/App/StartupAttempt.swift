import Foundation

/// A single startup attempt's foreground budget. The caller supplies monotonic
/// time so background suspension and slow callbacks cannot reset the deadline.
struct StartupAttempt {
    enum Status: String { case idle, running, ready, failed, cancelled }

    private(set) var generation: UInt64 = 0
    private(set) var status: Status = .idle
    private(set) var budget: TimeInterval = 300
    private var accumulated: TimeInterval = 0
    private var activeSince: TimeInterval?

    @discardableResult
    mutating func begin(at now: TimeInterval, budget: TimeInterval = 300, active: Bool = true) -> UInt64 {
        precondition(now.isFinite && budget.isFinite && budget > 0)
        generation &+= 1
        status = .running
        self.budget = budget
        accumulated = 0
        activeSince = active ? now : nil
        return generation
    }

    func accepts(_ generation: UInt64) -> Bool {
        status == .running && self.generation == generation
    }

    func elapsed(at now: TimeInterval) -> TimeInterval {
        accumulated + (activeSince.map { max(0, now - $0) } ?? 0)
    }

    func isExpired(at now: TimeInterval) -> Bool {
        status == .running && elapsed(at: now) >= budget
    }

    mutating func pause(at now: TimeInterval) {
        guard status == .running, activeSince != nil else { return }
        accumulated = elapsed(at: now)
        activeSince = nil
    }

    mutating func resume(at now: TimeInterval) {
        guard status == .running, activeSince == nil else { return }
        activeSince = now
    }

    @discardableResult
    mutating func finish(_ generation: UInt64, at now: TimeInterval) -> Bool {
        guard accepts(generation), !isExpired(at: now) else { return false }
        pause(at: now)
        status = .ready
        return true
    }

    @discardableResult
    mutating func fail(_ generation: UInt64, at now: TimeInterval) -> Bool {
        guard accepts(generation) else { return false }
        pause(at: now)
        status = .failed
        return true
    }

    mutating func cancel(at now: TimeInterval) {
        pause(at: now)
        generation &+= 1
        status = .cancelled
    }
}
