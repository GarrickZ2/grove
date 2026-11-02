import { afterEach, describe, expect, it, vi } from "vitest";
import { playComposerSendOut } from "./sendOut";

function editor(text: string) {
  const box = document.createElement("div");
  const el = document.createElement("div");
  el.id = "editor";
  el.contentEditable = "true";
  el.innerHTML = text;
  box.appendChild(el);
  document.body.appendChild(box);
  return el;
}

describe("composer send-out", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("lays an inert copy of the text over the editor and removes it after the animation", () => {
    vi.useFakeTimers();
    const el = editor("Ship <b>it</b>");
    playComposerSendOut(el);
    el.innerHTML = ""; // the send clears the real editor right away
    const ghost = document.querySelector<HTMLElement>(".oc-send-out")!;
    expect(ghost.textContent).toBe("Ship it");
    expect(ghost.getAttribute("contenteditable")).toBe("false");
    expect(ghost.getAttribute("aria-hidden")).toBe("true");
    expect(ghost.id).toBe("");
    expect(el.textContent).toBe("");
    ghost.dispatchEvent(new Event("animationend"));
    expect(document.querySelector(".oc-send-out")).toBeNull();
    // A copy whose animation never ran (hidden tab) still goes away.
    playComposerSendOut(editor("Again"));
    vi.advanceTimersByTime(400);
    expect(document.querySelector(".oc-send-out")).toBeNull();
  });

  it("does nothing for an empty editor or under reduced motion", () => {
    playComposerSendOut(editor("   "));
    expect(document.querySelector(".oc-send-out")).toBeNull();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    playComposerSendOut(editor("Hello"));
    expect(document.querySelector(".oc-send-out")).toBeNull();
  });
});
