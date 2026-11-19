import Foundation
import PeekCore

/// Reads rook's local API. Everything here is a GET — Peek never mutates rook's
/// state; acting on something always hands off to the board.
actor RookClient {
    private let base: URL
    private let session: URLSession

    init(base: URL = URL(string: "http://127.0.0.1:7480")!) {
        self.base = base
        let cfg = URLSessionConfiguration.ephemeral
        // rook is on loopback but /api/prboard proxies to GitHub, so latency is
        // network-bound, not loopback-bound — it measures around six seconds.
        // A two-second budget silently failed every board poll.
        cfg.timeoutIntervalForRequest = 15
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    /// GoFr wraps handler results in {"data": …}; some routes return the bare
    /// object. Unwrap once so decoding does not have to know which.
    private func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let inner = obj["data"] {
            let unwrapped = try JSONSerialization.data(withJSONObject: inner)
            return try JSONDecoder().decode(T.self, from: unwrapped)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let (data, response) = try await session.data(from: base.appendingPathComponent(path))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw RookError.badStatus
        }
        return try decode(type, from: data)
    }

    enum RookError: Error { case badStatus }

    /// The board costs a GitHub round trip, so it is refreshed on its own slow
    /// cadence and cached in between. Agent state is local and cheap, and is what
    /// actually changes second to second.
    private static let boardMaxAge: TimeInterval = 60
    private var cachedBoard: BoardResponse?
    private var cachedBoardAt: Date?

    private func board() async -> BoardResponse? {
        if let at = cachedBoardAt, Date().timeIntervalSince(at) < Self.boardMaxAge {
            return cachedBoard
        }
        guard let fresh = try? await get("api/prboard", as: BoardResponse.self) else {
            return cachedBoard      // keep the last good answer rather than blanking
        }
        cachedBoard = fresh
        cachedBoardAt = Date()
        return fresh
    }

    /// One poll. Returns nil when rook is not answering — Peek goes Dormant
    /// rather than showing an error, because it reflects rook, it does not
    /// advertise it.
    func poll() async -> PeekData? {
        let state = try? await get("api/state", as: StateResponse.self)
        let board = await self.board()

        guard board != nil || state != nil else { return nil }

        var out = PeekData()
        out.reachable = true

        let prs = board?.prs ?? []
        let review = prs.filter { $0.needsMyReview }
        let blocked = prs.filter { $0.isBlocked }
        out.needsReview = review.count
        out.blocked = blocked.count

        let sessions = state?.sessions ?? []
        let waiting = sessions.filter { $0.isWaitingOnMe }
        out.waitingAgents = waiting.count

        // One row budget across both sections, spent worst-first: an agent that
        // has stopped for you, then reviews you owe, then your own blocked work.
        // Capping each section separately is how the panel grew to eight rows and
        // pushed its own button off the bottom.
        var budget = PeekData.maxRows

        let agentRows = waiting.prefix(budget).map { s in
            PeekData.Row(id: s.sessionId, ref: "agent", title: s.label,
                         note: "waiting", tone: .accent, url: nil)
        }
        budget -= agentRows.count

        let reviewRows = review.prefix(budget).map { pr in
            PeekData.Row(id: pr.url, ref: "#\(pr.number)", title: pr.title,
                         note: Self.age(pr.updatedAt), tone: .waiting, url: pr.url)
        }
        budget -= reviewRows.count

        let blockedRows = blocked.prefix(budget).map { pr in
            PeekData.Row(id: pr.url, ref: "#\(pr.number)", title: pr.title,
                         note: pr.blocker ?? "", tone: .critical, url: pr.url)
        }
        budget -= blockedRows.count

        out.reviewRows = agentRows + reviewRows
        out.blockedRows = blockedRows
        out.overflow = (waiting.count - agentRows.count)
            + (review.count - reviewRows.count)
            + (blocked.count - blockedRows.count)

        out.running = PeekData.pickLive(from: sessions,
                                        now: Date().timeIntervalSince1970 * 1000)

        return out
    }

    private static func age(_ iso: String) -> String {
        let fmt = ISO8601DateFormatter()
        guard let d = fmt.date(from: iso) else { return "" }
        let mins = Int(Date().timeIntervalSince(d) / 60)
        if mins < 60 { return "\(max(1, mins))m" }
        let hours = mins / 60
        if hours < 24 { return "\(hours)h" }
        let days = hours / 24
        return days < 30 ? "\(days)d" : "\(days / 30)mo"
    }
}
