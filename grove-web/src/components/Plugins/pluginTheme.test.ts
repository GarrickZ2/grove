import { describe, expect, it, vi } from "vitest";
import { buildPluginThemePayload, ORBIT_TOKEN_NAMES, readOrbitTokens } from "./pluginTheme";

const theme = {
  id: "dark-plus",
  isLight: false,
  colors: {
    bg: "#111", bgSecondary: "#181818", bgTertiary: "#222", border: "#333",
    text: "#eee", textMuted: "#999", highlight: "#7c3aed", accent: "#22d3ee",
    success: "#22c55e", warning: "#f59e0b", error: "#ef4444", info: "#3b82f6",
  },
};

describe("plugin theme payload", () => {
  it("keeps the original fields and adds the interface and tokens", () => {
    const payload = buildPluginThemePayload(theme, true, { "--o-bg": "#111" });
    expect(payload).toEqual({ id: "dark-plus", isLight: false, colors: theme.colors, interface: "orbit", tokens: { "--o-bg": "#111" } });
    expect(buildPluginThemePayload(theme, false, {}).interface).toBe("workbench");
  });

  it("reads every Orbit token by its CSS name and drops empty values", () => {
    const tokens = readOrbitTokens((name) => (name === "--o-track" ? "  " : `value(${name}) `));
    expect(Object.keys(tokens)).toEqual(ORBIT_TOKEN_NAMES.filter((name) => name !== "--o-track"));
    expect(tokens["--o-bg"]).toBe("value(--o-bg)");
    for (const name of ["--o-hover", "--o-selected", "--o-border", "--o-radius", "--o-shadow-1", "--o-font-sans", "--o-font-mono"]) {
      expect(tokens).toHaveProperty(name);
    }
  });

  it("resolves tokens from the live document through a hidden .orbit-ui probe", () => {
    const real = window.getComputedStyle.bind(window);
    const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
      if ((element as HTMLElement).dataset?.grovePluginTokenProbe !== undefined) {
        return { getPropertyValue: (name: string) => ({ "--o-bg": " #123456", "--o-font-sans": "Inter, sans-serif" })[name] ?? "" } as CSSStyleDeclaration;
      }
      return real(element);
    });
    try {
      expect(readOrbitTokens()).toEqual({ "--o-bg": "#123456", "--o-font-sans": "Inter, sans-serif" });
      const probe = document.querySelector<HTMLElement>("[data-grove-plugin-token-probe]");
      expect(probe?.classList.contains("orbit-ui")).toBe(true);
      expect(probe?.hidden).toBe(true);
      readOrbitTokens();
      expect(document.querySelectorAll("[data-grove-plugin-token-probe]")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
