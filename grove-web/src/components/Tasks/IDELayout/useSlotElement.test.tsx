import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSlotElement } from "./useSlotElement";

function Probe({ id }: { id: string }) {
  const el = useSlotElement(id);
  return <i>{el ? el.id : "none"}</i>;
}

describe("useSlotElement", () => {
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
    document.getElementById("late-slot")?.remove();
    vi.unstubAllGlobals();
  });

  it("finds a slot the shell renders after the consumer mounted", async () => {
    await act(async () => { root.render(<Probe id="late-slot" />); });
    expect(container.textContent).toBe("none");
    const slot = document.createElement("div");
    slot.id = "late-slot";
    await act(async () => {
      document.body.appendChild(slot);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent).toBe("late-slot");
  });
});
