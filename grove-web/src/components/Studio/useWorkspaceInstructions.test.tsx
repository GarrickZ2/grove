import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getInstructions: vi.fn(async () => ({ content: "# Rules" })),
  updateInstructions: vi.fn(async (_id: string, content: string) => ({ content })),
}));
vi.mock("../../api", () => api);

import { useWorkspaceInstructions, type WorkspaceInstructions } from "./useWorkspaceInstructions";

describe("useWorkspaceInstructions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: WorkspaceInstructions;

  function Probe() {
    state = useWorkspaceInstructions("p1");
    return null;
  }

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
  };

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    api.updateInstructions.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
    await flush();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads, edits and saves, then leaves edit mode", async () => {
    expect(state.isLoadingInstructions).toBe(false);
    expect(state.instructions).toBe("# Rules");
    act(() => { state.setIsEditingInstructions(true); state.insertTemplate("# Added"); });
    expect(state.instructions).toBe("# Rules\n\n# Added");
    expect(state.hasUnsaved).toBe(true);
    await act(async () => { await state.handleSaveInstructions(); });
    expect(api.updateInstructions).toHaveBeenCalledWith("p1", "# Rules\n\n# Added");
    expect(state.hasUnsaved).toBe(false);
    expect(state.isEditingInstructions).toBe(false);
    expect(state.saveCount).toBe(1);
    expect(state.saveMessage).toBe("Saved");
  });

  it("cancel restores the saved text", () => {
    act(() => { state.setIsEditingInstructions(true); state.setInstructions("draft"); });
    act(() => state.cancelEditing());
    expect(state.instructions).toBe("# Rules");
    expect(state.isEditingInstructions).toBe(false);
  });

  it("keeps editing and reports a failed save", async () => {
    api.updateInstructions.mockRejectedValueOnce(new Error("disk full"));
    act(() => { state.setIsEditingInstructions(true); state.setInstructions("x"); });
    await act(async () => { await state.handleSaveInstructions(); });
    expect(state.saveMessage).toBe("disk full");
    expect(state.isEditingInstructions).toBe(true);
    expect(state.hasUnsaved).toBe(true);
    expect(state.saveCount).toBe(0);
  });
});
