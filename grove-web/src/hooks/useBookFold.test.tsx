import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onFoldChange, readBookFold, readLaptopFold, useBookFold, type BookFold } from "./useBookFold";

const rect = (x: number, y: number, width: number, height: number) => new DOMRect(x, y, width, height);
const book = [rect(0, 0, 330, 900), rect(339, 0, 330, 900)];
const laptop = [rect(0, 0, 951, 300), rect(0, 310, 951, 300)];

function setFold(segments: DOMRect[] | null, posture?: string) {
  Object.defineProperty(window, "viewport", { configurable: true, value: { segments } });
  Object.defineProperty(navigator, "devicePosture", {
    configurable: true,
    value: posture ? Object.assign(new EventTarget(), { type: posture }) : undefined,
  });
}

describe("useBookFold", () => {
  afterEach(() => {
    delete (window as { viewport?: unknown }).viewport;
    delete (navigator as { devicePosture?: unknown }).devicePosture;
  });

  it("reads as not folded where the APIs are missing", () => {
    expect(readBookFold()).toBeNull();
  });

  it("finds the crease of a book pose", () => {
    setFold(book, "folded");
    expect(readBookFold()).toEqual({ left: 330, gap: 9 });
  });

  it("works from segments alone where there is no posture API", () => {
    setFold(book);
    expect(readBookFold()).toEqual({ left: 330, gap: 9 });
  });

  it("ignores a flat phone, one segment and the laptop pose", () => {
    setFold(book, "continuous");
    expect(readBookFold()).toBeNull();
    setFold([rect(0, 0, 669, 900)], "folded");
    expect(readBookFold()).toBeNull();
    setFold(laptop, "folded");
    expect(readBookFold()).toBeNull();
  });

  it("tells the laptop pose from the book pose", () => {
    setFold(laptop, "folded");
    expect(readLaptopFold()).toEqual({ top: 300, gap: 10 });
    expect(readBookFold()).toBeNull();
    setFold(book, "folded");
    expect(readLaptopFold()).toBeNull();
    setFold(laptop, "continuous");
    expect(readLaptopFold()).toBeNull();
  });

  it("catches segments that arrive after the posture change, without an event", () => {
    vi.useFakeTimers();
    const posture = Object.assign(new EventTarget(), { type: "continuous" });
    Object.defineProperty(navigator, "devicePosture", { configurable: true, value: posture });
    Object.defineProperty(window, "viewport", { configurable: true, value: { segments: [rect(0, 0, 867, 669)] } });
    const seen = vi.fn();
    const stop = onFoldChange(() => seen(readBookFold()));

    posture.type = "folded";
    posture.dispatchEvent(new Event("change"));
    expect(seen).toHaveBeenLastCalledWith(null);

    // As on the device: the crease sits at 476 with a narrower right screen, and no gap.
    Object.defineProperty(window, "viewport", { configurable: true, value: { segments: [rect(0, 0, 476, 669), rect(476, 0, 391, 669)] } });
    vi.advanceTimersByTime(3000);
    expect(seen).toHaveBeenLastCalledWith({ left: 476, gap: 0 });

    stop();
    seen.mockClear();
    vi.advanceTimersByTime(3000);
    expect(seen).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("follows the phone as it folds and flattens", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let current: BookFold | null = null;
    function Harness() {
      current = useBookFold();
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const resize = () => act(() => { window.dispatchEvent(new Event("resize")); });

    setFold(null, "continuous");
    act(() => root.render(<Harness />));
    expect(current).toBeNull();

    setFold(book, "folded");
    resize();
    expect(current).toEqual({ left: 330, gap: 9 });

    setFold(null, "continuous");
    resize();
    expect(current).toBeNull();

    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
});
