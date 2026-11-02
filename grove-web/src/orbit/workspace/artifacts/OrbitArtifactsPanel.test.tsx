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
    expect(Array.from(container.querySelectorAll(".oui-panel-menu-label"), (el) => el.textContent))
      .toEqual(["Add link to uploads…", "Link a folder…", expect.stringMatching(/^Show in /)]);
  });
});
