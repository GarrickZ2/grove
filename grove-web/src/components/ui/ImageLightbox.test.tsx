import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "../../keyboard/CommandRegistry";
import { keyboardManager } from "../../keyboard/KeyboardManager";
import { userKeymapStore } from "../../keyboard/userKeymapStore";
import { ImageLightbox } from "./ImageLightbox";

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
