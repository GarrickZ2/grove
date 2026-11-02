import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContextResponse } from "../../api/agentContext";
import { AgentContextCard } from "./AgentContextCard";
import { fromAgentContext, tokenLabel, useAgentContext, type AgentContextView } from "./useAgentContext";
import type { Project } from "../../data/types";

const getAgentContext = vi.fn();
const getMemoryConfig = vi.fn();
const listInstalled = vi.fn();
vi.mock("../../api/agentContext", () => ({ getAgentContext: (...args: unknown[]) => getAgentContext(...args) }));
vi.mock("../../api/memory", () => ({ getMemoryConfig: (...args: unknown[]) => getMemoryConfig(...args), getMemoryOverview: vi.fn() }));
vi.mock("../../api/skills", () => ({ listInstalled: (...args: unknown[]) => listInstalled(...args) }));
vi.mock("../../api", () => ({ getInstructions: vi.fn() }));

/** Shaped like `GET /api/v1/projects/{id}/agent-context` on a repo project. */
const RESPONSE: AgentContextResponse = {
  agent: "claude-acp",
  agent_label: "Claude Code",
  total_tokens: 9421,
  partial: true,
  sources: [
    { id: "instructions", name: "Instructions", enabled: true, tokens: 3410, partial: false, detail: "Grove session instructions · CLAUDE.md · edited 2d ago", items: [{ name: "Grove session instructions", tokens: 512 }, { name: "CLAUDE.md", tokens: 2898 }] },
    { id: "memory", name: "Memory", enabled: false, tokens: 0, partial: false, detail: "Turn on to keep what agents learn here", items: [] },
    { id: "mcp", name: "MCP servers", enabled: true, tokens: 6011, partial: true, detail: "grove, grove_agent, figma · tool schemas of others load on connect", items: [{ name: "grove", tokens: 2100 }, { name: "grove_agent", tokens: 3911 }, { name: "figma", tokens: null, note: "Installed server" }] },
    { id: "skills", name: "Skills", enabled: false, tokens: 0, partial: false, detail: "None installed for Claude Code", items: [] },
  ],
};

const repo = { id: "p1", projectType: "repo" } as Project;

describe("AgentContextCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  function render(context: AgentContextView, onNavigate = vi.fn()) {
    act(() => root.render(<AgentContextCard context={context} onNavigate={onNavigate} />));
    return onNavigate;
  }

  it("shows the total, a budget segment per loaded source and per-source estimates", () => {
    const onNavigate = render({ loaded: true, ...fromAgentContext(RESPONSE, repo) });
    expect(container.querySelector(".odb-ctx-sum b")?.textContent).toBe("~9.4k+");
    const segments = [...container.querySelectorAll<HTMLElement>(".odb-seg")];
    expect(segments.map((segment) => [segment.className.match(/is-(\w+)/)?.[1], segment.style.flexGrow])).toEqual([["instructions", "3410"], ["mcp", "6011"]]);
    const rows = [...container.querySelectorAll<HTMLElement>(".odb-src-row")];
    expect(rows.map((row) => row.querySelector(".odb-tok")?.textContent)).toEqual(["~3.4k", "~0", "~6.0k+", "~0"]);
    // Off sources keep their glyph colour; the Off pill shows and the estimate dims.
    expect(rows[1].classList.contains("is-off")).toBe(true);
    expect(rows[1].querySelector(".odb-off")?.textContent).toBe("Off");
    expect(rows[1].querySelector(".odb-tok")?.classList.contains("is-dim")).toBe(true);
    // Repo instruction files have no Grove page: no chevron, not a button.
    expect(rows[0].tagName).toBe("DIV");
    expect(rows[0].querySelector(".odb-chev")).toBeNull();
    act(() => rows[2].click());
    expect(onNavigate).toHaveBeenCalledWith("skills");
    act(() => rows[2].dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(container.querySelector(".odb-budget")?.classList.contains("is-hovering")).toBe(true);
    expect(container.querySelector(".odb-seg.is-mcp")?.classList.contains("is-hot")).toBe(true);
  });

  it("renders counts-only rows without a total when there are no estimates", () => {
    render({ loaded: true, total: null, partial: false, sources: [{ id: "skills", name: "Skills", detail: "Installed for your agents", on: true, tokens: null, partial: false, label: "3 skills", page: "skills" }] });
    expect(container.querySelector(".odb-ctx-sum")).toBeNull();
    expect(container.querySelector(".odb-budget")).toBeNull();
    expect(container.querySelector(".odb-tok")?.textContent).toBe("3 skills");
  });

  it("formats token labels", () => {
    expect(tokenLabel(512, false)).toBe("~512");
    expect(tokenLabel(1200, true)).toBe("~1.2k+");
  });
});

describe("useAgentContext", () => {
  let container: HTMLDivElement;
  let root: Root;
  let view: AgentContextView | null = null;
  function Probe({ project }: { project: Project }) {
    view = useAgentContext(project);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the endpoint's estimates and links Studio instructions to Studio", async () => {
    getAgentContext.mockResolvedValue(RESPONSE);
    await act(async () => root.render(<Probe project={{ id: "s1", projectType: "studio" } as Project} />));
    expect(view?.total).toBe(9421);
    expect(view?.sources.map((source) => source.page)).toEqual(["resource", "memory", "skills", "skills"]);
  });

  it("falls back to counts when the server has no endpoint", async () => {
    getAgentContext.mockRejectedValue({ status: 404, message: "Not Found" });
    getMemoryConfig.mockResolvedValue({ enabled: false });
    listInstalled.mockResolvedValue([{}, {}]);
    await act(async () => root.render(<Probe project={repo} />));
    expect(view?.loaded).toBe(true);
    expect(view?.total).toBeNull();
    expect(view?.sources.map((source) => [source.id, source.tokens, source.label])).toEqual([["memory", null, null], ["skills", null, "2 skills"]]);
  });
});
