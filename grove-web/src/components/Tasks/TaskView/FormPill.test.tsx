import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormPill } from "./FormPill";
import { OrbitConversationContext } from "./conversation/OrbitConversationContext";
import type { AskFormDefinition } from "./formPillTypes";

const form: AskFormDefinition = {
  title: "Plan",
  questions: [
    { id: "a", title: "First", type: "text" },
    { id: "b", title: "Second", type: "text" },
  ],
};

describe("FormPill", () => {
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
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === name);

  for (const orbit of [true, false]) {
    it(`offers Submit only on the last question (${orbit ? "Orbit" : "Workbench"})`, () => {
      const onSubmit = vi.fn();
      act(() => root.render(
        <OrbitConversationContext.Provider value={orbit}>
          <FormPill definition={form} onSubmit={onSubmit} onDismiss={() => {}} />
        </OrbitConversationContext.Provider>,
      ));
      expect(button("Submit")).toBeUndefined();
      act(() => button("Next")!.click());
      act(() => button("Submit")!.click());
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
  }
});
