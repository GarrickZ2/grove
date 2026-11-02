import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Runs the panel SDK that Grove vendors into plugins (SCAFFOLD_GROVE_TS in
   src/api/handlers/plugins.rs) against old and new host payloads. */

function scaffold(name: string): string {
  const source = readFileSync("../src/api/handlers/plugins.rs", "utf8");
  const head = `const ${name}: &str = r#"`;
  const start = source.indexOf(head);
  if (start < 0) throw new Error(`${name} not found`);
  const body = start + head.length;
  return source.slice(body, source.indexOf('"#;', body));
}

interface Sdk {
  navigate(target: { to: string; section?: string }): Promise<{ ok: true }>;
  theme: {
    getColors(): Record<string, string> | null;
    isLight(): boolean;
    getInterface(): "orbit" | "workbench";
    getTokens(): Record<string, string>;
    onChange(cb: (theme: { interface: string; tokens: Record<string, string> }) => void): () => void;
  };
}

function loadSdk(): Sdk {
  const js = ts.transpileModule(scaffold("SCAFFOLD_GROVE_TS"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exports: { grove?: Sdk } = {};
  new Function("exports", js)(exports);
  return exports.grove!;
}

const colors = { bg: "#101010", bgSecondary: "#151515", bgTertiary: "#1a1a1a", border: "#2a2a2a", text: "#f5f5f5", textMuted: "#a3a3a3", highlight: "#8b5cf6", accent: "#06b6d4", success: "#22c55e", warning: "#f59e0b", error: "#ef4444", info: "#3b82f6" };

/** A host message, from the parent window (the SDK trusts only that source). */
function push(data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { source: window.parent, data }));
}

describe("panel SDK theme", () => {
  const root = document.documentElement;
  beforeEach(() => {
    vi.useFakeTimers();
    // Requests go to the parent (this window in jsdom); nothing answers them.
    vi.spyOn(window, "postMessage").mockImplementation(() => {});
    root.removeAttribute("style");
    delete root.dataset.groveInterface;
    document.getElementById("grove-orbit-fallback")?.remove();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("applies the interface flag and Orbit tokens from a current host, live", () => {
    const grove = loadSdk();
    const seen: string[] = [];
    grove.theme.onChange((t) => seen.push(`${t.interface}:${t.tokens["--o-radius"] ?? "-"}`));
    push({ type: "grove:theme", data: { id: "d", isLight: false, colors, interface: "orbit", tokens: { "--o-bg": "#101010", "--o-radius": "8px", "--o-hover": "color-mix(in oklab, #f5f5f5 4.5%, transparent)", "not-a-token": "x", "--o-bad": 3 } } });
    expect(root.style.getPropertyValue("--color-bg")).toBe("#101010");
    expect(root.style.getPropertyValue("--o-radius")).toBe("8px");
    expect(root.style.getPropertyValue("--o-hover")).toContain("color-mix");
    expect(root.style.getPropertyValue("not-a-token")).toBe("");
    expect(root.dataset.groveInterface).toBe("orbit");
    expect(grove.theme.getInterface()).toBe("orbit");
    expect(grove.theme.getTokens()).toEqual({ "--o-bg": "#101010", "--o-radius": "8px", "--o-hover": "color-mix(in oklab, #f5f5f5 4.5%, transparent)" });

    // Interface switch: a token the host stops sending is removed, so the fallback applies again.
    push({ type: "grove:theme", data: { id: "d", isLight: false, colors, interface: "workbench", tokens: { "--o-bg": "#101010" } } });
    expect(root.style.getPropertyValue("--o-radius")).toBe("");
    expect(root.dataset.groveInterface).toBe("workbench");
    expect(seen).toEqual(["orbit:8px", "workbench:-"]);
  });

  it("degrades on an old host that sends only id, isLight and colors", () => {
    const grove = loadSdk();
    let received: { interface: string; tokens: Record<string, string> } | null = null;
    grove.theme.onChange((t) => { received = t; });
    push({ type: "grove:theme", data: { id: "old", isLight: true, colors } });
    expect(received).toMatchObject({ interface: "workbench", tokens: {} });
    expect(grove.theme.getInterface()).toBe("workbench");
    expect(grove.theme.getColors()).toEqual(colors);
    expect(root.style.getPropertyValue("--color-text")).toBe("#f5f5f5");
    expect(root.dataset.groveInterface).toBe("workbench");
    // The built-in fallback derives every --o-* token from --color-*.
    const fallback = document.getElementById("grove-orbit-fallback");
    expect(fallback?.textContent).toContain("--o-bg:var(--color-bg)");
    expect(fallback?.textContent).toContain("--o-radius:8px");
    expect(document.head.firstElementChild).toBe(fallback);
  });

  it("reports workbench and no tokens before the theme arrives", () => {
    const grove = loadSdk();
    expect(grove.theme.getInterface()).toBe("workbench");
    expect(grove.theme.getTokens()).toEqual({});
    expect(window.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "plugin-api:request", method: "theme.get" }), "*");
  });

  it("navigate sends host.navigate and settles on the host's reply", async () => {
    const grove = loadSdk();
    vi.mocked(window.postMessage).mockClear();
    const opened = grove.navigate({ to: "settings", section: "appearance" });
    const request = vi.mocked(window.postMessage).mock.calls.map(([message]) => message as { method?: string; id?: string; params?: unknown }).find((message) => message.method === "host.navigate");
    expect(request?.params).toEqual({ to: "settings", section: "appearance" });
    push({ type: "plugin-api:response", id: request?.id, data: { ok: true } });
    await expect(opened).resolves.toEqual({ ok: true });

    const refused = grove.navigate({ to: "plugin-page" });
    const second = vi.mocked(window.postMessage).mock.calls.map(([message]) => message as { method?: string; id?: string }).filter((message) => message.method === "host.navigate").at(-1);
    push({ type: "plugin-api:response", id: second?.id, error: { code: "not_found", message: "no page" } });
    await expect(refused).rejects.toMatchObject({ name: "GroveError", code: "not_found", message: "no page" });
  });

  it("ships a scaffold panel styled with the Orbit tokens", () => {
    const main = scaffold("SCAFFOLD_MAIN_TS");
    for (const token of ["--o-bg", "--o-text", "--o-border", "--o-group", "--o-radius-lg", "--o-hover", "--o-ink", "--o-font-sans"]) expect(main).toContain(`var(${token})`);
    expect(main).toContain('[data-grove-interface="workbench"]');
    expect(main).toContain("grove.theme.getInterface()");
  });
});
