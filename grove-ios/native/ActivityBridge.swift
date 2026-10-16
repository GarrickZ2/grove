import ActivityKit
import Foundation
import UIKit

@_cdecl("grove_activity_update")
func groveActivityUpdate(_ json: UnsafePointer<CChar>) {
    let data = Data(String(cString: json).utf8)
    guard #available(iOS 16.2, *) else { return }
    Task { @MainActor in await GroveActivityController.shared.receive(data) }
}

@available(iOS 16.2, *)
@MainActor
final class GroveActivityController {
    static let shared = GroveActivityController()
    struct Update: Decodable {
        var server: String
        var origin: String
        var clear: Bool
        var stale: Bool
        var content: GroveActivityAttributes.ContentState?
        var diagnostic: String?
    }
    private var pending: [Update] = []
    private var draining = false
    private var latest: Update?
    private var latestAt = Date.distantPast
    private var observer: NSObjectProtocol?
    private var diagnostics: [[String: Any]] = []
    private var lastStage = ""
    private init() {
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, let latest = self.latest, Date().timeIntervalSince(self.latestAt) < 90 else { return }
                await self.enqueue(latest)
            }
        }
    }
    // Diagnostic history contains no task names, prompts, URLs or credentials.
    private func record(_ stage: String, error: Error? = nil, state: GroveActivityAttributes.ContentState? = nil) {
        let fingerprint = "\(stage):\(state?.status ?? ""):\(state?.sessionCount ?? 0):\(state?.running ?? 0):\(state?.connecting ?? 0):\(state?.waiting ?? 0)"
        guard fingerprint != lastStage || error != nil else { return }
        lastStage = fingerprint
        var item: [String: Any] = ["stage": stage, "time": Date().timeIntervalSince1970,
            "enabled": ActivityAuthorizationInfo().areActivitiesEnabled,
            "appState": UIApplication.shared.applicationState.rawValue,
            "activities": Activity<GroveActivityAttributes>.activities.count]
        if let state {
            item["status"] = state.status
            item["sessions"] = state.sessionCount
            item["running"] = state.running
            item["connecting"] = state.connecting
            item["waiting"] = state.waiting
        }
        if let error {
            let native = error as NSError
            item["errorDomain"] = native.domain
            item["errorCode"] = native.code
            item["error"] = native.localizedDescription
        }
        diagnostics.append(item)
        diagnostics = Array(diagnostics.suffix(40))
        if let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first,
           let data = try? JSONSerialization.data(withJSONObject: diagnostics, options: .prettyPrinted) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: directory.appendingPathComponent("grove-activity-diagnostics.json"), options: .atomic)
        }
        NSLog("Grove Live Activity: %@", stage)
    }
    func receive(_ data: Data) async {
        do {
            let update = try JSONDecoder().decode(Update.self, from: data)
            if let stage = update.diagnostic { record(String(stage.prefix(80))); return }
            latest = update
            latestAt = Date()
            await enqueue(update)
        } catch { record("decode_failed", error: error) }
    }
    private func enqueue(_ update: Update) async {
        pending.append(update)
        guard !draining else { return }
        draining = true
        while !pending.isEmpty { await apply(pending.removeFirst()) }
        draining = false
    }
    private func apply(_ update: Update) async {
        for activity in Activity<GroveActivityAttributes>.activities
            where update.clear || activity.attributes.origin != update.origin {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        guard !update.clear, let state = update.content else { record("cleared"); return }
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(update.stale ? 0 : 90))
        let terminal = ["completed", "cancelled", "finished", "failed"].contains(state.status)
        if let activity = Activity<GroveActivityAttributes>.activities.first(where: { $0.attributes.origin == update.origin && ($0.activityState == .active || $0.activityState == .stale) }) {
            if terminal {
                await activity.end(content, dismissalPolicy: .after(Date().addingTimeInterval(30)))
                record("ended", state: state)
            } else {
                await activity.update(content)
                record(update.stale ? "stale" : "updated", state: state)
            }
            return
        }
        guard !terminal else { record("terminal_without_activity"); return }
        guard !update.stale else { record("stale_without_activity"); return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { record("system_disabled"); return }
        guard UIApplication.shared.applicationState == .active else { record("awaiting_foreground"); return }
        do {
            _ = try Activity.request(attributes: GroveActivityAttributes(server: update.server, origin: update.origin), content: content, pushType: nil)
            record("created", state: state)
        } catch { record("creation_failed", error: error) }
    }
}
