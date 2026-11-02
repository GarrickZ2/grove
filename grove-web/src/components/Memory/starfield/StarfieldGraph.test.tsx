import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twoCliques } from "./fixtures";
import { StarfieldGraph } from "./StarfieldGraph";

const escape = vi.hoisted(() => ({ active: false, handler: () => {} }));
vi.mock("../../../keyboard/useEscapeScope", () => ({
  useEscapeScope: (active: boolean, handler: () => void) => { escape.active = active; escape.handler = handler; },
}));

describe("StarfieldGraph", () => {
  let container: HTMLDivElement;
  let root: Root;
  const data = twoCliques();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (props: Partial<Parameters<typeof StarfieldGraph>[0]> = {}) => act(() => root.render(
    <StarfieldGraph entities={data.entities} relations={data.relations} onOpen={() => {}} look="light" {...props} />,
  ));

  it("renders the inline card in the app theme with test hooks", () => {
    render({ look: "dark" });
    const el = container.querySelector<HTMLElement>(".osf")!;
    expect(el.classList.contains("is-dark")).toBe(true);
    expect(el.dataset.memoryLook).toBe("dark");
    expect(el.dataset.memoryPhase).toBe("card");
    expect(el.dataset.memoryConstellations).toBe("2");
    expect(el.dataset.memoryNodeRadii?.split(",")).toHaveLength(data.entities.length);
    expect(el.querySelector("canvas[role=img]")?.getAttribute("aria-label")).toContain(`${data.entities.length} memories`);
  });

  it("toggles motion from the pause button", () => {
    render();
    const pause = container.querySelector<HTMLButtonElement>('button[aria-label="Pause motion"]')!;
    act(() => pause.click());
    expect(container.querySelector('button[aria-label="Resume motion"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  it("expand opens the full-window night sky in a portal; Esc closes it", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    render();
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Expand mind map"]')!.click());
    expect(container.querySelector<HTMLElement>(".osf")!.dataset.memoryPhase).toBe("expanding");
    const dialog = document.body.querySelector('[role="dialog"][aria-label="Memory night sky"]');
    expect(dialog).not.toBeNull();
    // Run the 600ms transition on faked animation frames.
    act(() => { vi.advanceTimersByTime(900); });
    expect(container.querySelector<HTMLElement>(".osf")!.dataset.memoryPhase).toBe("expanded");
    expect(escape.active).toBe(true);
    act(() => escape.handler());
    act(() => { vi.advanceTimersByTime(900); });
    expect(container.querySelector<HTMLElement>(".osf")!.dataset.memoryPhase).toBe("card");
    expect(document.body.querySelector('[aria-label="Memory night sky"][role="dialog"]')).toBeNull();
  });
});
