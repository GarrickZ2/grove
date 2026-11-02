import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryConfigInput } from "../../api/memory";
import { DEFAULT_DRAFT, sameMemoryConfig } from "../../components/Memory/memoryModel";
import type { MemoryConfigDraftState } from "../../components/Memory/useMemoryConfigDraft";
import { useMemoryAutosave } from "./useMemoryAutosave";

const SAVED: MemoryConfigInput = { ...DEFAULT_DRAFT, enabled: true, agent_config: { source: "default", agent_id: "claude" } };

describe("useMemoryAutosave", () => {
  let container: HTMLDivElement;
  let root: Root;
  let autosave: ReturnType<typeof useMemoryAutosave>;
  let setDraftOutside: (draft: MemoryConfigInput) => void;
  let save: ReturnType<typeof vi.fn>;

  function Probe() {
    const [draft, setDraft] = useState<MemoryConfigInput>(SAVED);
    setDraftOutside = setDraft;
    const editor = {
      draft,
      setDraft,
      isDirty: !sameMemoryConfig(draft, SAVED),
      saving: false,
      save,
      chooseAgent: (agentId: string) => setDraft((current) => ({ ...current, agent_config: { source: "default", agent_id: agentId } })),
    } as unknown as MemoryConfigDraftState;
    autosave = useMemoryAutosave(editor);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    save = vi.fn(async () => true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function flush(ms = 500) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("never saves a draft change it didn't make (agent reconciliation)", async () => {
    act(() => setDraftOutside({ ...SAVED, deep_organization: true }));
    await flush();
    expect(save).not.toHaveBeenCalled();
  });

  it("saves an edit quietly after a short pause and counts it", async () => {
    act(() => autosave.edit((current) => ({ ...current, deep_organization: true })));
    await flush(100);
    expect(save).not.toHaveBeenCalled();
    await flush();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ deep_organization: true }), true);
    expect(autosave.savedCount).toBe(1);
  });

  it("holds an invalid draft and reports why", async () => {
    act(() => autosave.edit((current) => ({ ...current, agent_config: { source: "default" } })));
    await flush();
    expect(save).not.toHaveBeenCalled();
    expect(autosave.problem).toContain("organizer");
    act(() => autosave.editAgent("codex"));
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a failed save until the next edit", async () => {
    save.mockResolvedValue(false);
    act(() => autosave.edit((current) => ({ ...current, deep_organization: true })));
    await flush();
    await flush(2000);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => autosave.edit((current) => ({ ...current, pending_log_threshold: 10 })));
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
  });
});
