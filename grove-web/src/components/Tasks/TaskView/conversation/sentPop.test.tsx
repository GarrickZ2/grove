import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentPopContext, createSentPopRegistry, useSentPop, type SentPopRegistry } from "./sentPop";

function Bubble({ id }: { id?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSentPop(ref, id);
  return <div ref={ref} className="bubble" data-id={id}>text</div>;
}

describe("useSentPop", () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    container = document.createElement("div");
    container.setAttribute("data-sent-pop-pane", "true");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const flush = () => { const pending = frames; frames = []; pending.forEach((callback) => callback(performance.now())); };
  const tree = (registry: SentPopRegistry | null, show = true) => (
    <SentPopContext.Provider value={registry}>
      {show && <Bubble id="sent" />}
      <Bubble id="history" />
    </SentPopContext.Provider>
  );
  const sent = () => container.querySelector('[data-id="sent"]')!;
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 10, width: 10, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  it("pops a just-sent bubble once it is in view, once only", () => {
    let visible = false;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === container) return rect(0, 500);
      return visible ? rect(100, 140) : rect(600, 640);
    });
    const registry = createSentPopRegistry();
    registry.record("sent");
    act(() => root.render(tree(registry)));
    // Below the visible pane at first (the list has not scrolled yet): waits hidden.
    expect(sent().classList.contains("ocv-sent-wait")).toBe(true);
    expect(sent().classList.contains("ocv-sent-pop")).toBe(false);
    visible = true;
    flush();
    expect(sent().classList.contains("ocv-sent-pop")).toBe(true);
    expect(container.querySelector('[data-id="history"]')!.className).toBe("bubble");
    act(() => { sent().dispatchEvent(new Event("animationend")); });
    expect(sent().className).toBe("bubble");
    // Remounts (scrolling, virtualization) do not replay it.
    act(() => root.render(tree(registry, false)));
    act(() => root.render(tree(registry, true)));
    expect(sent().className).toBe("bubble");
  });

  it("lets the replacement pop when React replaces the bubble before it was seen", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this === container ? rect(0, 500) : rect(600, 640);
    });
    const registry = createSentPopRegistry();
    registry.record("sent");
    act(() => root.render(tree(registry)));
    act(() => root.render(tree(registry, false)));
    flush();
    act(() => root.render(tree(registry, true)));
    expect(sent().classList.contains("ocv-sent-wait")).toBe(true);
  });

  it("does nothing without an Orbit registry", () => {
    act(() => root.render(tree(null)));
    expect(sent().className).toBe("bubble");
  });
});
