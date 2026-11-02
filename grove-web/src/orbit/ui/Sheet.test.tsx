import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "./Sheet";

vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));

describe("Sheet", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (open: boolean) => act(() => root.render(
    <Sheet open={open} onClose={() => {}} title="Settings" label="Memory settings"><p>body</p></Sheet>,
  ));

  it("portals a labelled dialog over the window", () => {
    render(true);
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-label")).toBe("Memory settings");
    expect(document.body.querySelector(".oui-sheet-root")?.classList.contains("is-leaving")).toBe(false);
  });

  it("stops catching clicks as soon as it starts closing", () => {
    render(true);
    render(false);
    // Either the exit animation is still running (and the layer lets clicks
    // through to the page) or it has already gone.
    const layer = document.body.querySelector(".oui-sheet-root");
    expect(layer === null || layer.classList.contains("is-leaving")).toBe(true);
  });
});
