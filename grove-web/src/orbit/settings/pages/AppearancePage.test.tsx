import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePage } from "./AppearancePage";

const colors = (bg: string) => ({
  bg, bgSecondary: bg, bgTertiary: bg, border: "#ccc", text: "#111", textMuted: "#777",
  highlight: "#0a0", accent: "#0aa", success: "#0a0", warning: "#fa0", error: "#f00", info: "#00f",
});
const themes = [
  { id: "light", name: "Light", isLight: true, accentPalette: [], colors: colors("#fff") },
  { id: "paper", name: "Paper", isLight: true, accentPalette: [], colors: colors("#fdf6e3") },
  { id: "dark", name: "Dark", isLight: false, accentPalette: [], colors: colors("#000") },
  { id: "custom-1", name: "Mine", isLight: false, isCustom: true, accentPalette: [], colors: colors("#123") },
];
const themeSettings = {
  handleModeChange: vi.fn(),
  handleLightThemeChange: vi.fn(),
  handleDarkThemeChange: vi.fn(),
  handleSaveCustomTheme: vi.fn(),
  handleImportFile: vi.fn(),
  handleExportTheme: vi.fn(),
  importThemeFile: vi.fn(),
  deleteCustomTheme: vi.fn(),
};

vi.mock("../../../context", () => ({
  useTheme: () => ({ mode: "light", lightThemeId: "light", darkThemeId: "dark", themes }),
}));
vi.mock("../../../components/Config/useThemeSettings", () => ({ useThemeSettings: () => themeSettings }));
vi.mock("../../../components/Config/useAppIconSelection", () => ({
  useAppIconSelection: () => ({ appIcon: "classic", isLight: true, saving: false, error: null, select: vi.fn() }),
}));
vi.mock("../../../components/Config/CustomThemeDialog", () => ({ CustomThemeDialog: () => <div>custom theme dialog</div> }));

describe("Orbit AppearancePage", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onPreviewTheme = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<AppearancePage onPreviewTheme={onPreviewTheme} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  const card = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name} theme"]`)!;
  const hover = (element: Element, type: "mouseover" | "mouseout") =>
    act(() => { element.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: type === "mouseout" ? document.body : null })); });

  it("previews a theme the pointer rests on and reverts when it leaves the grid", () => {
    vi.useFakeTimers();
    try {
      hover(card("Paper"), "mouseover");
      expect(onPreviewTheme).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(400); });
      expect(onPreviewTheme).toHaveBeenLastCalledWith(expect.objectContaining({ id: "paper" }));
      hover(card("Paper").closest(".ost-themes")!, "mouseout");
      expect(onPreviewTheme).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not preview cards the pointer only sweeps across", () => {
    vi.useFakeTimers();
    try {
      hover(card("Light"), "mouseover");
      act(() => { vi.advanceTimersByTime(100); });
      hover(card("Light"), "mouseout");
      hover(card("Paper"), "mouseover");
      act(() => { vi.advanceTimersByTime(100); });
      hover(card("Paper").closest(".ost-themes")!, "mouseout");
      act(() => { vi.advanceTimersByTime(1000); });
      expect(onPreviewTheme).not.toHaveBeenCalledWith(expect.objectContaining({ id: "light" }));
      expect(onPreviewTheme).not.toHaveBeenCalledWith(expect.objectContaining({ id: "paper" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("selecting a card saves it to its family and drops the preview", () => {
    hover(card("Dark"), "mouseover");
    act(() => card("Dark").click());
    expect(themeSettings.handleDarkThemeChange).toHaveBeenCalledWith("dark");
    expect(onPreviewTheme).toHaveBeenLastCalledWith(null);
    act(() => card("Paper").click());
    expect(themeSettings.handleLightThemeChange).toHaveBeenCalledWith("paper");
  });

  it("marks the chosen light and dark themes", () => {
    expect(card("Light").getAttribute("aria-pressed")).toBe("true");
    expect(card("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(card("Paper").getAttribute("aria-pressed")).toBe("false");
  });

  it("offers export and delete only on custom themes", () => {
    expect(container.querySelector('[aria-label="Delete Light"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Delete Mine"]')!.click());
    expect(themeSettings.deleteCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ id: "custom-1" }));
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Export Mine"]')!.click());
    expect(themeSettings.handleExportTheme).toHaveBeenCalledWith(expect.objectContaining({ id: "custom-1" }));
  });

  it("clears any preview when the page unmounts", () => {
    onPreviewTheme.mockClear();
    act(() => root.render(<div />));
    expect(onPreviewTheme).toHaveBeenCalledWith(null);
  });
});
