import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "../../keyboard";
import { useShortcutSettings, type ShortcutSettingsState } from "./useShortcutSettings";

const catalog = [
  { id: "palette.open", name: "Open Command Palette", category: "General", defaultBindings: [{ key: "Mod+Shift+P" }] },
  { id: "chat.send", name: "Send message", category: "Chat", description: "Send the composer text", defaultBindings: [{ key: "Enter" }] },
  { id: "chat.stop", name: "Stop agent", category: "Chat", defaultBindings: [{ key: "Mod+." }] },
  { id: "debug.secret", name: "Secret debug", category: "Debug", hidden: true },
];

describe("useShortcutSettings", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: ShortcutSettingsState;

  function Probe() {
    state = useShortcutSettings();
    return null;
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    commandRegistry.setStaticCatalog(catalog);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Probe />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    commandRegistry.setStaticCatalog([]);
    vi.unstubAllGlobals();
  });

  const ids = () => state.filtered.map((command) => command.id);

  it("groups visible commands by category and hides hidden ones", () => {
    expect(state.grouped.map(([category, commands]) => [category, commands.map((c) => c.id)])).toEqual([
      ["General", ["palette.open"]],
      ["Chat", ["chat.send", "chat.stop"]],
    ]);
    act(() => state.setShowHidden(true));
    expect(ids()).toContain("debug.secret");
  });

  it("searches names, ids, categories and descriptions", () => {
    act(() => state.setSearch("composer"));
    expect(ids()).toEqual(["chat.send"]);
    act(() => state.setSearch("CHAT"));
    expect(ids()).toEqual(["chat.send", "chat.stop"]);
    act(() => state.setSearch("palette.open"));
    expect(ids()).toEqual(["palette.open"]);
    act(() => state.setSearch("nothing like this"));
    expect(state.grouped).toEqual([]);
  });

  it("filters by a recorded key combo", () => {
    act(() => state.setKeyFilter("Mod+."));
    expect(ids()).toEqual(["chat.stop"]);
  });

  it("records a combo into the key filter", () => {
    act(() => state.setKeyRecording(true));
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(state.keyRecording).toBe(false);
    expect(ids()).toEqual(["chat.send"]);
  });

  it("collapses and expands a category", () => {
    act(() => state.toggleCategory("Chat"));
    expect(state.collapsedCategories.has("Chat")).toBe(true);
    act(() => state.toggleCategory("Chat"));
    expect(state.collapsedCategories.has("Chat")).toBe(false);
  });

  it("seeds the edit modal from the catalog defaults", () => {
    act(() => state.setEditing(catalog[0]));
    expect(state.editingBindings).toEqual([{ key: "Mod+Shift+P", when: "", scope: "" }]);
  });
});
