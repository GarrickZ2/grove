import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIslandInteraction } from "./useIslandInteraction";

describe("Island interaction lifetime", () => {
  let host: HTMLDivElement;
  let root: Root;
  function Harness({ enabled = true }: { enabled?: boolean }) {
    const interaction = useIslandInteraction(enabled);
    return <>
      <aside ref={interaction.surfaceRef} onMouseEnter={interaction.enter} onMouseLeave={interaction.leave}
        onPointerDownCapture={interaction.pin} onFocusCapture={interaction.pin}>
        <output>{interaction.isOpen ? "open" : "closed"}</output>
        <button onClick={interaction.pin}>Projects</button>
        <input />
        <button onClick={interaction.close}>Select project</button>
      </aside>
      <button data-outside>Outside</button>
    </>;
  }
  const el = (selector: string) => host.querySelector<HTMLElement>(selector)!;
  const state = () => el("output").textContent;
  const enter = () => el("aside").dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const leave = () => el("aside").dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  const pointerDown = (element: HTMLElement) => element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Harness />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("still dismisses a hover preview, cancelling stale timers on re-entry", () => {
    act(enter);
    act(leave);
    act(() => vi.advanceTimersByTime(100));
    act(enter);
    act(() => vi.advanceTimersByTime(500));
    expect(state()).toBe("open");
    act(leave);
    act(() => vi.advanceTimersByTime(200));
    expect(state()).toBe("closed");
  });

  it("cancels a pending close before click-open morphing causes mouseleave", () => {
    act(enter);
    act(leave);
    act(() => {
      pointerDown(el("button"));
      el("button").click();
      leave();
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(state()).toBe("open");
    act(() => pointerDown(el("input")));
    expect(state()).toBe("open");
  });

  it("keeps keyboard interaction open until Escape", () => {
    act(() => el("input").focus());
    act(leave);
    act(() => vi.advanceTimersByTime(5000));
    expect(state()).toBe("open");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(state()).toBe("closed");
  });

  it("dismisses on outside pointerdown and explicit selection", () => {
    act(() => el("button").click());
    act(() => pointerDown(el("[data-outside]")));
    expect(state()).toBe("closed");
    act(() => el("button").click());
    act(() => el("aside button:last-child").click());
    expect(state()).toBe("closed");
  });

  it("clears pinned state when leaving Island mode", () => {
    act(() => el("button").click());
    act(() => root.render(<Harness enabled={false} />));
    expect(state()).toBe("closed");
    act(() => root.render(<Harness />));
    act(enter);
    act(leave);
    act(() => vi.advanceTimersByTime(200));
    expect(state()).toBe("closed");
  });
});
