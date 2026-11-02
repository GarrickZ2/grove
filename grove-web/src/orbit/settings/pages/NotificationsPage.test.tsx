import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsPage } from "./NotificationsPage";
import type { SettingsState } from "../../../components/Config/useSettingsState";
import { requestBrowserNotificationPermission } from "../../../notifications/desktopNotifier";

vi.mock("../../../context", () => ({ useTheme: () => ({ theme: { isLight: true }, appIcon: "classic" }) }));
vi.mock("../../../components/ui", () => ({ Combobox: ({ value }: { value: string }) => <span data-testid="sound">{value}</span> }));
vi.mock("../../../notifications/desktopNotifier", () => ({
  previewNotificationSound: vi.fn(),
  requestBrowserNotificationPermission: vi.fn(),
}));

function fakeSettings(overrides: Partial<SettingsState> = {}): SettingsState {
  const base = {
    systemNotifEnabled: true, setSystemNotifEnabled: vi.fn(),
    systemNotifShowPermission: false, setSystemNotifShowPermission: vi.fn(),
    systemNotifShowElicitation: true, setSystemNotifShowElicitation: vi.fn(),
    systemNotifShowDone: true, setSystemNotifShowDone: vi.fn(),
    hooksResponseSoundEnabled: true, setHooksResponseSoundEnabled: vi.fn(),
    hooksResponseSound: "Glass", setHooksResponseSound: vi.fn(),
    hooksPermissionSoundEnabled: true, setHooksPermissionSoundEnabled: vi.fn(),
    hooksPermissionSound: "Purr", setHooksPermissionSound: vi.fn(),
    trayEnabled: true, setTrayEnabled: vi.fn(),
    trayShowPermission: true, setTrayShowPermission: vi.fn(),
    trayShowDone: true, setTrayShowDone: vi.fn(),
    trayShowRunning: true, setTrayShowRunning: vi.fn(),
    menubarShortcut: "", setMenubarShortcut: vi.fn(),
    isRecordingMenubarShortcut: false, setIsRecordingMenubarShortcut: vi.fn(),
    menubarShortcutConflict: false,
    trayDoneRetentionMode: "expire", setTrayDoneRetentionMode: vi.fn(),
    trayDoneRetentionValue: 3, setTrayDoneRetentionValue: vi.fn(),
    trayDoneRetentionUnit: "days", setTrayDoneRetentionUnit: vi.fn(),
    isTauriGui: false,
  };
  return { ...base, ...overrides } as unknown as SettingsState;
}

describe("Orbit NotificationsPage", () => {
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
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  const render = (settings: SettingsState) => act(() => root.render(<NotificationsPage settings={settings} />));
  const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const radio = (group: string, label: string) =>
    [...byLabel(group).querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) => item.textContent === label)!;

  it("edits auto-expire retention with clamped values and a unit switch", () => {
    const settings = fakeSettings();
    render(settings);
    const amount = byLabel("Done chat retention amount") as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => { setValue.call(amount, "999"); amount.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(settings.setTrayDoneRetentionValue).toHaveBeenLastCalledWith(365);
    act(() => { setValue.call(amount, "0"); amount.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(settings.setTrayDoneRetentionValue).toHaveBeenLastCalledWith(1);
    act(() => radio("Done chat retention unit", "Hours").click());
    expect(settings.setTrayDoneRetentionUnit).toHaveBeenCalledWith("hours");
    act(() => radio("Done chat retention", "Keep forever").click());
    expect(settings.setTrayDoneRetentionMode).toHaveBeenCalledWith("forever");
  });

  it("hides the amount when retention is forever", () => {
    render(fakeSettings({ trayDoneRetentionMode: "forever" }));
    expect(container.querySelector('[aria-label="Done chat retention amount"]')).toBeNull();
  });

  it("slides in a labelled preview banner when an event is turned on", () => {
    const settings = fakeSettings();
    render(settings);
    expect(container.querySelector(".ost-banner")).toBeNull();
    act(() => byLabel("Notify when permission is required").click());
    expect(settings.setSystemNotifShowPermission).toHaveBeenCalledWith(true);
    expect(container.querySelector(".ost-banner")?.getAttribute("aria-label")).toBe("Preview: Permission required");
    expect(container.textContent).toContain("Nothing is sent");
  });

  it("asks for browser permission when system notifications are enabled", () => {
    const settings = fakeSettings({ systemNotifEnabled: false });
    render(settings);
    expect(container.textContent).toContain("System notifications are off");
    expect(container.querySelector(".ost-desk")).toBeNull();
    act(() => byLabel("System notifications").click());
    expect(settings.setSystemNotifEnabled).toHaveBeenCalledWith(true);
    expect(requestBrowserNotificationPermission).toHaveBeenCalled();
  });

  it("shows sound pickers only for enabled events", () => {
    render(fakeSettings());
    expect([...container.querySelectorAll('[data-testid="sound"]')].map((node) => node.textContent)).toEqual(["Glass"]);
  });
});
