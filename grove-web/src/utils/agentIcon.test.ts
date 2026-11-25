import { describe, expect, it } from "vitest";
import { resolveAgentIcon } from "./agentIcon";

const url = (name: string) => resolveAgentIcon(name).url;

describe("brand icons from a display name", () => {
  it("finds the brand as a word", () => {
    for (const name of ["Claude Agent", "@agentclientprotocol/claude-agent-acp", "ClaudeCode", "claudecode"]) expect(url(name)).toContain("claude");
    expect(url("Gemini CLI")).toContain("gemini");
    expect(url("GeminiCLI")).toContain("gemini");
    expect(url("OpenCodeCLI")).toContain("opencode");
    expect(url("codex_acp")).toContain("openai");
    expect(url("GitHubCopilot")).toContain("copilot");
    expect(url("Kimi代理")).toContain("kimi");
  });

  it("leaves people alone", () => {
    for (const name of ["Kimiko", "Akiro", "Kimiko Tanaka", "Claudette Martin", "Cursory", "garrick.zhang"]) {
      expect(url(name)).toBeNull();
      expect(resolveAgentIcon(name).label).toBe(name);
    }
  });
});
