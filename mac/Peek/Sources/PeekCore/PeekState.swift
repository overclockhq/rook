import Foundation

public enum PeekState: String, Equatable {
    case dormant, ambient, alert, live, peek
}

/// One thing that changed and that only you can unblock. Anything that does not
/// meet that bar never becomes an PeekAlert — see `PeekAlert.earns`.
public struct PeekAlert: Equatable {
    public init(key: String, title: String, detail: String) {
        self.key = key; self.title = title; self.detail = detail
    }

    public let key: String              // identity, so the same event does not re-fire
    public let title: String
    public let detail: String

    /// The interruption budget from the spec, in one place. Adding a case here
    /// is the only way something earns the top of the screen.
    public static func earns(previous: PeekData?, current: PeekData) -> PeekAlert? {
        guard let prev = previous else { return nil }   // never alert on first load

        // An agent stopped dead waiting for you outranks everything else.
        if current.waitingAgents > prev.waitingAgents,
           let row = current.reviewRows.first(where: { $0.ref == "agent" }) {
            return PeekAlert(key: "agent:" + row.id,
                         title: row.title,
                         detail: "waiting for you")
        }

        // A pull request of yours that just became blocked.
        let prevBlocked = Set(prev.blockedRows.map(\.id))
        if let fresh = current.blockedRows.first(where: { !prevBlocked.contains($0.id) }) {
            return PeekAlert(key: "blocked:" + fresh.id,
                         title: "\(fresh.ref) \(fresh.note)",
                         detail: fresh.title)
        }

        return nil
    }
}

/// Drives which face is on screen. Every transition in the spec is expressed
/// here so timing lives in one readable place rather than scattered across the
/// view layer.
@MainActor
public final class PeekMachine {
    public init() {}

    // Timings, all from the spec.
    public static let ambientSettle: TimeInterval = 30   // a count must hold before it shows
    public static let alertHold: TimeInterval = 6        // then collapse
    public static let alertCooldown: TimeInterval = 90   // at most one per window
    public static let hoverIn: TimeInterval = 0.22
    public static let hoverOut: TimeInterval = 0.12

    public private(set) var state: PeekState = .dormant
    public private(set) var data = PeekData()
    public private(set) var alert: PeekAlert?

    public var onChange: ((PeekState) -> Void)?

    private var signalSince: Date?
    private var lastAlertAt: Date?
    private var lastAlertKey: String?
    private var alertTimer: Timer?
    private var hoverTimer: Timer?
    private var isHovering = false

    /// True while the machine must not be interrupted — screen sharing or a
    /// mirrored display. A demo broken by your own tooling is the failure the
    /// rate limit exists to prevent.
    public var suppressed: Bool = false

    public func apply(_ next: PeekData?) {
        let previous = data.reachable ? data : nil

        guard let next, next.reachable else {
            // rook is gone: go quiet, no error state.
            data = PeekData()
            signalSince = nil
            transition(to: .dormant)
            return
        }

        let earned = PeekAlert.earns(previous: previous, current: next)
        data = next

        if next.hasSignal {
            if signalSince == nil { signalSince = Date() }
        } else {
            signalSince = nil
        }

        if let earned, canFire(earned) {
            fire(earned)
            return
        }
        settle()
    }

    private func canFire(_ a: PeekAlert) -> Bool {
        if suppressed { return false }
        if a.key == lastAlertKey { return false }
        if let last = lastAlertAt, Date().timeIntervalSince(last) < Self.alertCooldown { return false }
        return true
    }

    private func fire(_ a: PeekAlert) {
        alert = a
        lastAlertAt = Date()
        lastAlertKey = a.key
        transition(to: .alert)

        alertTimer?.invalidate()
        alertTimer = Timer.scheduledTimer(withTimeInterval: Self.alertHold, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.alert = nil
                self?.settle()
            }
        }
    }

    /// Where the machine rests once nothing is demanding attention.
    ///
    /// A running agent is deliberately NOT a resting state. In practice there is
    /// almost always an agent running, so resting on Live left the notch
    /// permanently occupied — which defeats the only thing that earns a surface
    /// at the top of every screen: being absent until something needs you.
    /// What is running is still one hover away, inside Peek.
    private func settle() {
        if isHovering { transition(to: .peek); return }
        if state == .alert, alert != nil { return }          // let the hold run out

        if data.hasSignal, let since = signalSince,
           Date().timeIntervalSince(since) >= Self.ambientSettle || state == .ambient {
            transition(to: .ambient)
            return
        }
        transition(to: .dormant)
    }

    // ---- hover ------------------------------------------------------------
    public func mouseEntered() {
        hoverTimer?.invalidate()
        hoverTimer = Timer.scheduledTimer(withTimeInterval: Self.hoverIn, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isHovering = true
                self.transition(to: .peek)
            }
        }
    }

    public func mouseExited() {
        hoverTimer?.invalidate()
        hoverTimer = Timer.scheduledTimer(withTimeInterval: Self.hoverOut, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.isHovering = false
                self.settle()
            }
        }
    }

    private func transition(to next: PeekState) {
        guard next != state else { return }
        state = next
        onChange?(next)
    }
}
