import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RenameTaskDialog } from "../../components/Tasks/dialogs/RenameTaskDialog";
import { RebaseDialog } from "../../components/Tasks/dialogs/RebaseDialog";
import { AddAgentDialog } from "../../components/Skills/AddAgentDialog";
import { OrbitInterfaceContext } from "./interfaceContext";

vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: false }) }));
const addAgent = vi.fn(async () => {});
vi.mock("../../api", () => ({ addAgent: (...args: unknown[]) => addAgent(...(args as [])), updateAgent: vi.fn() }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  addAgent.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode, orbit: boolean) => act(() => root.render(
  <OrbitInterfaceContext.Provider value={orbit}>{node}</OrbitInterfaceContext.Provider>,
));
const button = (text: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("RenameTaskDialog", () => {
  it.each([false, true])("renames through the same handler (orbit=%s)", (orbit) => {
    const onRename = vi.fn();
    render(<RenameTaskDialog isOpen taskName="Old" onClose={() => {}} onRename={onRename} />, orbit);
    expect(!!document.body.querySelector(".oui-dlg")).toBe(orbit);
    const input = document.body.querySelector<HTMLInputElement>('input[placeholder="Enter new task name"]')!;
    type(input, "New name");
    act(() => button("Rename")!.click());
    expect(onRename).toHaveBeenCalledWith("New name");
  });
});

describe("RebaseDialog", () => {
  it("picks a branch from the Orbit list and submits the shared form", () => {
    const onRebase = vi.fn();
    const onClose = vi.fn();
    render(<RebaseDialog isOpen taskName="Task" currentTarget="main" availableBranches={["main", "dev", "release"]} onClose={onClose} onRebase={onRebase} />, true);
    const options = [...document.body.querySelectorAll<HTMLButtonElement>(".oui-dlg-choice")];
    expect(options.map((o) => o.textContent)).toEqual(["maincurrent", "dev", "release"]);
    expect(options[0].disabled).toBe(true);
    const submit = button("Change target")!;
    expect(submit.disabled).toBe(true);
    act(() => options[1].click());
    expect(document.body.querySelector(".oui-dlg-flow")?.textContent).toContain("dev");
    act(() => submit.click());
    expect(onRebase).toHaveBeenCalledWith("dev");
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the Workbench list outside Orbit", () => {
    render(<RebaseDialog isOpen currentTarget="main" availableBranches={["main", "dev"]} onClose={() => {}} onRebase={() => {}} />, false);
    expect(document.body.querySelector(".oui-dlg")).toBeNull();
    expect(button("Change Target")).toBeDefined();
  });
});

describe("AddAgentDialog", () => {
  it("validates and saves through the shared submit in Orbit", async () => {
    const onSaved = vi.fn();
    render(<AddAgentDialog isOpen editingAgent={null} onClose={() => {}} onSaved={onSaved} />, true);
    expect(document.body.querySelector(".oui-dlg h2")?.textContent).toBe("Add custom agent");
    await act(async () => button("Add agent")!.click());
    expect(document.body.querySelector(".oui-dlg-error")?.textContent).toBe("Name is required");
    type(document.body.querySelector<HTMLInputElement>('input[placeholder="e.g., My Agent"]')!, "Scout");
    // Typing a name derives both skill directories, as in Workbench.
    expect(document.body.querySelector<HTMLInputElement>('input[placeholder="~/.my-agent/skills"]')!.value).toBe("~/.scout/skills");
    await act(async () => button("Add agent")!.click());
    expect(addAgent).toHaveBeenCalledWith({ display_name: "Scout", global_skills_dir: "~/.scout/skills", project_skills_dir: ".scout/skills" });
    expect(onSaved).toHaveBeenCalled();
  });
});
