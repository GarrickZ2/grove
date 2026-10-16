import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct GroveActivityAttributes: ActivityAttributes {
    struct Session: Codable, Hashable {
        var name: String
        var status: String
    }
    struct ContentState: Codable, Hashable {
        var title: String
        var summary: String
        var status: String
        var running: Int
        var connecting: Int
        var waiting: Int
        var failed: Int
        var completed: Int
        var sessionCount: Int
        var sessions: [Session]
        var link: String
        enum CodingKeys: String, CodingKey {
            case title, summary, status, running, connecting, waiting, failed, completed, sessionCount, sessions, link
        }
        // Existing activities may still contain the previous app version's payload.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            title = try c.decode(String.self, forKey: .title)
            status = try c.decode(String.self, forKey: .status)
            running = try c.decode(Int.self, forKey: .running)
            connecting = try c.decodeIfPresent(Int.self, forKey: .connecting) ?? 0
            waiting = try c.decode(Int.self, forKey: .waiting)
            failed = try c.decode(Int.self, forKey: .failed)
            completed = try c.decode(Int.self, forKey: .completed)
            sessionCount = try c.decodeIfPresent(Int.self, forKey: .sessionCount) ?? (running + connecting + waiting + failed + completed)
            summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? "Waiting for update"
            sessions = try c.decodeIfPresent([Session].self, forKey: .sessions) ?? []
            link = try c.decode(String.self, forKey: .link)
        }
    }
    var server: String
    var origin: String
}
