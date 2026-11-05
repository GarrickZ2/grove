import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "../../keyboard/CommandRegistry";
import { keyboardManager } from "../../keyboard/KeyboardManager";
import { userKeymapStore } from "../../keyboard/userKeymapStore";
import { ImageLightbox } from "./ImageLightbox";
import { wheelZoomFactor } from "./wheelZoom";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("ImageLightbox Escape isolation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let closeWorkspace: ReturnType<typeof vi.fn>;
  let disposeWorkspace: () => void;

  beforeEach(() => {
    userKeymapStore.reset();
    keyboardManager._resetScopes();
    closeWorkspace = vi.fn();
    disposeWorkspace = commandRegistry.contribute({
      id: "workspace.close",
      name: "Close workspace",
      category: "Navigation",
      scope: "workspace",
      defaultBindings: [{ key: "Escape" }],
    }, closeWorkspace);
    keyboardManager.pushScope("workspace");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    keyboardManager._resetScopes();
    disposeWorkspace();
  });

  function escape() {
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape", bubbles: true, cancelable: true,
      }));
    });
  }

  it("closes the open image rather than a later mounted closed preview", () => {
    const closeImage = vi.fn();
    const closeHidden = vi.fn();
    act(() => root.render(<>
      <ImageLightbox imageUrl="/image.png" onClose={closeImage} />
      <ImageLightbox onClose={closeHidden} />
    </>));

    escape();

    expect(closeImage).toHaveBeenCalledOnce();
    expect(closeHidden).not.toHaveBeenCalled();
    expect(closeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps Escape in the open preview when another preview unmounts", () => {
    const closeImage = vi.fn();
    const closeHidden = vi.fn();
    act(() => root.render(<>
      <ImageLightbox key="open" imageUrl="/image.png" onClose={closeImage} />
      <ImageLightbox key="hidden" onClose={closeHidden} />
    </>));
    act(() => root.render(<>
      <ImageLightbox key="open" imageUrl="/image.png" onClose={closeImage} />
    </>));

    escape();

    expect(closeImage).toHaveBeenCalledOnce();
    expect(closeWorkspace).not.toHaveBeenCalled();
  });

  it("returns Escape to the underlying preview and then the workspace", () => {
    const closeImage = vi.fn();
    const closeSvg = vi.fn();
    act(() => root.render(<>
      <ImageLightbox key="image" imageUrl="/image.png" onClose={closeImage} />
      <ImageLightbox key="svg" svgContent="<svg />" onClose={closeSvg} />
    </>));
    escape();
    expect(closeSvg).toHaveBeenCalledOnce();
    expect(closeImage).not.toHaveBeenCalled();
    expect(closeWorkspace).not.toHaveBeenCalled();

    act(() => root.render(<>
      <ImageLightbox key="image" imageUrl="/image.png" onClose={closeImage} />
    </>));
    escape();
    expect(closeImage).toHaveBeenCalledOnce();
    expect(closeWorkspace).not.toHaveBeenCalled();

    act(() => root.render(<ImageLightbox onClose={closeImage} />));
    escape();
    expect(closeWorkspace).toHaveBeenCalledOnce();
  });
});

describe("ImageLightbox trackpad gestures", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<ImageLightbox imageUrl="/image.png" onClose={() => {}} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const lightbox = () => document.querySelector('[data-lightbox-active="true"]') as HTMLElement;
  const content = () => lightbox().querySelector("div") as HTMLElement;
  const wheel = (init: WheelEventInit) => act(() => {
    lightbox().dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }));
  });

  it("scales a pinch with its delta instead of leaping per event", () => {
    expect(wheelZoomFactor(-1, true)).toBeCloseTo(1.01);
    expect(wheelZoomFactor(1, true)).toBeCloseTo(0.99);
    expect(wheelZoomFactor(-100, false)).toBeCloseTo(Math.exp(0.15));
    expect(wheelZoomFactor(-500, true)).toBeCloseTo(Math.exp(0.15));
  });

  it("follows wheel input without a transition, and eases only on reset", () => {
    wheel({ deltaY: -100, metaKey: true });
    wheel({ deltaY: -100, metaKey: true });
    wheel({ deltaX: 12, deltaY: 30 });
    expect(content().style.transition).toBe("none");
    expect(content().style.transform).toContain("translate(-12px, -30px)");

    act(() => (document.querySelector("button.left-4") as HTMLButtonElement).click());
    expect(content().style.transition).toContain("transform");

    wheel({ deltaY: -3, ctrlKey: true });
    expect(content().style.transition).toBe("none");
  });
});
