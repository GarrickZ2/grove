import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { resolveAuthenticationMessages } from "./authenticationState";

describe("authoritative Agent sign-in result", () => {
  it("clears a terminal transport failure when the Agent confirms successful login", () => {
    const messages: ChatMessage[] = [{ type: "auth_required", methods: [], agentName: "Claude",
      status: "failed", errorMessage: "Could not open the sign-in terminal. Please retry." }];
    expect(resolveAuthenticationMessages(messages)).toEqual([
      { ...messages[0], status: "succeeded", errorMessage: undefined },
    ]);
  });
  it("resolves every outstanding card when tool output followed the login prompt", () => {
    const messages: ChatMessage[] = [
      { type: "auth_required", methods: [], agentName: "Claude", status: "idle" },
      { type: "auth_required", methods: [], agentName: "Claude", status: "in_progress" },
      { type: "system", content: "Agent running" },
    ];
    const result = resolveAuthenticationMessages(messages);
    expect(result.filter((m) => m.type === "auth_required" && m.status !== "succeeded")).toHaveLength(0);
    expect(result[2]).toBe(messages[2]);
  });
});
