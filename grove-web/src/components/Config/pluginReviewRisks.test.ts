import { describe, expect, it } from "vitest";
import type { PluginReview } from "../../api/plugins";
import { reviewRisks } from "./pluginReviewRisks";

const base: PluginReview = {
  digest: "d",
  permissions: [],
  full_trust: false,
  network: false,
  processes: [],
  agent: { skills: false, mcp: false, prompt_middleware: false, chat_write: false },
  data: [],
  connect_provider: false,
};

describe("reviewRisks", () => {
  it("reports nothing for a UI-only plugin", () => {
    expect(reviewRisks(base)).toEqual([]);
  });

  it("orders risks from full trust down to data access", () => {
    const risks = reviewRisks({
      ...base,
      full_trust: true,
      network: true,
      agent: { ...base.agent, skills: true, chat_write: true },
      data: ["project:read"],
      connect_provider: true,
    });
    expect(risks.map((risk) => risk.id)).toEqual(["full-trust", "agent", "network", "data", "connect"]);
    expect(risks[1].details).toContain("Adds skills to every agent");
    expect(risks[1].details).toContain("Can send prompts to agents on your behalf");
    expect(risks[3].details).toEqual(["Read the current task's files"]);
  });
});
