import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionNotice } from "./SessionNotice";
import { appendSessionNotice, sessionNoticeFromEvent } from "./sessionNotices";

describe("session notices", () => {
  it("preserves plain-text fields, unknown severities, and null descriptions", () => {
    expect(sessionNoticeFromEvent({ title: "Model rerouted", severity: "_custom", description: null }))
      .toEqual({ type: "session_notice", title: "Model rerouted", severity: "_custom" });
    expect(sessionNoticeFromEvent({ title: "  " })).toBeNull();
    expect(sessionNoticeFromEvent({ title: 4 })).toBeNull();
  });

  it("keeps repeated notices as independent chronological records and closes text streams", () => {
    const notice = sessionNoticeFromEvent({ title: "Configuration warning", severity: "warning" })!;
    const original = [{ type: "assistant", content: "third step", complete: false }, { type: "thinking", content: "thinking", complete: false }];
    const messages = appendSessionNotice(appendSessionNotice(original, notice), notice);
    expect(messages.map((message) => message.type)).toEqual(["assistant", "thinking", "session_notice", "session_notice"]);
    expect(messages.slice(0, 2)).toMatchObject([{ complete: true }, { complete: true }]);
    expect(original[0].complete).toBe(false);
    const restored = JSON.parse(JSON.stringify(messages));
    expect(restored).toEqual(messages);
  });

  it.each(["info", "warning", "error", "_future"])("renders %s as a passive independent row with escaped text", (severity) => {
    const html = renderToStaticMarkup(<SessionNotice message={{ type: "session_notice", severity, title: "<script>title</script>", description: "**plain text**\nDetails" }} />);
    expect(html).toContain('role="note"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("&lt;script&gt;title&lt;/script&gt;");
    expect(html).toContain("**plain text**");
    expect(html).not.toContain("<button");
    expect(html).toContain(`aria-label="${severity === "_future" ? "Notice" : severity[0].toUpperCase() + severity.slice(1)}"`);
  });
});
