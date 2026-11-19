import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactFile } from "../../../../api";
import type { Task } from "../../../../data/types";
import { useArtifactsPanel, type ArtifactsPanel, type SharedArtifacts } from "./useArtifactsPanel";

const FILE: ArtifactFile = { name: "p.md", path: "p.md", size: 1, modified_at: "2026-11-19T00:00:00Z", is_dir: false, directory: "output" };

describe("useArtifactsPanel live preview", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the shown text when a poll reads the file mid-write, empty", async () => {
    const reads = ["first", "", "second"];
    const shared: SharedArtifacts = {
      list: async () => [FILE],
      preview: async () => reads.shift() ?? "second",
      downloadUrl: () => "/d",
    };
    let panel: ArtifactsPanel | null = null;
    function Probe({ busy }: { busy: boolean }) {
      panel = useArtifactsPanel({ task: { id: "t" } as Task, isChatBusy: busy, shared });
      return null;
    }
    await act(async () => root.render(<Probe busy />));
    await act(async () => { await panel!.handlePreview(FILE); });
    expect(panel!.previewFile?.content).toBe("first");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(panel!.previewFile?.content).toBe("first");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(panel!.previewFile?.content).toBe("second");
  });
});
