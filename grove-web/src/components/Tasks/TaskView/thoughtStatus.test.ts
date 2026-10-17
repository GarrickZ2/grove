import { describe, expect, it } from "vitest";
import {
  extractThoughtStatus,
  shouldShowGenericThinking,
} from "./thoughtStatus";

describe("extractThoughtStatus", () => {
  it("extracts a standalone bold heading", () => {
    expect(
      extractThoughtStatus(
        "**Checking status and committing changes**\n\nPrivate reasoning body",
      ),
    ).toBe("Checking status and committing changes");
  });

  it("uses the latest heading while thought content streams", () => {
    expect(
      extractThoughtStatus(
        [
          "**Checking Go module and package versions**",
          "",
          "**Evaluating ToolConfig abstraction necessity**",
          "",
          "**Refining Invoke API design and naming**",
        ].join("\n"),
      ),
    ).toBe("Refining Invoke API design and naming");
  });

  it("accepts a markdown heading wrapped in bold", () => {
    expect(extractThoughtStatus("### **Searching for InvocationRequest definition**"))
      .toBe("Searching for InvocationRequest definition");
  });

  it("does not expose ordinary reasoning or inline emphasis", () => {
    expect(extractThoughtStatus("I should **check the status** before editing."))
      .toBe("Thinking");
    expect(extractThoughtStatus("No heading yet"))
      .toBe("Thinking");
  });
});

describe("shouldShowGenericThinking", () => {
  it("hides the fallback as soon as the run finishes", () => {
    expect(shouldShowGenericThinking(false, [{ type: "user" }])).toBe(false);
  });

  it("never duplicates a real unfinished thought", () => {
    expect(
      shouldShowGenericThinking(true, [
        { type: "thinking", complete: false },
        { type: "tool" },
      ]),
    ).toBe(false);
  });

  it("shows the fallback while waiting for the first Agent content", () => {
    expect(shouldShowGenericThinking(true, [{ type: "user" }])).toBe(true);
  });

  it("uses the compaction indicator even when another event follows it", () => {
    expect(shouldShowGenericThinking(true, [
      { type: "user" },
      { type: "compaction", status: "in_progress" },
      { type: "session_notice" },
    ])).toBe(false);
  });

  it.each(["completed", "failed", "cancelled"])("allows normal waiting after compaction is %s", (status) => {
    expect(shouldShowGenericThinking(true, [
      { type: "user" },
      { type: "compaction", status },
    ])).toBe(true);
  });

  it("ignores stale in-progress compactions from previous turns", () => {
    expect(shouldShowGenericThinking(true, [
      { type: "compaction", status: "in_progress" },
      { type: "user" },
    ])).toBe(true);
  });
});
