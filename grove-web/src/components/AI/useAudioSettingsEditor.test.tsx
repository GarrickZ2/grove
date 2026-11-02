import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistOverride, persistRemoveOverride } from "../../keyboard";
import { defaultAudioSettings } from "./useAISettingsData";
import { clampDraft, useAudioSettingsEditor, type AudioSettingsEditor } from "./useAudioSettingsEditor";
import type { AudioSettings } from "./types";

vi.mock("../../keyboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../keyboard")>()),
  persistOverride: vi.fn(() => Promise.resolve()),
  persistRemoveOverride: vi.fn(() => Promise.resolve()),
}));

describe("clampDraft", () => {
  it("clamps, floors, and falls back on non-numbers", () => {
    expect(clampDraft("0", 1, 10, 2)).toBe(1);
    expect(clampDraft("99", 1, 10, 2)).toBe(10);
    expect(clampDraft("4.7", 1, 10, 2)).toBe(4);
    expect(clampDraft("abc", 1, 10, 2)).toBe(2);
  });
});

describe("useAudioSettingsEditor", () => {
  let container: HTMLDivElement;
  let root: Root;
  let editor: AudioSettingsEditor;
  let onSaved: ReturnType<typeof vi.fn<(settings: AudioSettings) => void>>;

  function Probe({ settings }: { settings: AudioSettings }) {
    editor = useAudioSettingsEditor(settings, onSaved);
    return null;
  }

  const render = (settings: AudioSettings) => act(() => root.render(<Probe settings={settings} />));
  const lastSaved = () => onSaved.mock.calls.at(-1)?.[0];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onSaved = vi.fn();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    render({ ...defaultAudioSettings, enabled: true, reviseEnabled: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("turning transcription off also turns revision off, and saves", async () => {
    await act(async () => editor.toggleTranscription());
    expect(editor.audio.enabled).toBe(false);
    expect(editor.audio.reviseEnabled).toBe(false);
    expect(lastSaved()).toMatchObject({ enabled: false, reviseEnabled: false });
    // Revision can't be switched on while transcription is off.
    await act(async () => editor.toggleRevision());
    expect(editor.audio.reviseEnabled).toBe(false);
  });

  it("commits duration drafts clamped to their limits", async () => {
    act(() => editor.durations.maxDuration.setDraft("1000"));
    await act(async () => editor.durations.maxDuration.commit());
    expect(editor.audio.maxDuration).toBe(300);
    expect(editor.durations.maxDuration.draft).toBe("300");
    act(() => editor.durations.pttActivationDelayMs.setDraft("20"));
    await act(async () => editor.durations.pttActivationDelayMs.commit());
    expect(lastSaved()?.pttActivationDelayMs).toBe(100);
  });

  it("adds and removes vocabulary in the chosen list and scope", async () => {
    act(() => editor.vocabulary.setScope("global"));
    act(() => editor.vocabulary.setDraftTerm("  Grove  "));
    await act(async () => editor.vocabulary.add());
    expect(editor.audio.preferredTermsGlobal).toEqual(["Grove"]);
    expect(editor.vocabulary.rows.map((row) => row.from)).toEqual(["Grove"]);

    act(() => editor.vocabulary.setTab("replacement"));
    expect(editor.vocabulary.canAdd).toBe(false);
    act(() => {
      editor.vocabulary.setDraftReplacementFrom("make c i");
      editor.vocabulary.setDraftReplacementTo("make ci");
    });
    await act(async () => editor.vocabulary.add());
    expect(editor.audio.replacementsGlobal).toEqual([{ from: "make c i", to: "make ci" }]);

    await act(async () => editor.vocabulary.remove(editor.vocabulary.rows[0]));
    expect(editor.audio.replacementsGlobal).toEqual([]);
    expect(editor.audio.preferredTermsGlobal).toEqual(["Grove"]);
  });

  it("records a toggle shortcut and mirrors / clears the push-to-talk key in the keymap", async () => {
    act(() => editor.toggleRecordingTarget("toggle"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", code: "KeyH", metaKey: true, shiftKey: true }));
    });
    expect(editor.audio.toggleShortcut).toBe("Cmd+Shift+H");
    expect(editor.recordingTarget).toBeNull();

    act(() => editor.toggleRecordingTarget("ptt"));
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true }));
    });
    expect(editor.audio.pushToTalkKey).toBe("AltRight");
    expect(persistOverride).toHaveBeenCalledWith(expect.objectContaining({ command_id: "audio.ptt.start", key: "AltRight" }));

    await act(async () => editor.clearShortcut("ptt"));
    expect(editor.audio.pushToTalkKey).toBe("");
    expect(persistRemoveOverride).toHaveBeenCalledWith("audio.ptt.start");
  });

  it("edits the revision instruction per scope and only applies it on save", async () => {
    act(() => editor.prompt.startEdit());
    act(() => editor.prompt.setDraft("Project rules"));
    expect(editor.audio.revisePromptProject).toBe("");
    act(() => editor.prompt.cancelEdit());
    expect(editor.prompt.draft).toBe("");

    act(() => editor.prompt.startEdit());
    act(() => editor.prompt.setScope("global"));
    act(() => editor.prompt.setDraft("Global rules"));
    await act(async () => editor.prompt.saveEdit());
    expect(editor.audio.revisePromptGlobal).toBe("Global rules");
    expect(editor.prompt.isEditing).toBe(false);
  });

  it("re-syncs when new settings arrive from upstream", () => {
    render({ ...defaultAudioSettings, minDuration: 5, transcribeProvider: "p1" });
    expect(editor.audio.transcribeProvider).toBe("p1");
    expect(editor.durations.minDuration.draft).toBe("5");
  });
});
