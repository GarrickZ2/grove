import { act, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerInteractionBoundary } from "./useComposerInteractionBoundary";

describe("mobile composer interaction boundary", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onDismiss = vi.fn();

  function Harness({ enabled = true }: { enabled?: boolean }) {
    const [open, setOpen] = useState(true);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const dismiss = useCallback(() => { setOpen(false); onDismiss(); }, []);
    const markInside = useComposerInteractionBoundary(enabled && open, dismiss);
    return <>
      <output>{open ? "expanded" : "pill"}</output>
      <div data-composer onPointerDownCapture={markInside} onFocusCapture={markInside}>
        <div contentEditable suppressContentEditableWarning tabIndex={0}>Draft</div>
        <button data-configuration onClick={() => setSettingsOpen(true)}>Configuration</button>
        <button data-attachment>Attach</button>
        {settingsOpen && createPortal(
          <div data-settings>
            <button>Model</button>
            <input aria-label="Search models" />
          </div>, document.body,
        )}
      </div>
      <div data-transcript>Conversation</div>
      <button data-outside>Another panel</button>
    </>;
  }

  const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  const pointerDown = (target: HTMLElement) => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  };
  const state = () => host.querySelector("output")?.textContent;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onDismiss.mockClear();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps Configuration open when a Safari-style button click leaves focus at body", () => {
    const editor = element("[contenteditable]");
    act(() => editor.focus());
    act(() => {
      pointerDown(element("[data-configuration]"));
      editor.blur();
      element("[data-configuration]").click();
    });
    expect(document.activeElement).toBe(document.body);
    expect(element("[data-settings]")).toBeTruthy();
    expect(state()).toBe("expanded");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps other composer buttons usable whether or not they receive focus", () => {
    act(() => {
      element("[contenteditable]").focus();
      pointerDown(element("[data-attachment]"));
      element("[data-attachment]").focus();
    });
    expect(state()).toBe("expanded");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("keeps portaled settings controls and their search input inside the boundary", () => {
    act(() => element("[data-configuration]").click());
    act(() => {
      pointerDown(element("[data-settings] button"));
      element("[data-settings] button").focus();
      element("[data-settings] input").focus();
    });
    expect(state()).toBe("expanded");
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("collapses on a transcript click even after the editor has already lost focus", () => {
    act(() => {
      element("[contenteditable]").focus();
      pointerDown(element("[data-attachment]"));
      element("[contenteditable]").blur();
    });
    expect(state()).toBe("expanded");
    act(() => pointerDown(element("[data-transcript]")));
    expect(state()).toBe("pill");
  });

  it("collapses when keyboard focus moves to another panel", () => {
    act(() => element("[contenteditable]").focus());
    act(() => element("[data-outside]").focus());
    expect(state()).toBe("pill");
  });

  it("does not dismiss a desktop composer and removes listeners on unmount", () => {
    act(() => root.render(<Harness enabled={false} />));
    act(() => pointerDown(element("[data-transcript]")));
    expect(state()).toBe("expanded");
    act(() => root.render(<Harness />));
    act(() => root.render(null));
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
