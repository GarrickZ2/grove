import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogShell } from "../../components/ui/DialogShell";
import { ConfirmDialog } from "../../components/Dialogs/ConfirmDialog";
import { TaskCommandPalette } from "../../components/ui/TaskCommandPalette";
import type { Task } from "../../data/types";
import { OrbitInterfaceContext } from "./interfaceContext";

vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));
vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: false }) }));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode, orbit: boolean) => act(() => root.render(
  <OrbitInterfaceContext.Provider value={orbit}>{node}</OrbitInterfaceContext.Provider>,
));
const buttonByText = (text: string) =>
  [...document.body.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);

describe("DialogShell", () => {
  it("keeps the Workbench markup outside Orbit", () => {
    render(<DialogShell isOpen onClose={() => {}} variant="centered"><p>body</p></DialogShell>, false);
    expect(document.body.querySelector(".oui-dlg-root")).toBeNull();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.className).toContain("max-w-md");
    expect(dialog?.textContent).toBe("body");
  });

  it("renders the Orbit layer under the Orbit interface", () => {
    const onClose = vi.fn();
    render(<DialogShell isOpen onClose={onClose} variant="centered" maxWidth="max-w-lg"><p>body</p></DialogShell>, true);
    const layer = document.body.querySelector(".oui-dlg-root");
    expect(layer?.classList.contains("orbit-ui")).toBe(true);
    const frame = layer?.querySelector('[role="dialog"]');
    expect(frame?.className).toContain("oui-dlg-frame");
    expect(frame?.className).toContain("max-w-lg");
    act(() => (layer?.querySelector(".oui-dlg-scrim") as HTMLElement).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  const confirm = (orbit: boolean, props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog isOpen title="Delete task" message="Gone for good." confirmLabel="Delete" onConfirm={onConfirm} onCancel={() => {}} {...props} />,
      orbit,
    );
    return onConfirm;
  };

  it("confirms on a plain click in Workbench", () => {
    const onConfirm = confirm(false);
    expect(document.body.querySelector(".oui-dlg")).toBeNull();
    act(() => buttonByText("Delete")?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("asks for a press-and-hold on destructive confirms in Orbit", () => {
    vi.useFakeTimers();
    const onConfirm = confirm(true);
    const hold = buttonByText("Hold to delete")!;
    expect(hold.classList.contains("oui-btn-hold")).toBe(true);
    // A stray pointer click does nothing.
    act(() => hold.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    expect(onConfirm).not.toHaveBeenCalled();
    // Releasing early cancels. (jsdom has no PointerEvent; React reads the type.)
    act(() => hold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    act(() => vi.advanceTimersByTime(400));
    act(() => hold.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    act(() => vi.advanceTimersByTime(1000));
    expect(onConfirm).not.toHaveBeenCalled();
    // A full hold confirms.
    act(() => hold.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    act(() => vi.advanceTimersByTime(950));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("sets Cancel apart from a dialog's two ways forward in Orbit", () => {
    render(
      <ConfirmDialog isOpen title="Delete session" message="Where from?" confirmLabel="Delete from Agent" secondaryActionLabel="Remove from Grove" onSecondaryAction={() => {}} onConfirm={() => {}} onCancel={() => {}} />,
      true,
    );
    const labels = [...document.body.querySelectorAll(".oui-dlg-foot button")].map((button) => button.textContent);
    expect(labels).toEqual(["Cancel", "Remove from Grove", "Hold to delete from Agent"]);
  });

  it("confirms at once from the keyboard in Orbit", () => {
    const onConfirm = confirm(true);
    act(() => buttonByText("Hold to delete")!.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("keeps a plain confirm for non-destructive labels in Orbit", () => {
    const onConfirm = confirm(true, { confirmLabel: "OK", variant: "warning" });
    expect(document.body.querySelector(".oui-btn-hold")).toBeNull();
    act(() => buttonByText("OK")?.click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("TaskCommandPalette", () => {
  const tasks = [
    { id: "a", name: "Alpha", branch: "feat/alpha", status: "live" },
    { id: "b", name: "Beta", branch: "feat/beta", status: "idle" },
  ] as unknown as Task[];

  it("renders the Workbench palette outside Orbit", () => {
    render(<TaskCommandPalette isOpen onClose={() => {}} tasks={tasks} selectedTask={null} onTaskSelect={() => {}} />, false);
    expect(document.body.querySelector(".oui-pal")).toBeNull();
    expect(document.body.querySelectorAll("[data-palette-item]").length).toBe(2);
  });

  it("renders the Orbit palette with the same rows and selection", () => {
    const onTaskSelect = vi.fn();
    const onClose = vi.fn();
    render(<TaskCommandPalette isOpen onClose={onClose} tasks={tasks} selectedTask={tasks[1]} onTaskSelect={onTaskSelect} />, true);
    const palette = document.body.querySelector(".oui-pal");
    expect(palette?.getAttribute("aria-label")).toBe("Switch task");
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>(".oui-pal-item[data-palette-item]")];
    expect(rows.map((row) => row.querySelector(".oui-truncate")?.textContent)).toEqual(["Alpha", "Beta"]);
    expect(rows[1].textContent).toContain("Current");
    act(() => rows[1].click());
    expect(onTaskSelect).toHaveBeenCalledWith(tasks[1]);
    expect(onClose).toHaveBeenCalled();
  });
});
