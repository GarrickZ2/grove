import { describe, expect, it } from "vitest";
import { buildGroveMetaTag } from "../../../utils/groveMeta";
import { compactConversationText } from "./conversationPreview";

describe("conversation preview text", () => {
  it("removes a long session bootstrap before clipping the real prompt", () => {
    const bootstrap = buildGroveMetaTag("grove_session_init", { kind: "session" }, "Internal instructions. ".repeat(100));
    expect(compactConversationText(`${bootstrap}\n\n优化前端页面 UIUX`)).toBe("优化前端页面 UIUX");
    expect(compactConversationText(bootstrap)).toBe("");
  });

  it("keeps readable envelope text and the surrounding user prompt", () => {
    const mention = buildGroveMetaTag("mention_send", { name: "Reviewer", sid: "private-session-id" }, "Send to Reviewer");
    expect(compactConversationText(`${mention}\n\nReview this change`)).toBe("Send to Reviewer Review this change");
  });

  it("processes multiple envelopes and uses the fallback for unknown types and versions", () => {
    const bootstrap = buildGroveMetaTag("grove_session_init", {}, "Hidden");
    const unknown = buildGroveMetaTag("future_type", { internal: "not for preview" }, "Readable context");
    const future = buildGroveMetaTag("grove_session_init", {}, "Future fallback", 2);
    expect(compactConversationText(`${bootstrap}${unknown}\n${future}\nQuestion`)).toBe("Readable context Future fallback Question");
  });

  it("preserves literal malformed tags instead of silently deleting user text", () => {
    const literal = "Explain <grove-meta>{invalid}</grove-meta> please";
    expect(compactConversationText(literal)).toBe(literal);
  });

  it("still compacts whitespace and clips ordinary prompt and response text", () => {
    expect(compactConversationText("  Hello\n\n world\t ")).toBe("Hello world");
    expect(compactConversationText("a".repeat(221))).toBe(`${"a".repeat(219)}…`);
    expect(compactConversationText("")).toBe("");
  });
});
