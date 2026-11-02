import { act, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Info } from "lucide-react";
import { PanelShell, PanelHeaderActions, PanelHeaderContext, PanelError } from "./PanelShell";
import { PANEL_HUES, useInPanelShell, usePanelMenuItems } from "./panelSlots";

vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: vi.fn() }));

describe("PanelShell", () => {
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
    vi.restoreAllMocks();
  });

  const head = () => container.querySelector(".oui-panel-head") as HTMLElement;

  it("renders the glyph tile, title, default context and close", () => {
    const onClose = vi.fn();
    act(() => root.render(
      <PanelShell glyph={Info} hue={PANEL_HUES.stone} title="Info" context="This task at a glance" onClose={onClose}>
        <p>body</p>
      </PanelShell>,
    ));
    expect(head().querySelector(".oui-panel-tile")).not.toBeNull();
    expect(head().textContent).toContain("Info");
    expect(head().textContent).toContain("This task at a glance");
    act(() => (container.querySelector('[aria-label="Close panel"]') as HTMLButtonElement).click());
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.querySelector(".oui-panel-body.is-scroll")?.textContent).toBe("body");
  });

  it("lets the body contribute context, header actions and menu rows", () => {
    const onBodyRow = vi.fn();
    const onHostRow = vi.fn();
    function Body() {
      const items = useMemo(() => [{ id: "refresh", label: "Refresh", onSelect: onBodyRow }], []);
      usePanelMenuItems(items);
      return (
        <>
          <PanelHeaderContext>3 agents</PanelHeaderContext>
          <PanelHeaderActions><button type="button">Commit</button></PanelHeaderActions>
          <span>{useInPanelShell() ? "inside" : "outside"}</span>
        </>
      );
    }
    act(() => root.render(
      <PanelShell glyph={Info} hue={PANEL_HUES.green} title="Graph" context="default" menu={[{ id: "host", label: "Reset width", onSelect: onHostRow }]}>
        <Body />
      </PanelShell>,
    ));
    expect(container.querySelector(".oui-panel-ctx-slot")?.textContent).toBe("3 agents");
    expect(container.querySelector(".oui-panel-actions")?.textContent).toBe("Commit");
    expect(container.querySelector(".oui-panel-body")?.textContent).toBe("inside");

    act(() => (container.querySelector('[aria-label="Panel actions"]') as HTMLButtonElement).click());
    const rows = [...container.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(rows).toEqual(["Refresh", "Reset width"]);
    act(() => (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click());
    expect(onBodyRow).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("slot helpers are no-ops outside a shell", () => {
    function Loose() {
      usePanelMenuItems(useMemo(() => [], []));
      return <><PanelHeaderActions><b>x</b></PanelHeaderActions><i>{String(useInPanelShell())}</i></>;
    }
    act(() => root.render(<Loose />));
    expect(container.textContent).toBe("false");
  });

  it("catches a crashing body and remounts it on Try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let crash = true;
    function Fragile() {
      if (crash) throw new Error("worktree missing");
      return <span>recovered</span>;
    }
    act(() => root.render(
      <PanelShell glyph={Info} hue={PANEL_HUES.orange} title="Git"><Fragile /></PanelShell>,
    ));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("worktree missing");
    crash = false;
    const retry = [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    act(() => retry.click());
    expect(container.textContent).toContain("recovered");
  });

  it("PanelError shows the cause and the retry spins while retrying", () => {
    act(() => root.render(<PanelError title="Couldn't load" onRetry={() => {}} retrying>Network is down.</PanelError>));
    const button = container.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.querySelector(".oui-spin")).not.toBeNull();
    expect(container.textContent).toContain("Network is down.");
  });
});
