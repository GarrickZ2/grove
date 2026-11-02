import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopItem } from "../../api/statistics";
import { computeAverageRates } from "../../components/Stats/components/pricing";
import { TopCard } from "./BreakdownCards";
import { topRowTarget } from "./statisticsView";

const project = {
  id: "p1",
  tasks: [{ id: "live", status: "active" }, { id: "old", status: "archived" }],
  localTask: { id: "_local" },
};
const item = (id: string, tokens: number): TopItem => ({
  id, name: `task ${id}`, turns: 1, tokens, input_tokens: tokens, cached_tokens: 0, output_tokens: 0, agent_split: [], cost: 0,
});

describe("topRowTarget", () => {
  it("opens live and local tasks in project scope", () => {
    expect(topRowTarget("project", "live", project)).toEqual({ kind: "task", projectId: "p1", taskId: "live" });
    expect(topRowTarget("project", "_local", project)).toEqual({ kind: "task", projectId: "p1", taskId: "_local" });
  });

  it("keeps archived, deleted and all-projects rows inert", () => {
    expect(topRowTarget("project", "old", project)).toEqual({ kind: "none", reason: "This task is archived" });
    expect(topRowTarget("project", "gone", project)).toEqual({ kind: "none", reason: "This task no longer exists" });
    expect(topRowTarget("global", "p1", project)).toEqual({ kind: "none" });
    expect(topRowTarget("project", "live", null)).toEqual({ kind: "none" });
  });
});

describe("TopCard", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens a task on click or Enter and leaves missing tasks inert", () => {
    const onOpenTask = vi.fn();
    act(() => root.render(
      <TopCard
        scope="project"
        items={[item("live", 300), item("gone", 200), item("old", 100)]}
        metric="total"
        unit="token"
        averageRates={computeAverageRates([])}
        dark={false}
        project={project}
        onOpenTask={onOpenTask}
      />,
    ));
    const rows = [...host.querySelectorAll<HTMLLIElement>(".ostat-top-row")];
    expect(rows.map((row) => row.getAttribute("role"))).toEqual(["button", null, null]);
    expect(rows[1].title).toMatch(/^This task no longer exists/);
    expect(rows[2].title).toMatch(/^This task is archived/);

    act(() => rows[0].click());
    act(() => rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    act(() => rows[1].click());
    expect(onOpenTask).toHaveBeenCalledTimes(2);
    expect(onOpenTask).toHaveBeenCalledWith("p1", "live");
  });
});
