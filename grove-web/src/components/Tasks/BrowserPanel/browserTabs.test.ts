import { describe, expect, it } from "vitest";
import { shownBrowser, tabRows } from "./browserTabs";

describe("shownBrowser", () => {
  it("follows the agent by default", () => {
    expect(shownBrowser(null, ["managed", "personal"], "personal")).toBe("personal");
  });

  it("keeps the user's pick while the agent stays put", () => {
    const pick = { target: "managed" as const, agentOn: "personal" as const };
    expect(shownBrowser(pick, ["managed", "personal"], "personal")).toBe("managed");
  });

  it("follows the agent again once it moves", () => {
    const pick = { target: "managed" as const, agentOn: "personal" as const };
    expect(shownBrowser(pick, ["managed", "personal"], "managed")).toBe("managed");
    expect(shownBrowser({ target: "personal", agentOn: "personal" }, ["managed"], "personal")).toBe("personal");
  });

  it("drops a pick whose browser is gone", () => {
    const pick = { target: "personal" as const, agentOn: "managed" as const };
    expect(shownBrowser(pick, ["managed"], "managed")).toBe("managed");
  });
});

describe("tabRows", () => {
  const managed = [{ tabId: "t1", targetId: "a", active: true }, { tabId: "t2", targetId: "b" }];
  const personal = [{ tabId: "t1", targetId: "c", active: true }, { tabId: "t2", targetId: "d" }];
  const used = new Set(["personal:c"]);
  const none = new Set<string>();

  it("lists the test browser's tabs and the personal tabs the agent used", () => {
    const rows = tabRows({ personal, managed }, ["personal", "managed"], "managed", "personal", used, none);
    expect(rows.map((row) => [row.target, row.tab.targetId])).toEqual([
      ["managed", "a"],
      ["managed", "b"],
      ["personal", "c"],
    ]);
  });

  it("separates what is shown from where the agent is", () => {
    const rows = tabRows({ personal, managed }, ["managed", "personal"], "managed", "personal", used, none);
    expect(rows.find((row) => row.shown)?.tab.targetId).toBe("a");
    expect(rows.find((row) => row.agentHere)?.tab.targetId).toBe("c");
  });

  it("leaves out closed tabs and browsers no longer connected", () => {
    const rows = tabRows({ personal, managed }, ["managed"], "managed", "managed", used, new Set(["managed:b"]));
    expect(rows.map((row) => row.tab.targetId)).toEqual(["a"]);
  });
});
