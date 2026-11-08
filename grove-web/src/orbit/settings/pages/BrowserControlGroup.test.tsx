import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserControlGroup } from "./BrowserControlGroup";
import type { SettingsPageProps } from "./types";

vi.mock("../../../components/Dialogs/ConfirmDialog", () => ({
  ConfirmDialog: ({ confirmLabel, onConfirm, onCancel }: {
    confirmLabel: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) => (
    <div role="dialog">
      <button data-action="confirm" onClick={onConfirm}>{confirmLabel}</button>
      <button data-action="cancel" onClick={onCancel}>Cancel</button>
    </div>
  ),
}));

describe("sensitive tools setting", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  function renderGroup(overrides: Record<string, unknown> = {}) {
    const setBrowserSensitiveTools = vi.fn();
    const settings = {
      browserControlEnabled: true,
      browserPersonalAllowed: true,
      browserSensitiveTools: false,
      setBrowserSensitiveTools,
      extensionStatusColor: "success",
      ...overrides,
    } as unknown as SettingsPageProps["settings"];
    act(() => root.render(<BrowserControlGroup settings={settings} />));
    return setBrowserSensitiveTools;
  }

  const toggle = () => host.querySelector<HTMLButtonElement>('[aria-label="Sensitive tools in your browser"]') as HTMLButtonElement;
  const click = (element: Element) => act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  const dialogAction = (action: string) => host.querySelector(`[data-action="${action}"]`)!;

  it("stays off until the warning is confirmed", () => {
    const set = renderGroup();
    click(toggle());
    expect(set).not.toHaveBeenCalled();

    click(dialogAction("confirm"));
    expect(set).toHaveBeenCalledWith(true);
  });

  it("stays off when the warning is cancelled", () => {
    const set = renderGroup();
    click(toggle());
    click(dialogAction("cancel"));
    expect(set).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("turns off without asking", () => {
    const set = renderGroup({ browserSensitiveTools: true });
    click(toggle());
    expect(set).toHaveBeenCalledWith(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("is out of the way when agents only use the test browser", () => {
    renderGroup({ browserPersonalAllowed: false });
    expect(toggle()).toBeNull();
  });
});
