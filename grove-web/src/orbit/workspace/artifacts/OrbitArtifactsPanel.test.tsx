import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFile } from "../../../api";
import type { Task } from "../../../data/types";

vi.mock("../../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));
vi.mock("../../studio/useSignedUrl", () => ({ useSignedUrl: () => null }));
vi.mock("../../../api", () => ({ artifactDownloadUrl: () => "/download" }));
vi.mock("../../../components/ui", () => ({
  AddLinkDialog: () => null,
  FileConflictDialog: () => null,
  FilePreviewDrawer: ({ fileName }: { fileName: string }) => <div data-testid="preview">{fileName}</div>,
  VSCodeIcon: () => <span />,
  formatSize: (bytes: number) => `${bytes} B`,
  isLinkFile: (name: string) => name.endsWith(".link.json"),
  linkDisplayName: (name: string) => name.replace(/\.link\.json$/, ""),
  hostnameOf: (url: string) => url,
}));

const panelState: { current: Record<string, unknown> } = { current: {} };
vi.mock("../../../components/Tasks/TaskInfoPanel/tabs/useArtifactsPanel", () => ({
  useArtifactsPanel: () => panelState.current,
}));

const { OrbitArtifactsPanel } = await import("./OrbitArtifactsPanel");
const { PanelShell, PANEL_HUES } = await import("../../ui");
const { FolderOpen } = await import("lucide-react");

function file(path: string, directory = "output", isDir = false): ArtifactFile {
  return { name: path.split("/").pop()!, path, size: 10, modified_at: "2026-10-01T00:00:00Z", is_dir: isDir, directory };
}

function fakePanel(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "p",
    taskId: "t",
    inputFiles: [],
    outputFiles: [],
    workdirs: [],
    isLoading: false,
    isLoadingWorkdirs: false,
    error: null,
    setError: vi.fn(),
    toastMessage: null,
    previewFile: null,
    previewLoading: false,
    previewError: null,
    syncConflict: null,
    editLink: null,
    addLinkOpen: false,
    pendingUploads: [],
    isUploading: false,
    isAddingWorkdir: false,
    handlePreview: vi.fn(),
    handleDownload: vi.fn(),
    handleUpload: vi.fn(),
    handleOpenLink: vi.fn(),
    loadFiles: vi.fn(),
    loadWorkdirs: vi.fn(),
    setAddLinkOpen: vi.fn(),
    folderPicker: null,
    ...overrides,
  };
}

const TASK = { id: "t" } as Task;

describe("OrbitArtifactsPanel", () => {
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
    vi.unstubAllGlobals();
  });

  const render = () => act(() => root.render(<OrbitArtifactsPanel projectId="p" task={TASK} />));
  const rows = () => container.querySelectorAll(".oar-row");
  const click = (element: Element | null) => act(() => { (element as HTMLElement).click(); });

  it("mounts only a window of rows for a folder with thousands of files", () => {
    const many = Array.from({ length: 5_000 }, (_, i) => file(`frame-${i}.png`));
    panelState.current = fakePanel({ outputFiles: many });
    render();
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(40);
    expect(container.querySelector(".oar-foot")?.textContent).toContain("5,000 files");
  });

  it("separates the agent's files from yours and opens on the agent's", () => {
    panelState.current = fakePanel({ inputFiles: [file("brief.md", "input")], outputFiles: [file("report.pdf"), file("hero.png")] });
    render();
    const sources = container.querySelectorAll('[aria-label="Source"] [role="radio"]');
    expect(Array.from(sources, (s) => s.textContent)).toEqual(["Outputs2", "Uploads1", "Linked0"]);
    expect(Array.from(rows(), (r) => r.getAttribute("aria-label"))).toEqual(expect.arrayContaining(["report.pdf", "hero.png"]));
    click(sources[1]);
    expect(Array.from(rows(), (r) => r.getAttribute("aria-label"))).toEqual(["brief.md"]);
  });

  it("enters and leaves folders through rows, the back button and the trail", () => {
    panelState.current = fakePanel({
      outputFiles: [file("site", "output", true), file("site/images", "output", true), file("site/images/hero.png"), file("readme.md")],
    });
    render();
    click(container.querySelector('[aria-label="Folder site"]'));
    expect(container.querySelector('.oar-crumb[aria-current="location"]')?.textContent).toBe("site");
    click(container.querySelector('[aria-label="Folder images"]'));
    expect(Array.from(rows(), (r) => r.getAttribute("aria-label"))).toEqual(["hero.png"]);
    click(container.querySelector('[aria-label="Up one folder"]'));
    expect(container.querySelector('.oar-crumb[aria-current="location"]')?.textContent).toBe("site");
    click(container.querySelector(".oar-crumb.is-root"));
    expect(container.querySelector('[aria-label="Up one folder"]')).toBeNull();
    expect(Array.from(rows(), (r) => r.getAttribute("aria-label"))).toEqual(["Folder site", "readme.md"]);
  });

  it("previews a file on click and offers an upload in the empty uploads view", () => {
    const handlePreview = vi.fn();
    panelState.current = fakePanel({ outputFiles: [file("report.pdf")], handlePreview });
    render();
    click(container.querySelector('[aria-label="report.pdf"]'));
    expect(handlePreview).toHaveBeenCalledWith(expect.objectContaining({ path: "report.pdf" }));
    click(container.querySelectorAll('[aria-label="Source"] [role="radio"]')[1]);
    expect(container.textContent).toContain("Give the agent something to work from");
  });

  it("moves refresh, upload and folder actions into the workspace shell header", () => {
    const loadFiles = vi.fn();
    panelState.current = fakePanel({ outputFiles: [file("report.pdf"), file("site", "output", true)], loadFiles });
    act(() => root.render(
      <PanelShell glyph={FolderOpen} hue={PANEL_HUES.pink} title="Artifacts" body="fill">
        <OrbitArtifactsPanel projectId="p" task={TASK} />
      </PanelShell>,
    ));
    const header = container.querySelector(".oui-panel-head")!;
    expect(header.querySelector(".oui-panel-ctx-slot")?.textContent).toBe("1 file · 10 B");
    click(header.querySelector('[aria-label="Refresh"]'));
    expect(loadFiles).toHaveBeenCalled();
    expect(header.querySelector('[aria-label="Upload files"]')).not.toBeNull();
    // The body's own overflow menu gives way to the shell's ⋯ rows.
    expect(container.querySelector('.oar-bar [aria-label="More actions"]')).toBeNull();
    click(header.querySelector('[aria-label="Panel actions"]'));
    expect(Array.from(document.querySelectorAll('[role="menuitem"]'), (el) => el.textContent?.trim()))
      .toEqual(["Add link to uploads…", "Link a folder…", expect.stringMatching(/^Show in /), "Download folder as .zip"]);
  });
  it("selects with checkboxes and shift-click, then zips the selection", () => {
    const handleDownloadZip = vi.fn();
    const handlePreview = vi.fn();
    panelState.current = fakePanel({
      outputFiles: [file("a.md"), file("b.md"), file("c.md"), file("d.md")],
      handleDownloadZip,
      handlePreview,
    });
    act(() => root.render(<OrbitArtifactsPanel projectId="p" task={TASK} />));
    const byName = () => Array.from(rows(), (r) => r.getAttribute("aria-label"));
    const box = (name: string) => container.querySelector(`[aria-label="Select ${name}"]`);
    expect(container.querySelector(".oar-batch")).toBeNull();
    click(box(byName()[0]!));
    expect(container.querySelector(".oar-batch")?.textContent).toContain("1 item selected");
    // Shift-click on the checkbox extends from the anchor.
    act(() => { (box(byName()[2]!) as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })); });
    expect(container.querySelector(".oar-batch")?.textContent).toContain("3 items selected");
    // While selecting, a plain row click toggles instead of previewing.
    click(rows()[3]);
    expect(handlePreview).not.toHaveBeenCalled();
    expect(container.querySelector(".oar-batch")?.textContent).toContain("4 items selected");
    // Outputs can't be deleted; Download zips the selection.
    expect(container.querySelector(".oar-batch .oui-btn-hold")).toBeNull();
    const download = Array.from(container.querySelectorAll(".oar-batch button")).find((b) => b.textContent === "Download");
    click(download!);
    expect(handleDownloadZip).toHaveBeenCalledWith("output", expect.arrayContaining(["a.md", "b.md", "c.md", "d.md"]));
    // Esc on the list clears.
    act(() => { rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(container.querySelector(".oar-batch")).toBeNull();
  });

  it("drags every selected file from a selected row, and just the row otherwise", () => {
    panelState.current = fakePanel({ outputFiles: [file("a.md"), file("b.md"), file("c.md")] });
    act(() => root.render(<OrbitArtifactsPanel projectId="p" task={TASK} />));
    const byName = () => Array.from(rows(), (r) => r.getAttribute("aria-label"));
    const drag = (row: Element) => {
      const data = new Map<string, string>();
      const dataTransfer = { setData: (type: string, value: string) => { data.set(type, value); }, setDragImage: vi.fn(), effectAllowed: "" };
      const event = new Event("dragstart", { bubbles: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      act(() => { row.dispatchEvent(event); });
      return { data, dataTransfer };
    };
    const names = byName();
    const pathOf = (name: string | null) => `output/${name}`;
    // Not selected: one path, no list, no badge image.
    const single = drag(rows()[0]);
    expect(single.data.get("application/x-grove-file-path")).toBe(pathOf(names[0]));
    expect(single.data.has("application/x-grove-file-paths")).toBe(false);
    expect(single.dataTransfer.setDragImage).not.toHaveBeenCalled();
    // Select the first two; dragging the second carries both, in view order.
    click(container.querySelector(`[aria-label="Select ${names[0]}"]`));
    click(container.querySelector(`[aria-label="Select ${names[1]}"]`));
    const multi = drag(rows()[1]);
    expect(JSON.parse(multi.data.get("application/x-grove-file-paths")!)).toEqual([pathOf(names[0]), pathOf(names[1])]);
    expect(multi.data.get("application/x-grove-file-path")).toBe(pathOf(names[0]));
    expect(multi.dataTransfer.setDragImage).toHaveBeenCalledTimes(1);
    const ghost = multi.dataTransfer.setDragImage.mock.calls[0][0] as HTMLElement;
    expect(ghost.textContent).toContain("2 files");
    // A row outside the selection drags alone.
    expect(drag(rows()[2]).data.has("application/x-grove-file-paths")).toBe(false);
  });

  it("deletes only selected upload files through the hold-to-confirm button", async () => {
    const handleDeleteMany = vi.fn().mockResolvedValue({ deleted: 1, failed: 0 });
    panelState.current = fakePanel({
      inputFiles: [file("docs", "input", true), file("brief.md", "input")],
      handleDeleteMany,
    });
    render();
    click(container.querySelectorAll('[aria-label="Source"] [role="radio"]')[1]);
    // Space toggles the focused row; ⌘A selects everything.
    act(() => { rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true })); });
    expect(container.querySelector(".oar-batch")?.textContent).toContain("2 items selected");
    const hold = container.querySelector<HTMLButtonElement>(".oar-batch .oui-btn-hold")!;
    expect(hold.textContent).toContain("Hold to delete 1 file");
    // Keyboard activation (detail 0) confirms at once.
    await act(async () => { hold.click(); });
    expect(handleDeleteMany).toHaveBeenCalledWith([expect.objectContaining({ path: "brief.md" })]);
  });

  it("shows determinate progress for each uploading file", () => {
    panelState.current = fakePanel({
      inputFiles: [file("old.md", "input")],
      isUploading: true,
      pendingUploads: ["big.mov", "small.png", "later.txt"],
      pendingUploadItems: [
        { id: "1", name: "big.mov", progress: 0.42 },
        { id: "2", name: "small.png", progress: null },
        { id: "3", name: "later.txt", progress: null, queued: true },
      ],
    });
    render();
    click(container.querySelectorAll('[aria-label="Source"] [role="radio"]')[1]);
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars).toHaveLength(1);
    expect(bars[0].getAttribute("aria-valuenow")).toBe("42");
    expect(container.querySelector('[aria-label="Uploading big.mov"]')?.textContent).toContain("42%");
    expect(container.querySelector('[aria-label="Uploading small.png"]')?.textContent).toContain("Uploading…");
    expect(container.querySelector('[aria-label="Uploading later.txt"]')?.textContent).toContain("Queued");
  });
});
