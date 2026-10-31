import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InterfaceChoiceDialog } from "./InterfaceChoiceDialog";
import { patchConfig } from "../../api";
const state = vi.hoisted(() => ({ config: { web: { interface: undefined as string | undefined } }, refresh: vi.fn() }));
vi.mock("../../context", () => ({ useConfig: () => state }));
vi.mock("../../api", () => ({ patchConfig: vi.fn().mockResolvedValue({}) }));
vi.mock("../ui/DialogShell", () => ({ DialogShell: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) => isOpen ? <div>{children}</div> : null }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); state.config.web.interface = undefined; host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("offers only Orbit and Workbench and saves the selected interface", async () => {
  act(() => root.render(<InterfaceChoiceDialog />));
  const choices = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(choices).toHaveLength(2);
  expect(choices[0].textContent).toContain("Orbit");
  expect(choices[1].textContent).toContain("Workbench");
  expect(host.textContent).not.toContain("Buddy");
  act(() => choices[1].click());
  expect(choices[1].getAttribute("aria-checked")).toBe("true");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "Continue with Workbench")!.click());
  expect(patchConfig).toHaveBeenCalledWith({ web: { interface: "workbench" } });
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("does not reopen for a saved interface", () => {
  for (const choice of ["orbit", "workbench"]) {
    state.config.web.interface = choice;
    act(() => root.render(<InterfaceChoiceDialog />));
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  }
});
