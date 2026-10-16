import ActivityKit
import SwiftUI
import WidgetKit

@main
struct GroveWidgets: WidgetBundle {
    var body: some Widget { GroveLiveActivity() }
}

struct GroveLiveActivity: Widget {
    private func mark(_ size: CGFloat) -> some View {
        Image("GroveMark").resizable().scaledToFit().frame(width: size, height: size)
            .accessibilityLabel("Grove")
    }
    private func details(_ context: ActivityViewContext<GroveActivityAttributes>) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(context.isStale ? "Waiting for update" : context.state.summary)
                .font(.subheadline).foregroundStyle(context.isStale ? .gray : .mint)
            if context.state.sessionCount > 1 {
                ForEach(Array(context.state.sessions.enumerated()), id: \.offset) { _, session in
                    HStack {
                        Text(session.name).lineLimit(1)
                        Spacer(minLength: 8)
                        Text(session.status).foregroundStyle(.secondary)
                    }.font(.caption)
                }
            }
            Text(context.attributes.server).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
    }
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: GroveActivityAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    mark(24)
                    Text(context.state.title).font(.headline).lineLimit(2)
                }
                details(context)
            }
            .padding(16)
            .activityBackgroundTint(.black.opacity(0.9))
            .activitySystemActionForegroundColor(.white)
            .foregroundStyle(.white)
            .widgetURL(URL(string: context.state.link))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { mark(24) }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.title).font(.headline).lineLimit(2)
                }
                DynamicIslandExpandedRegion(.bottom) { details(context) }
            } compactLeading: {
                HStack(spacing: 4) {
                    mark(16)
                    Text("Grove").font(.caption2.weight(.medium)).fixedSize()
                }
            } compactTrailing: {
                Text(compactStatus(context)).font(.caption2.weight(.semibold))
                    .lineLimit(1).minimumScaleFactor(0.8).frame(maxWidth: 80, alignment: .trailing)
            } minimal: {
                mark(18)
            }
            .widgetURL(URL(string: context.state.link))
            .keylineTint(.mint)
        }
    }
    private func compactStatus(_ c: ActivityViewContext<GroveActivityAttributes>) -> String {
        if c.isStale { return "Update pending" }
        if c.state.waiting > 0 { return c.state.sessionCount > 1 ? "\(c.state.waiting) waiting" : "Needs input" }
        if c.state.running > 0 { return c.state.sessionCount > 1 ? "\(c.state.running) running" : "Running" }
        if c.state.connecting > 0 { return "Connecting" }
        if c.state.failed > 0 { return "Failed" }
        return c.state.status == "cancelled" ? "Stopped" : c.state.status == "finished" ? "Finished" : "Completed"
    }
}
