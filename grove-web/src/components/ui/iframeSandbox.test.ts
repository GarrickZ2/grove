import { describe, expect, it } from "vitest";
import { markdownIframeSandbox } from "./iframeSandbox";

describe("markdownIframeSandbox", () => {
  it("uses the default sandbox when the author omits one", () => {
    expect(markdownIframeSandbox("/api/v1/projects/p/files/raw?path=a.html", undefined))
      .toBe("allow-scripts allow-popups allow-popups-to-escape-sandbox");
  });

  it("never grants same-origin access to Grove-origin documents", () => {
    for (const src of [
      "/api/v1/projects/p/tasks/t/files/raw?path=x.html",
      `${window.location.origin}/api/v1/x`,
      "blob:whatever",
    ]) {
      expect(markdownIframeSandbox(src, "allow-scripts allow-same-origin allow-forms"))
        .toBe("allow-scripts allow-forms");
    }
    expect(markdownIframeSandbox("/x.html", "ALLOW-SAME-ORIGIN allow-scripts")).toBe("allow-scripts");
  });

  it("keeps same-origin access for external embeds", () => {
    expect(markdownIframeSandbox("https://www.youtube.com/embed/abc", "allow-scripts allow-same-origin"))
      .toBe("allow-scripts allow-same-origin");
  });

  it("drops top-level navigation for every source", () => {
    expect(markdownIframeSandbox(
      "https://example.com/embed",
      "allow-scripts allow-top-navigation allow-top-navigation-by-user-activation",
    )).toBe("allow-scripts");
  });
});
