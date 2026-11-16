import Foundation

// Shapes mirror what rook already serves. Field names match the Go structs on
// the other side (prboard.go, scan.go) — decoding is the contract between the
// two, so it is spelled out rather than inferred.

public struct BoardPR: Decodable, Identifiable {
    public var id: String { url }

    public let number: Int
    public let title: String
    public let url: String
    public let repo: String
    public let author: String
    public let state: String            // OPEN | MERGED | CLOSED
    public let lane: String             // mine | review
    public let col: String              // waiting | changes | approved | draft | merged
                                 // requested | commented | approved_by_me
    public let mine: Bool
    public let checks: String           // SUCCESS | FAILURE | PENDING | ""
    public let mergeable: String        // MERGEABLE | CONFLICTING | UNKNOWN
    public let unresolved: Int
    public let changesRequested: Int
    public let updatedAt: String

    /// The single reason this pull request cannot move, worst first. Mirrors the
    /// board's rule so both surfaces agree on what "blocked" means.
    public var blocker: String? {
        if mergeable == "CONFLICTING" { return "conflicts" }
        if checks == "FAILURE" || checks == "ERROR" { return "checks failed" }
        if changesRequested > 0 { return "changes requested" }
        if unresolved > 0 { return "\(unresolved) unresolved" }
        return nil
    }

    public var isBlocked: Bool { state == "OPEN" && mine && blocker != nil }
    public var needsMyReview: Bool { lane == "review" && col == "requested" }
}

public struct BoardResponse: Decodable {
    public let login: String?
    public let prs: [BoardPR]?
}

public struct AgentSession: Decodable, Identifiable {
    public var id: String { sessionId }

    public let sessionId: String
    public let title: String?
    public let project: String?
    public let status: String?          // busy | waiting | idle | shell
    public let alive: Bool?
    public let asking: String?
    public let startedAt: Double?       // UnixMilli
    public let updatedAt: Double?

    public var isWaitingOnMe: Bool { (alive ?? false) && status == "waiting" }
    public var isRunning: Bool { (alive ?? false) && (status == "busy" || status == "shell") }

    public var label: String {
        if let t = title, !t.isEmpty { return t }
        if let p = project, !p.isEmpty { return p }
        return sessionId.prefix(8).description
    }

    public var elapsed: TimeInterval {
        guard let s = startedAt else { return 0 }
        return max(0, Date().timeIntervalSince1970 - s / 1000)
    }
}

public struct StateResponse: Decodable {
    public let sessions: [AgentSession]?
}

/// Everything the notch needs, flattened out of the two endpoints. Computing it
/// once here keeps the views free of business rules.
public struct PeekData: Equatable {
    public var needsReview: Int = 0
    public var blocked: Int = 0
    public var waitingAgents: Int = 0

    public var reviewRows: [Row] = []
    public var blockedRows: [Row] = []
    public var running: RunningAgent?

    public var reachable: Bool = false

    public init() {}

    public struct Row: Equatable, Identifiable {
        public let id: String
        public let ref: String       // "#3040" or "agent"
        public let title: String
        public let note: String      // "1mo", "conflicts", "waiting"
        public let tone: Tone
        public let url: String?

        public init(id: String, ref: String, title: String,
                    note: String, tone: Tone, url: String?) {
            self.id = id
            self.ref = ref
            self.title = title
            self.note = note
            self.tone = tone
            self.url = url
        }
    }

    public struct RunningAgent: Equatable {
        public let name: String
        /// When the agent last actually did something (UnixMilli). Session age
        /// is the wrong number here: a session opened four days ago that moved
        /// a minute ago is live, and one opened four days ago that last moved
        /// half an hour ago is not.
        public let lastActivity: Double

        public init(name: String, lastActivity: Double) {
            self.name = name
            self.lastActivity = lastActivity
        }
    }

    public enum Tone: Equatable { case neutral, waiting, critical, accent }

    /// Anything at all to say. Drives the drop back to Dormant.
    public var hasSignal: Bool { needsReview > 0 || blocked > 0 || waitingAgents > 0 }

    /// Rows that did not fit, surfaced as "+N more in rook" rather than a
    /// scrollbar. A scrolling list in a notch is a window wearing a disguise.
    public var overflow: Int = 0

    /// How quiet an agent may go before it stops counting as live.
    public static let liveWindowMs: Double = 120_000

    /// The panel shows at most this many rows across both sections combined.
    public static let maxRows = 5

    // Panel metrics, in points. Height is derived from these rather than fixed,
    // so the content can never be taller than the window that clips it — which
    // is how the primary action ended up sliced in half.
    public static let rowH: CGFloat = 30
    public static let sectionHeaderH: CGFloat = 20
    public static let dividerH: CGFloat = 17
    public static let overflowH: CGFloat = 22
    public static let footerH: CGFloat = 38     // button + the gap above it
    public static let panelPadding: CGFloat = 26 // 12 top + 14 bottom

    /// Exactly as tall as its content. Nothing is clipped, and an empty panel is
    /// not padded out to a size it does not need.
    public var panelHeight: CGFloat {
        var h = Self.panelPadding + Self.footerH
        var sections = 0
        if !reviewRows.isEmpty {
            h += Self.sectionHeaderH + CGFloat(reviewRows.count) * Self.rowH
            sections += 1
        }
        if !blockedRows.isEmpty {
            h += Self.sectionHeaderH + CGFloat(blockedRows.count) * Self.rowH
            sections += 1
        }
        if running != nil {
            h += Self.rowH
            sections += 1
        }
        h += CGFloat(max(0, sections - 1)) * Self.dividerH
        if overflow > 0 { h += Self.overflowH }
        if sections == 0 { h += 52 }             // the "nothing waiting" line
        return h
    }

    /// Which agent, if any, counts as running right now.
    ///
    /// Two rules, both learned the hard way: an agent is live because it moved
    /// recently, not because its session is old; and when several are moving the
    /// most recent one wins, because that is the one you are actually watching.
    public static func pickLive(from sessions: [AgentSession], now: Double) -> RunningAgent? {
        guard let s = sessions
            .filter({ $0.isRunning })
            .filter({ now - ($0.updatedAt ?? 0) < liveWindowMs })
            .max(by: { ($0.updatedAt ?? 0) < ($1.updatedAt ?? 0) })
        else { return nil }
        return RunningAgent(name: s.label, lastActivity: s.updatedAt ?? 0)
    }
}
