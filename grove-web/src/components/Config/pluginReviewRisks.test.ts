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
    expect(risks[2].details).toContain("Grove cannot limit this, and it includes Grove's own local API.");
    expect(risks[1].details).toContain("Adds skills to every agent");
    expect(risks[1].details).toContain("Can send prompts to agents on your behalf");
    expect(risks[3].details).toEqual(["Read the current task's files"]);
  });

  it("lists background behavior and unenforced ports", () => {
    const risks = reviewRisks({
      ...base,
      network: true,
      service: true,
      activation: { on_startup: true, schedules: ["0 9 * * *"], unknown: [] },
      listeners: [{ id: "webhook", port: 8787 }],
    });
    expect(risks.find((risk) => risk.id === "network")?.details).toContain("Says it opens port 8787 (not enforced)");
    expect(risks.find((risk) => risk.id === "background")?.details).toEqual([
      "Stays running while Grove is open",
      "Runs on a schedule: 0 9 * * *",
    ]);
  });

  it("calls out reach beyond the current task", () => {
    const risks = reviewRisks({
      ...base,
      agent: { ...base.agent, sessions_write: true, buddies_write: true },
      data: ["sessions:read", "view:list"],
    });
    expect(risks[0].details).toContain("Can send prompts to any Session");
    expect(risks[1].details).toEqual(["Read every Session's conversation", "See what you are viewing, on every device"]);
  });
});
