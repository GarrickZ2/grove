import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../data/types";
import { OrbitInterfaceContext } from "../../ui/interfaceContext";
import { CommentsTab } from "../../../components/Tasks/TaskInfoPanel/tabs/CommentsTab";
import { GitTab } from "../../../components/Tasks/TaskInfoPanel/tabs/GitTab";
import { NotesTab } from "../../../components/Tasks/TaskInfoPanel/tabs/NotesTab";
import { PanelShell } from "../../ui/PanelShell";
import { PANEL_HUES } from "../../ui/panelSlots";
import { FileText } from "lucide-react";
import { OPEN_REVIEW_EVENT, takeOpenReviewRequest } from "../openReview";

const api = {
  getReviewComments: vi.fn(),
  getDiff: vi.fn(),
  getCommits: vi.fn(),
  getNotes: vi.fn(),
  updateNotes: vi.fn(),
  getTaskFiles: vi.fn(),
};
vi.mock("../../../api", () => ({
  getReviewComments: (...a: unknown[]) => api.getReviewComments(...a),
  getDiff: (...a: unknown[]) => api.getDiff(...a),
  getCommits: (...a: unknown[]) => api.getCommits(...a),
  getNotes: (...a: unknown[]) => api.getNotes(...a),
  updateNotes: (...a: unknown[]) => api.updateNotes(...a),
  getTaskFiles: (...a: unknown[]) => api.getTaskFiles(...a),
}));
vi.mock("../../../context/ProjectContext", () => ({ useProject: () => ({ selectedProject: { id: "p1" } }) }));
vi.mock("../../../components/ui", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-md>{content}</div>,
  FileMentionDropdown: () => null,
  Button: ({ children, ...rest }: { children: React.ReactNode }) => <button type="button" {...rest}>{children}</button>,
}));
vi.mock("../../../components/Review/AgentAvatar", () => ({ AgentAvatar: () => <span /> }));
vi.mock("../../../components/Review/agentDisplay", () => ({ AgentDisplay: ({ agent }: { agent: string }) => <>{agent}</> }));

const task = { id: "t1", name: "Paging", branch: "feat/paging", target: "master", status: "active", createdAt: new Date(), updatedAt: new Date(), multiplexer: "tmux" } as Task;

const comment = (id: number, status: string, extra = {}) => ({
  id, status, content: `comment ${id}`, agent: "claude", model: "", role: "reviewer", timestamp: new Date().toISOString(), replies: [], file_path: "src/a.ts", start_line: 3, end_line: 3, ...extra,
});

describe("Orbit task panels", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.values(api).forEach((fn) => fn.mockReset());
    api.getTaskFiles.mockResolvedValue({ files: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = async (node: React.ReactNode, orbit: boolean) => {
    await act(async () => {
      root.render(<OrbitInterfaceContext.Provider value={orbit}>{node}</OrbitInterfaceContext.Provider>);
    });
    await act(async () => { await Promise.resolve(); });
  };

  it("Comments: Open in Review asks the workspace for the comment's file and line", async () => {
    api.getReviewComments.mockResolvedValue({ comments: [comment(1, "open")], open_count: 1, resolved_count: 0, outdated_count: 0 });
    const seen: unknown[] = [];
    const onOpen = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(OPEN_REVIEW_EVENT, onOpen);
    await render(<CommentsTab projectId="p1" task={task} />, true);
    const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "Open in Review");
    await act(async () => open!.click());
    window.removeEventListener(OPEN_REVIEW_EVENT, onOpen);
    expect(seen).toEqual([{ projectId: "p1", taskId: "t1", file: "src/a.ts", line: 3, mode: "diff" }]);
    takeOpenReviewRequest("p1", "t1");
  });

  it("Comments: Orbit opens on what's open; Workbench keeps its filter buttons", async () => {
    api.getReviewComments.mockResolvedValue({
      comments: [comment(1, "open"), comment(2, "outdated"), comment(3, "resolved", { comment_type: "project", file_path: undefined })],
      open_count: 1, resolved_count: 1, outdated_count: 1,
    });
    await render(<CommentsTab projectId="p1" task={task} />, true);
    expect(container.querySelector(".owp")).not.toBeNull();
    const radios = [...container.querySelectorAll('[role="radio"]')];
    expect(radios.map((r) => r.textContent)).toEqual(["Open2", "All3", "Resolved1"]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    expect(container.querySelectorAll(".owp-cmt")).toHaveLength(2);
    expect(container.textContent).toContain("a.ts:L3");

    await act(async () => { (radios[2] as HTMLButtonElement).click(); });
    expect(container.querySelectorAll(".owp-cmt")).toHaveLength(1);
    expect(container.textContent).toContain("Whole change");

    await render(<CommentsTab projectId="p1" task={task} />, false);
    expect(container.querySelector(".owp")).toBeNull();
    expect(container.textContent).toContain("3 All");
    expect(container.textContent).toContain("2 Open");
  });

  it("Comments: a failed load says so in Orbit and retries", async () => {
    api.getReviewComments.mockRejectedValueOnce(new Error("Task not found"));
    await render(<CommentsTab projectId="p1" task={task} />, true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Task not found");
    api.getReviewComments.mockResolvedValue({ comments: [], open_count: 0, resolved_count: 0, outdated_count: 0 });
    await act(async () => { container.querySelector<HTMLButtonElement>(".oui-panel-error-acts button")?.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(api.getReviewComments).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("No review comments");
  });

  it("Git: shows the branch flow, changed files and commits", async () => {
    api.getDiff.mockResolvedValue({ files: [{ path: "src/api/tasks.ts", status: "M", additions: 4, deletions: 1 }, { path: "README.md", status: "A", additions: 2, deletions: 0 }], total_additions: 6, total_deletions: 1 });
    api.getCommits.mockResolvedValue({ commits: [{ hash: "abcdef1234", message: "feat: paging", time_ago: "1h ago" }], total: 1, skip_versions: 0 });
    await render(<GitTab projectId="p1" task={task} />, true);
    expect(container.querySelector(".owp-gflow")?.textContent).toContain("feat/paging");
    expect(container.querySelectorAll(".owp-chg")).toHaveLength(2);
    expect(container.querySelector(".owp-commit")?.textContent).toContain("abcdef1");
    expect(container.querySelector(".owp-chips")?.textContent).toContain("1 commit");
  });

  it("Notes: empty notes offer to start one; Workbench keeps Add Notes", async () => {
    api.getNotes.mockResolvedValue({ content: "" });
    await render(<NotesTab projectId="p1" task={task} />, true);
    const start = [...container.querySelectorAll("button")].find((b) => b.textContent === "Start a note");
    expect(start).toBeDefined();
    await act(async () => { start!.click(); });
    expect(container.querySelector(".owp-editor textarea")).not.toBeNull();
    expect(api.updateNotes).not.toHaveBeenCalled();

    await render(<NotesTab projectId="p1" task={{ ...task, id: "t2" }} />, false);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".owp")).toBeNull();
    expect(container.textContent).toContain("Add Notes");
  });

  it("In a panel shell: Notes puts Edit in the header, Comments sets the header context", async () => {
    api.getNotes.mockResolvedValue({ content: "# Goal" });
    const shell = (node: React.ReactNode) => <PanelShell glyph={FileText} hue={PANEL_HUES.blue} title="Panel" context="default">{node}</PanelShell>;
    await render(shell(<NotesTab projectId="p1" task={task} />), true);
    await act(async () => { await Promise.resolve(); });
    const edit = container.querySelector<HTMLButtonElement>('.oui-panel-actions [aria-label="Edit notes"]');
    expect(edit).not.toBeNull();
    expect(container.querySelector(".owp-notebar button")).toBeNull();
    await act(async () => { edit!.click(); });
    expect(container.querySelector(".owp-editor textarea")).not.toBeNull();
    expect(container.querySelector('.oui-panel-actions [aria-label="Edit notes"]')).toBeNull();

    api.getReviewComments.mockResolvedValue({ comments: [comment(1, "open"), comment(2, "outdated")], open_count: 1, resolved_count: 0, outdated_count: 1 });
    await render(shell(<CommentsTab projectId="p1" task={{ ...task, id: "t3" }} />), true);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector(".oui-panel-ctx-slot")?.textContent).toBe("2 open");
  });
});
