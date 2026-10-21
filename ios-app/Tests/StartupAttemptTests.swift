import Foundation

/// Standalone regression checks; the supplied monotonic times need no waiting.
@main
struct StartupAttemptTests {
    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        if !condition() { fatalError(message) }
    }

    private static func pendingWorkConsumesTheWholeBudget() {
        var attempt = StartupAttempt()
        let callback = attempt.begin(at: 10)
        require(attempt.budget == 300, "Normal startup must retain the 300-second budget")
        // A network or WebKit callback remains outstanding throughout this
        // interval. Merely checking its generation must not reset the clock.
        require(attempt.accepts(callback), "Current pending callback was rejected")
        require(attempt.elapsed(at: 160) == 150, "In-flight work was excluded from elapsed time")
        require(attempt.accepts(callback), "An outstanding callback must remain current before expiry")
        require(!attempt.isExpired(at: 309.5), "Startup expired before its active-time budget")
        require(attempt.isExpired(at: 310), "An unfinished callback prevented the startup deadline")
        require(attempt.fail(callback, at: 310), "Expired startup could not enter its failed state")
        require(!attempt.accepts(callback), "A timed-out callback remained accepted")
        require(!attempt.finish(callback, at: 311), "A late callback made timed-out startup ready")
        require(attempt.status == .failed, "A late callback replaced the timeout failure")
    }

    private static func backgroundTimeDoesNotConsumeTheBudget() {
        var attempt = StartupAttempt()
        _ = attempt.begin(at: 100)
        attempt.pause(at: 110)
        require(attempt.elapsed(at: 10_000) == 10, "Background duration consumed startup time")
        require(!attempt.isExpired(at: 10_000), "Paused startup expired while suspended")
        attempt.pause(at: 10_000)
        attempt.resume(at: 10_010)
        attempt.resume(at: 10_020)
        require(attempt.elapsed(at: 10_025) == 25, "Repeated lifecycle notifications reset active time")
        require(!attempt.isExpired(at: 10_299.5), "Resumed startup lost its remaining budget")
        require(attempt.isExpired(at: 10_300), "Resumed startup did not retain its earlier active time")
    }

    private static func initiallyInactiveStartupWaitsForTheForeground() {
        var attempt = StartupAttempt()
        let callback = attempt.begin(at: 100, active: false)
        require(attempt.accepts(callback), "Inactive startup lost its generation")
        require(attempt.elapsed(at: 1_000) == 0, "Initially inactive startup accumulated time")
        require(!attempt.isExpired(at: 1_000), "Initially inactive startup expired")
        attempt.resume(at: 1_000)
        require(!attempt.isExpired(at: 1_299.5), "Foreground startup received a shortened budget")
        require(attempt.isExpired(at: 1_300), "Foreground startup never reached its deadline")
    }

    private static func lateSuccessCannotBeatTheWatchdog() {
        var attempt = StartupAttempt()
        let expired = attempt.begin(at: 0)
        // The success callback can run before the timer gets its next turn.
        // It must still respect the already exhausted active-time budget.
        require(!attempt.finish(expired, at: 300), "A late success bypassed the deadline before the watchdog ran")
        require(attempt.status != .ready, "Expired startup displayed a ready screen")
        require(attempt.fail(expired, at: 300), "The watchdog could not fail the expired attempt")
        let retried = attempt.begin(at: 400)
        require(retried > expired && attempt.budget == 300, "Retry did not receive a fresh normal attempt")
        require(!attempt.finish(expired, at: 401), "Expired success completed the new retry")
        require(attempt.finish(retried, at: 699.5), "A timely success could not complete the retry")
        require(attempt.status == .ready && !attempt.isExpired(at: 1_000), "Successful retry was not terminal")
    }

    private static func retryRejectsPreviousCallbacksAndReceivesANewBudget() {
        var attempt = StartupAttempt()
        let original = attempt.begin(at: 0, budget: 4)
        require(attempt.isExpired(at: 4), "Short fault-injection deadline was not honored")
        require(attempt.fail(original, at: 4), "Fault-injection startup did not fail")
        let retried = attempt.begin(at: 100)
        require(retried > original, "Retry reused the expired startup generation")
        require(attempt.budget == 300, "Retry inherited the fault-injection deadline")
        require(attempt.elapsed(at: 100) == 0, "Retry inherited the failed attempt's elapsed time")
        require(!attempt.accepts(original), "Retry accepted an old callback")
        require(!attempt.finish(original, at: 101), "An old success completed the retry")
        require(!attempt.fail(original, at: 101), "An old failure cancelled the retry")
        require(attempt.status == .running && attempt.accepts(retried), "Stale callbacks changed the active retry")
        require(!attempt.isExpired(at: 399.5), "Retry did not receive its full normal budget")
        require(attempt.isExpired(at: 400), "Retry no longer has a finite deadline")
    }

    private static func readyStartupCannotBeChangedByLateCallbacks() {
        var attempt = StartupAttempt()
        let completed = attempt.begin(at: 20)
        require(attempt.finish(completed, at: 32), "Active startup could not finish")
        require(attempt.status == .ready, "Successful startup was not ready")
        require(!attempt.accepts(completed), "Ready startup still accepted callbacks")
        require(!attempt.fail(completed, at: 50), "A late error replaced a ready screen")
        require(!attempt.finish(completed, at: 50), "Ready startup completed twice")
        attempt.pause(at: 60)
        attempt.resume(at: 70)
        require(attempt.status == .ready, "Lifecycle notifications reopened completed startup")
        require(attempt.elapsed(at: 10_000) == 12, "Completed startup kept accruing time")
        require(!attempt.isExpired(at: 10_000), "A ready screen was later timed out")
        let next = attempt.begin(at: 10_100)
        require(next > completed && attempt.accepts(next), "A later startup did not get a fresh generation")
        require(!attempt.fail(completed, at: 10_101), "The previous ready attempt could fail a new startup")
    }

    private static func cancellationRejectsOutstandingCallbacks() {
        var attempt = StartupAttempt()
        let cancelled = attempt.begin(at: 50)
        attempt.cancel(at: 65)
        require(attempt.status == .cancelled, "Cancellation did not become terminal")
        require(!attempt.accepts(cancelled), "Cancelled work remained accepted")
        require(!attempt.finish(cancelled, at: 66), "Cancelled startup became ready")
        require(!attempt.fail(cancelled, at: 66), "A stale error changed cancelled startup")
        attempt.pause(at: 70)
        attempt.resume(at: 80)
        require(attempt.status == .cancelled, "Lifecycle notifications resumed cancelled startup")
        require(attempt.elapsed(at: 1_000) == 15, "Cancelled startup kept accruing time")
        require(!attempt.isExpired(at: 1_000), "Cancelled startup expired a second time")
        let next = attempt.begin(at: 1_100)
        require(next > cancelled && attempt.accepts(next), "Cancellation prevented a new startup")
        require(!attempt.finish(cancelled, at: 1_101), "Cancelled work completed a later startup")
    }

    private static func idleAndFailedStatesDoNotExpire() {
        var attempt = StartupAttempt()
        require(attempt.status == .idle, "New state was not idle")
        require(!attempt.accepts(attempt.generation), "Idle state accepted a callback")
        require(!attempt.isExpired(at: 100_000), "Idle state expired without an attempt")
        attempt.pause(at: 10)
        attempt.resume(at: 20)
        require(attempt.status == .idle, "Lifecycle notifications started idle work")
        let failed = attempt.begin(at: 100)
        require(attempt.fail(failed, at: 105), "Active attempt could not fail")
        require(!attempt.fail(failed, at: 106), "The same failure was applied twice")
        attempt.pause(at: 110)
        attempt.resume(at: 120)
        require(attempt.status == .failed && !attempt.accepts(failed), "Failed attempt was reopened")
        require(attempt.elapsed(at: 100_000) == 5, "Failed attempt kept accruing time")
        require(!attempt.isExpired(at: 100_000), "A failed attempt expired repeatedly")
    }

    static func main() throws {
        let checks: [(String, () -> Void)] = [
            ("in-flight-work-consumes-active-budget", pendingWorkConsumesTheWholeBudget),
            ("background-pause-and-idempotent-resume", backgroundTimeDoesNotConsumeTheBudget),
            ("initially-inactive-startup", initiallyInactiveStartupWaitsForTheForeground),
            ("late-success-cannot-beat-watchdog-deadline", lateSuccessCannotBeatTheWatchdog),
            ("retry-rejects-stale-callbacks-and-restores-normal-budget", retryRejectsPreviousCallbacksAndReceivesANewBudget),
            ("ready-state-rejects-late-callbacks", readyStartupCannotBeChangedByLateCallbacks),
            ("cancelled-state-rejects-outstanding-work", cancellationRejectsOutstandingCallbacks),
            ("idle-and-failed-states-never-expire", idleAndFailedStatesDoNotExpire),
        ]
        for (_, check) in checks { check() }
        let report: [String: Any] = ["status": "passed", "checks": checks.map { $0.0 }]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
}
