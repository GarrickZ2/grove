import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "../../keyboard";
import { defaultVoiceControlSettings } from "./useAISettingsData";
import { recommendedDisabledActions, useVoiceControlEditor, type VoiceControlEditor } from "./useVoiceControlEditor";
import type { VoiceControlSettings } from "./types";

vi.mock("../../keyboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../keyboard")>()),
  persistOverride: vi.fn(() => Promise.resolve()),
  persistRemoveOverride: vi.fn(() => Promise.resolve()),
}));

const catalog = [
  { id: "nav.home", name: "Go home", category: "Navigation" },
  { id: "task.new", name: "New task", category: "Tasks", description: "Create a task" },
  { id: "chat.send", name: "Send message", category: "Chat" },
  { id: "debug.secret", name: "Secret", category: "Debug", hidden: true },
];

describe("recommendedDisabledActions", () => {
  it("disables everything outside the recommended set", () => {
    expect(recommendedDisabledActions(["nav.home", "help.open", "task.new", "chat.send", "task.delete"])).toEqual(["chat.send", "task.delete"]);
  });
});

describe("useVoiceControlEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: VoiceControlEditor;
  let onSaved: ReturnType<typeof vi.fn<(settings: VoiceControlSettings) => void>>;

  function Probe({ settings }: { settings: VoiceControlSettings }) {
    editor = useVoiceControlEditor(settings, onSaved);
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    commandRegistry.setStaticCatalog(catalog);
    onSaved = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    commandRegistry.setStaticCatalog([]);
    vi.unstubAllGlobals();
  });

  it("seeds recommended actions once and saves them", () => {
    act(() => root.render(<Probe settings={defaultVoiceControlSettings} />));
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ hasInitializedActions: true, disabledActions: ["chat.send"] }));
    expect(editor.allCommands.map((command) => command.id)).toEqual(["nav.home", "task.new", "chat.send"]);
    expect(editor.isActionEnabled("task.new")).toBe(true);
    expect(editor.isActionEnabled("chat.send")).toBe(false);
  });

  it("filters, toggles and bulk-sets actions", async () => {
    act(() => root.render(<Probe settings={{ ...defaultVoiceControlSettings, enabled: true, hasInitializedActions: true }} />));
    expect(onSaved).not.toHaveBeenCalled();
    expect(editor.categories).toEqual(["Chat", "Navigation", "Tasks"]);
    act(() => editor.setSearchQuery("create"));
    expect(editor.filteredCommands.map((command) => command.id)).toEqual(["task.new"]);
    act(() => { editor.setSearchQuery(""); editor.setCategoryFilter("Chat"); });
    expect(editor.filteredCommands.map((command) => command.id)).toEqual(["chat.send"]);

    await act(async () => editor.toggleActionEnabled("chat.send"));
    expect(editor.settings.disabledActions).toEqual(["chat.send"]);
    await act(async () => editor.disableAllActions());
    expect(editor.settings.disabledActions).toEqual(["nav.home", "task.new", "chat.send"]);
    await act(async () => editor.applyRecommendedActions());
    expect(editor.settings.disabledActions).toEqual(["chat.send"]);
    await act(async () => editor.enableAllActions());
    expect(onSaved.mock.calls.at(-1)?.[0].disabledActions).toEqual([]);
  });

  it("clamps listening limits and restores a draft on reset", async () => {
    act(() => root.render(<Probe settings={{ ...defaultVoiceControlSettings, enabled: true, hasInitializedActions: true }} />));
    act(() => editor.setDraft("maxDuration", "120"));
    await act(async () => editor.commitDuration("maxDuration"));
    expect(editor.settings.maxDuration).toBe(60);
    act(() => editor.setDraft("pttActivationDelayMs", "abc"));
    act(() => editor.resetDraft("pttActivationDelayMs"));
    expect(editor.drafts.pttActivationDelayMs).toBe("500");
  });
});
