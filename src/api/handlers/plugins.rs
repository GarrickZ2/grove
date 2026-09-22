//! Plugin development & management handlers.
//!
//! Plugin system handlers: create (scaffold / register dev), import (local copy
//! / git clone), serve panel assets, per-plugin file storage, permission
//! enforcement, and MCP-runtime checks. A plugin's `skills/` folder and its
//! `contributes.mcp` are wired into Grove's Skill module and ACP MCP injection
//! on (un)install.

use axum::{
    extract::{Multipart, Path, Query, State},
    http::{header, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::process::Command;
use std::sync::Arc;

use crate::api::{auth::ServerAuth, error::ApiError};

// ─── Path validation (mirrors extension::validate_install_path) ──────────────
//
// Only accept absolute paths, and refuse a handful of system locations where
// writing could corrupt the OS or require sudo.
fn validate_plugin_path(p: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(p);
    if !path.is_absolute() {
        return Err(format!("path must be absolute: {}", p));
    }
    let forbidden = ["/", "/System", "/usr", "/etc", "/var", "/bin", "/sbin"];
    for f in forbidden {
        if path.as_os_str() == std::ffi::OsStr::new(f) {
            return Err(format!("refusing to write into system path: {}", p));
        }
    }
    Ok(path)
}

/// GET /api/v1/plugins/browse-folder — native folder picker with a
/// plugin-specific prompt. Returns `{ path: <abs path> }` or `{ path: null }`.
///
/// Copy of `extension::browse_install_folder` with a different prompt — same
/// rationale as that one: a per-feature prompt is worth the small duplication
/// and avoids changing the shared `folder::browse_folder` signature (used by
/// project import).
pub async fn browse_plugin_folder() -> Json<serde_json::Value> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("osascript")
            .arg("-e")
            .arg("POSIX path of (choose folder with prompt \"Choose a folder for your plugin\")")
            .output();
        if let Ok(output) = output {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(json!({ "path": path }));
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let zenity = Command::new("zenity")
            .args([
                "--file-selection",
                "--directory",
                "--title=Choose a folder for your plugin",
            ])
            .output();
        if let Ok(output) = zenity {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(json!({ "path": path }));
                }
            }
        }
        let kdialog = Command::new("kdialog")
            .args([
                "--getexistingdirectory",
                ".",
                "--title",
                "Choose a folder for your plugin",
            ])
            .output();
        if let Ok(output) = kdialog {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(json!({ "path": path }));
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let ps = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description = 'Choose a folder for your plugin'; if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }",
            ])
            .output();
        if let Ok(output) = ps {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Json(json!({ "path": path }));
                }
            }
        }
    }

    Json(json!({ "path": serde_json::Value::Null }))
}

#[derive(Debug, Deserialize)]
pub struct ScaffoldPluginRequest {
    /// Absolute path to the PARENT folder the user picked. The starter is
    /// created in a `<path>/<name>/` subdirectory inside it — never bare into
    /// the parent, so the user's chosen folder stays tidy.
    pub path: String,
    /// Plugin name — becomes both the subdirectory name and the manifest
    /// `name`. Must not contain path separators or `..`.
    pub name: String,
}

/// The canonical plugin development guide, embedded at compile time so the
/// scaffold can drop a copy into every new plugin's `docs/`. Editing
/// `docs/plugin-development.md` keeps the two in sync automatically.
const PLUGIN_DEV_GUIDE: &str = include_str!("../../../docs/plugin-development.md");

// ─── Scaffold templates ──────────────────────────────────────────────────────
// A scaffolded plugin is a real vite + TypeScript project. Grove never compiles
// plugins: the author runs `make build` to produce `dist/`, which is the
// shipped artifact (the manifest panel entry is `dist/index.html`). Templates
// with `__NAME__` get the plugin name substituted.

const SCAFFOLD_PKG_JSON: &str = r#"{
  "name": "grove-plugin",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "clean": "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\"",
    "dev": "concurrently -k -n panel,server \"vite build --watch\" \"node scripts/build-server.mjs --watch\"",
    "build": "npm run clean && vite build && node scripts/build-server.mjs",
    "publish": "npm run build && node scripts/publish.mjs"
  },
  "//": "dev builds the panel and any src/server.ts / src/backend.ts entries into dist/. Node processes use manifest-derived runtime permissions; Grove requires node >= 24.",
  "engines": { "node": ">=24" },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "concurrently": "^9.0.0",
    "esbuild": "^0.24.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
"#;

const SCAFFOLD_VITE_CONFIG: &str = r#"import { defineConfig } from "vite";

// base: "./" is REQUIRED. Grove serves the built panel from a nested asset URL
// (/api/v1/plugins/<id>/asset/dist/index.html), so the built HTML must
// reference its assets relatively (./assets/...), never absolutely (/assets/...).
//
// emptyOutDir: false is also REQUIRED. dist/ is shared: vite writes the panel
// (index.html + assets), esbuild writes dist/server.js / dist/backend.js. If
// vite emptied dist/ on each (re)build it would silently delete the server
// bundle — so the `build` script cleans dist ONCE up front instead.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: false },
});
"#;

// Builds the plugin's node side (MCP / backend) when present,
// so `npm run dev` / `npm run build` work whether or not you ship one. No-op for
// panel-only plugins; `--watch` rebuilds on change. Cross-platform (pure node).
const SCAFFOLD_BUILD_SERVER_MJS: &str = r#"import { existsSync } from "node:fs";
import * as esbuild from "esbuild";

// Add src/server.ts (MCP) or src/backend.ts (panel, workflow, or Connect backend)
// and it builds automatically — no script edits needed.
const entries = ["src/server.ts", "src/backend.ts"].filter(existsSync);
if (entries.length === 0) process.exit(0);

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: entries,
  bundle: true,
  platform: "node",   // node: built-ins stay external; npm deps are bundled
  target: "node24",
  format: "esm",
  outdir: "dist",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.error(`[grove] watching ${entries.join(", ")} -> dist/`);
} else {
  await esbuild.build(options);
}
"#;

// `npm run publish` / `make publish`: verify the build is complete, then package
// the distributable subset into <name>-<version>.zip — the last step before
// sharing (drop the zip into Grove → Add → From Local, or commit dist/ for git).
const SCAFFOLD_PUBLISH_MJS: &str = r#"import { existsSync, readFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync("plugin.json", "utf8"));
const { name, version, contributes = {} } = manifest;

// 1. Every declared entry must actually be built (catches a forgotten build).
const required = [];
if (contributes.panel?.entry) required.push(contributes.panel.entry);
if (contributes.sidebar?.entry) required.push(contributes.sidebar.entry);
for (const c of [contributes.mcp, contributes.backend]) {
  if (c?.args) required.push(...c.args.filter((a) => /\.(js|cjs|mjs)$/.test(a)));
}
const missing = [...new Set(required)].filter((p) => !existsSync(p));
if (missing.length) {
  console.error(`x Not built: ${missing.join(", ")}\n  Run \`npm run build\` first.`);
  process.exit(1);
}

// 2. Stage only what an install needs — no src/, node_modules/, or build config.
const stage = `.publish/${name}`;
rmSync(".publish", { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const item of ["plugin.json", "dist", "skills", "docs", "README.md"]) {
  if (existsSync(item)) cpSync(item, `${stage}/${item}`, { recursive: true });
}

// 3. Zip it → <name>-<version>.zip, ready for Grove's "Add -> From Local".
const zip = `${name}-${version}.zip`;
rmSync(zip, { force: true });
try {
  execFileSync("zip", ["-rq", resolve(zip), name], { cwd: ".publish", stdio: "inherit" });
} catch {
  console.error("x `zip` not found. Install it, or for a git install just commit dist/.");
  process.exit(1);
}
rmSync(".publish", { recursive: true, force: true });
console.error(`OK ${zip} - ready to share (Grove -> Settings -> Plugins -> Add -> From Local).`);
"#;

const SCAFFOLD_TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"]
  },
  "include": ["src"]
}
"#;

// Plain npm — the universal default every Node dev already has. (Grove's own
// repo uses pnpm because it's a monorepo; a standalone plugin shouldn't impose
// that.) Makefile recipe lines MUST be tab-indented — built as a normal string
// with explicit \t so the tabs survive (a raw string would need literal tabs).
const SCAFFOLD_MAKEFILE: &str = "# Grove plugin — build the dist/ that Grove serves.\n# Grove never builds on the user's machine: you build here and commit/zip dist/.\n\ninstall: ## one-time: install dev dependencies\n\tnpm install\n\ndev: ## rebuild dist/ on every change — then hit Reload in Grove's panel\n\tnpm run dev\n\nbuild: ## produce a clean dist/ (panel + any node process)\n\tnpm run build\n\npublish: ## build + package <name>-<version>.zip, ready to distribute\n\tnpm run publish\n\n.PHONY: install dev build publish\n";

// node_modules is local-only; dist is the SHIPPED artifact, so it is NOT ignored.
const SCAFFOLD_GITIGNORE: &str = "node_modules\n*.log\n.DS_Store\n.publish/\n*.zip\n";

const SCAFFOLD_INDEX_HTML: &str = r#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>__NAME__</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
"#;

// Inlined SDK. A published plugin would depend on the `grove-plugin-sdk` npm
// package; this self-contained copy keeps the scaffold buildable with zero
// extra deps. Talks to the Grove host over postMessage.
const SCAFFOLD_GROVE_TS: &str = r#"/** A structured SDK error — `code` lets you branch (e.g. "not_found",
 *  "forbidden", "timeout") instead of string-matching the message. */
export class GroveError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GroveError";
    this.code = code;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: GroveError) => void; timer: ReturnType<typeof setTimeout> };
const pending: Record<string, Pending> = {};
// Open exec streams, keyed by request id (each forwards events to its iterator).
const streams: Record<string, (event: ExecEvent) => void> = {};
// Event-bus handlers (grove.events.on), keyed by event name.
const eventHandlers: Record<string, Set<(data: unknown) => void>> = {};
// Latest focused chat id in this task, pushed by the host as `chat.active`.
let currentActiveChatId: string | null = null;
let seq = 0;
const CALL_TIMEOUT_MS = 30000;

window.addEventListener("message", (e) => {
  // This iframe is sandboxed WITHOUT allow-same-origin → opaque origin, so we
  // can't compare origin strings. The Grove host is always our parent window,
  // and `event.source` is unforgeable, so trust by window identity instead.
  if (e.source !== window.parent) return;
  const d = e.data;
  if (!d) return;
  if (d.type === "plugin-api:response" && pending[d.id]) {
    const p = pending[d.id];
    delete pending[d.id];
    delete streams[d.id];
    clearTimeout(p.timer);
    if (d.error) {
      const err = d.error as { code?: string; message?: string } | string;
      p.reject(typeof err === "string"
        ? new GroveError("error", err)
        : new GroveError(err.code ?? "error", err.message ?? "Grove API error"));
    } else {
      p.resolve(d.data);
    }
  } else if (d.type === "plugin-api:stream" && streams[d.id]) {
    streams[d.id](d.event as ExecEvent);
  } else if (d.type === "grove:event" && typeof d.name === "string") {
    const hs = eventHandlers[d.name];
    if (hs) hs.forEach((cb) => cb(d.data)); // backend/MCP push → your handler
  } else if (d.type === "chat.active") {
    currentActiveChatId = typeof d.chatId === "string" ? d.chatId : null;
  } else if (d.type === "grove:theme" && d.data) {
    applyTheme(d.data as GroveTheme); // live theme switch
  }
});

function call<T>(method: string, params?: Record<string, unknown>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = "r" + ++seq;
    // No reply (host crash / dropped message) → reject + clean up, never leak.
    const timer = setTimeout(() => {
      delete pending[id];
      reject(new GroveError("timeout", `Grove did not respond to "${method}" within ${timeoutMs}ms`));
    }, timeoutMs);
    pending[id] = { resolve: resolve as (v: unknown) => void, reject, timer };
    parent.postMessage({ type: "plugin-api:request", id, method, params: params ?? {} }, "*");
  });
}

// base64 <-> bytes (JSON can't carry raw bytes, so binary crosses as base64).
function bytesToB64(b: Uint8Array): string {
  // Chunk so large buffers don't blow the call-arg limit or thrash GC with a
  // byte-by-byte concat (which OOMs the tab on multi-MB files).
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < b.length; i += CHUNK) {
    s += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface HostInfo {
  projectId: string | null;
  projectName: string | null;
  projectType: "repo" | "studio" | null;
  taskId: string | null;
}

export interface ThemeColors {
  bg: string; bgSecondary: string; bgTertiary: string; border: string;
  text: string; textMuted: string; highlight: string; accent: string;
  success: string; warning: string; error: string; info: string;
}
export interface GroveTheme { id: string; isLight: boolean; colors: ThemeColors; }

const CSS_VAR: Record<keyof ThemeColors, string> = {
  bg: "--color-bg", bgSecondary: "--color-bg-secondary", bgTertiary: "--color-bg-tertiary",
  border: "--color-border", text: "--color-text", textMuted: "--color-text-muted",
  highlight: "--color-highlight", accent: "--color-accent", success: "--color-success",
  warning: "--color-warning", error: "--color-error", info: "--color-info",
};
let currentTheme: GroveTheme | null = null;
const themeListeners = new Set<(t: GroveTheme) => void>();
function applyTheme(t: GroveTheme) {
  currentTheme = t;
  const root = document.documentElement;
  (Object.keys(CSS_VAR) as (keyof ThemeColors)[]).forEach((k) => {
    if (t.colors[k]) root.style.setProperty(CSS_VAR[k], t.colors[k]);
  });
  root.style.setProperty("--grove-bg", t.colors.bg);
  root.style.setProperty("--grove-text", t.colors.text);
  themeListeners.forEach((l) => l(t));
}

// ─── storage: three scopes, each KV (get/set) + files ────────────────────────
//
// global  → cross-project (user prefs, tokens)         requires storage:read/write
// project → this project (config, index cache)
// task    → this task only (drafts, transient state)
// KV is sugar over a JSON file under `_kv/<key>.json` in the chosen scope.
const kvPath = (key: string) => `_kv/${encodeURIComponent(key)}.json`;

export interface StorageScope {
  /** KV get — parsed JSON, or null if unset. */
  get<T>(key: string): Promise<T | null>;
  /** KV set — value is JSON-serialized. */
  set(key: string, value: unknown): Promise<boolean>;
  /** KV delete. */
  remove(key: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<boolean>;
  deleteFile(path: string): Promise<boolean>;
  list(path?: string): Promise<{ name: string; isDir: boolean }[]>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeBytes(path: string, data: Uint8Array): Promise<boolean>;
}

function makeScope(scope: "global" | "project" | "task"): StorageScope {
  const s: StorageScope = {
    readFile: (path) => call<string | null>("storage.readFile", { scope, path }),
    writeFile: (path, content) => call<boolean>("storage.writeFile", { scope, path, content }),
    deleteFile: (path) => call<boolean>("storage.deleteFile", { scope, path }),
    list: (path = "") => call<{ name: string; isDir: boolean }[]>("storage.list", { scope, path }),
    readBytes: (path) =>
      call<string | null>("storage.readBytes", { scope, path }).then((b) => (b ? b64ToBytes(b) : null)),
    writeBytes: (path, data) =>
      call<boolean>("storage.writeBytes", { scope, path, content: bytesToB64(data) }),
    get: async <T>(key: string): Promise<T | null> => {
      const raw = await s.readFile(kvPath(key));
      if (raw == null) return null;
      try { return JSON.parse(raw) as T; } catch { return null; }
    },
    set: (key, value) => s.writeFile(kvPath(key), JSON.stringify(value)),
    remove: (key) => s.deleteFile(kvPath(key)),
  };
  return s;
}

// ─── exec: stream a command's output (high-risk `exec` permission) ───────────
export type ExecEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

function exec(command: string, args: string[] = []): AsyncIterable<ExecEvent> {
  const id = "e" + ++seq;
  const queue: ExecEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  // Stall guard: if the host goes silent for 2min with no event and no close,
  // surface an error so the iterator never hangs forever (server caps at 10min).
  let idle: ReturnType<typeof setTimeout>;
  const resetIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { queue.push({ type: "error", message: "exec stalled (no output for 120s)" }); finish(); }, 120000);
  };
  const finish = () => { done = true; clearTimeout(idle); delete streams[id]; delete pending[id]; if (wake) { const w = wake; wake = null; w(); } };
  const push = (ev: ExecEvent) => { resetIdle(); queue.push(ev); if (wake) { const w = wake; wake = null; w(); } };

  streams[id] = push;
  // The closing `plugin-api:response` ends the stream (resolve), or fails it.
  pending[id] = {
    resolve: () => finish(),
    reject: (e) => { queue.push({ type: "error", message: e.message }); finish(); },
    timer: setTimeout(() => {}, 0), // exec uses the idle guard, not the call timeout
  };
  clearTimeout(pending[id].timer);
  resetIdle();
  parent.postMessage({ type: "plugin-api:request", id, method: "exec.run", params: { command, args } }, "*");

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          while (queue.length) yield queue.shift() as ExecEvent;
          if (done) return;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally {
        // Consumer left early (break / return / throw) → clean up the stream
        // sink, pending entry and idle timer so nothing leaks.
        finish();
      }
    },
  };
}

/** A chat session under the current task. */
export interface ChatInfo {
  id: string;
  title: string;
  agent: string;
}

export const grove = {
  // Project + task context. `taskId`/project read are only meaningful in a
  // workspace panel; a sidebar page is app-scoped (taskId is null).
  host: { getInfo: () => call<HostInfo>("host.getInfo") },
  // Private storage at three scopes (requires storage:read / storage:write).
  storage: {
    global: makeScope("global"),
    project: makeScope("project"),
    task: makeScope("task"),
  },
  // VFS mount /project/ — read the current task's working dir (read-only).
  // Requires the "project:read" permission and a workspace panel.
  project: {
    readFile: (path: string) => call<string | null>("project.readFile", { path }),
    list: (path = "") =>
      call<{ name: string; isDir: boolean }[]>("project.list", { path }),
  },
  // The current task's chat sessions + injecting prompts into them. Workspace
  // panels only (a sidebar has no task). `list`/`activeChatId` need "chat:read";
  // `sendPrompt` needs "chat:write". The host scopes every call to THIS panel's
  // task — a plugin can't drive another task's agent.
  chat: {
    // All chat sessions under this task.
    list: (): Promise<ChatInfo[]> => call<ChatInfo[]>("chat.list"),
    // The chat the user currently has focused, or null. Updated live as the
    // user switches chats — read it at call time, don't cache.
    activeChatId: (): string | null => currentActiveChatId,
    // Inject a user prompt into a chat's agent (spawning the session on
    // demand). Shows up in the chat as a message from this plugin. Default the
    // target to `activeChatId()` if you want "the chat the user is looking at".
    //   grove.chat.sendPrompt({ chatId: grove.chat.activeChatId()!, text: "..." })
    sendPrompt: (opts: { chatId: string; text: string }): Promise<{ ok: true }> =>
      call<{ ok: true }>("chat.send", { chatId: opts.chatId, text: opts.text }),
  },
  // Call the plugin's node backend (contributes.backend). Requires a backend.
  backend: {
    // opts.timeoutMs raises the wait for a slow backend op (default 30s) — both
    // the SDK and Grove's backend manager honor it.
    invoke: <T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> =>
      call<T>(
        "backend.invoke",
        { method, params: params ?? {}, timeoutMs: opts?.timeoutMs },
        opts?.timeoutMs ?? CALL_TIMEOUT_MS,
      ),
  },
  // Subscribe to events pushed by the plugin's backend / MCP server (e.g. after
  // a tool mutates data, refresh the panel). Returns an unsubscribe function.
  //   grove.events.on("cases-changed", () => reload());
  //
  // The reserved "grove:radio" event carries Grove's own aggregated agent/chat
  // activity for this task (chat status, busy, prompts, final messages, hooks,
  // todo progress) — the same stream the Radio/menubar use. Requires "chat:read".
  //   grove.events.on("grove:radio", (e) => { /* e.type, e.task_id, ... */ });
  events: {
    on<T = unknown>(name: string, cb: (data: T) => void): () => void {
      const handler = cb as (data: unknown) => void;
      const set = eventHandlers[name] ?? (eventHandlers[name] = new Set());
      set.add(handler);
      return () => {
        eventHandlers[name]?.delete(handler);
      };
    },
  },
  // Run a command in the task's working dir, streaming output. High-risk:
  // requires the `exec` permission (≈ full machine trust). Workspace panels only.
  //
  //   for await (const ev of grove.exec("go", ["test", "./..."])) {
  //     if (ev.type === "stdout") console.log(ev.line);
  //   }
  exec,
  // Small helpers. `uuid()` wraps crypto.randomUUID() — collision-free, no need
  // to roll your own from Date.now()/Math.random().
  util: { uuid: (): string => crypto.randomUUID() },
  // Grove's theme. The SDK applies it to your :root automatically (so
  // `var(--color-bg)` etc. match Grove and update live on theme switch).
  theme: {
    getColors: (): ThemeColors | null => currentTheme?.colors ?? null,
    isLight: (): boolean => currentTheme?.isLight ?? true,
    onChange: (cb: (t: GroveTheme) => void): (() => void) => {
      themeListeners.add(cb);
      return () => { themeListeners.delete(cb); };
    },
  },
};

// Apply Grove's theme to this plugin on load (and the host pushes updates when
// the user switches themes — handled in the message listener above).
call<GroveTheme>("theme.get").then(applyTheme).catch(() => { /* host may be old */ });
"#;

// MCP-server SDK — the SAME `grove` API as the panel SDK (`src/grove.ts`), so
// you write identical code on both sides. The transport differs internally (the
// host injects context into this process) but is fully hidden: you call
// `grove.host.getInfo()` / `grove.project.*` / `grove.storage.*` and never touch
// env, JSON, or any "context" object.
const SCAFFOLD_GROVE_MCP_TS: &str = r#"import { readFile, readdir, writeFile, rm, mkdir } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

// Defense-in-depth path guard: refuse a path that escapes its base dir (`..`,
// absolute). Node's permission model also fences fs access, but the SDK must
// not rely solely on it. Throws (the caller surfaces it, never silently null).
function safeJoin(base: string, p: string): string {
  const full = resolve(base, p);
  const rel = relative(base, full);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\")) {
    throw new Error("path escapes the allowed directory: " + p);
  }
  return full;
}

interface StorageDirs { global: string; project: string | null; task: string | null; }
interface Ctx {
  projectDir: string; dataDir: string; pluginDir: string;
  projectId: string | null; projectName: string | null;
  projectType: "repo" | "studio" | null;
  taskId: string | null; taskName: string | null; branch: string | null;
  storage: StorageDirs;
}
function ctx(): Ctx {
  let c: Partial<Ctx> = {};
  try { c = JSON.parse(process.env.GROVE_CONTEXT ?? "{}") as Partial<Ctx>; } catch { /* ignore */ }
  const storage = c.storage ?? { global: c.dataDir ?? "", project: null, task: null };
  return {
    projectDir: c.projectDir ?? "", dataDir: c.dataDir ?? "", pluginDir: c.pluginDir ?? "",
    projectId: c.projectId ?? null, projectName: c.projectName ?? null,
    projectType: c.projectType ?? null,
    taskId: c.taskId ?? null, taskName: c.taskName ?? null, branch: c.branch ?? null,
    storage,
  };
}

export interface HostInfo {
  projectId: string | null;
  projectName: string | null;
  projectType: "repo" | "studio" | null;
  taskId: string | null;
  taskName: string | null;
  branch: string | null;
}

// ─── storage: three scopes, each KV (get/set) + files ────────────────────────
// Same surface as the panel SDK, so panel and backend/MCP code read identically.
const kvFile = (key: string) => `_kv/${encodeURIComponent(key)}.json`;

function scopeDir(scope: "global" | "project" | "task"): string {
  const s = ctx().storage;
  const d = scope === "global" ? s.global : scope === "project" ? s.project : s.task;
  if (!d) throw new Error(`storage scope "${scope}" is unavailable in this context`);
  return d;
}

export interface StorageScope {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<boolean>;
  deleteFile(path: string): Promise<boolean>;
  list(path?: string): Promise<{ name: string; isDir: boolean }[]>;
  /** The raw on-disk dir for this scope — open it with native libs (sqlite, …). */
  dir(): string;
}

function makeScope(scope: "global" | "project" | "task"): StorageScope {
  const dir = () => scopeDir(scope);
  const s: StorageScope = {
    dir,
    async readFile(path) {
      try { return await readFile(safeJoin(dir(), path), "utf8"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    async writeFile(path, content) {
      const f = safeJoin(dir(), path);
      await mkdir(dirname(f), { recursive: true });
      await writeFile(f, content);
      return true;
    },
    async deleteFile(path) { await rm(safeJoin(dir(), path), { force: true }); return true; },
    async list(path = "") {
      try {
        const items = await readdir(safeJoin(dir(), path), { withFileTypes: true });
        return items.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    },
    async get<T>(key: string): Promise<T | null> {
      const raw = await s.readFile(kvFile(key));
      if (raw == null) return null;
      try { return JSON.parse(raw) as T; } catch { return null; }
    },
    set(key, value) { return s.writeFile(kvFile(key), JSON.stringify(value)); },
    remove(key) { return s.deleteFile(kvFile(key)); },
  };
  return s;
}

export const grove = {
  host: {
    /** Current project + task — same shape as the panel's grove.host.getInfo(). */
    getInfo(): Promise<HostInfo> {
      const c = ctx();
      return Promise.resolve({
        projectId: c.projectId, projectName: c.projectName, projectType: c.projectType,
        taskId: c.taskId, taskName: c.taskName, branch: c.branch,
      });
    },
  },
  // Read the current task's files.
  project: {
    async readFile(path: string): Promise<string | null> {
      try { return await readFile(safeJoin(ctx().projectDir, path), "utf8"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
    },
    async list(path = ""): Promise<{ name: string; isDir: boolean }[]> {
      try {
        const items = await readdir(safeJoin(ctx().projectDir, path), { withFileTypes: true });
        return items.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
      } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    },
  },
  // Private storage at three scopes (same API as the panel).
  storage: {
    global: makeScope("global"),
    project: makeScope("project"),
    task: makeScope("task"),
  },
  // Same helpers as the panel SDK, so shared code works on both sides.
  util: { uuid: (): string => randomUUID() },
  // Push a semantic event to the plugin's panel (which can grove.events.on it).
  // Transport is injected by Grove: a node backend writes its stdout (Grove owns
  // that pipe); an MCP server POSTs back over HTTP (its stdout talks to the
  // agent). Fire-and-forget.
  events: {
    emit<T = unknown>(name: string, data?: T): void {
      if (process.env.GROVE_EVENTS_TRANSPORT === "stdio") {
        process.stdout.write(JSON.stringify({ type: "grove:event", name, data: data ?? null }) + "\n");
        return;
      }
      const url = process.env.GROVE_EVENTS_URL;
      if (!url) {
        console.error("[grove] events.emit: no transport configured");
        return;
      }
      void fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-grove-events-token": process.env.GROVE_EVENTS_TOKEN ?? "",
        },
        body: JSON.stringify({ name, data: data ?? null, taskId: ctx().taskId }),
      }).catch(() => { /* best-effort */ });
    },
  },
  // Raw directory paths. This is a host process with real filesystem access, so
  // for anything heavier than read/write — a SQLite db (use Node's built-in
  // `node:sqlite`, no native addon needed), appended writes, running a tool —
  // open these directly. Command execution needs the `exec` permission
  // (`--allow-child-process`); for everything else fs is enough.
  paths: {
    /** The three storage scope dirs (project/task null when out of context). */
    get storage(): StorageDirs { return ctx().storage; },
    /** The current task's working dir. */
    get project(): string { return ctx().projectDir; },
    /** The plugin's own folder. */
    get plugin(): string { return ctx().pluginDir; },
  },
};
"#;

// Backend SDK (contributes.backend). The existing stdio channel is bidirectional:
// panels may invoke handlers, Grove may publish events, and the backend may call
// the small set of host APIs exposed under `grove.connect`.
const SCAFFOLD_GROVE_BACKEND_TS: &str = r#"import { createInterface } from "node:readline";
import { grove as baseGrove } from "./mcp";

type Handler = (params: unknown) => unknown | Promise<unknown>;
type EventHandler = (data: unknown) => void;
const handlers: Record<string, Handler> = {};
const eventHandlers: Record<string, Set<EventHandler>> = {};
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextHostCallId = 1;

export interface ConnectRecord {
  id: string; name: string; provider: string; domain: string; enabled: boolean;
  config: Record<string, unknown>; projectId: string; taskId: string; sessionId: string;
  boundConversationId?: string | null; boundUserId?: string | null;
}
export interface InboundAttachment { kind: "image" | "audio" | "file"; name: string; mimeType?: string; dataBase64: string; }
export interface InboundMessage { externalMessageId: string; conversationId: string; senderId: string; text?: string; attachments?: InboundAttachment[]; }
export interface InboundAction { conversationId: string; senderId: string; sourceMessageId?: string; name?: string; fields?: Record<string, string>; }
export interface ProviderHttpRequest { method: string; query: string; headers: Record<string, string>; bodyBase64: string; }
export interface ProviderHttpResponse { status?: number; headers?: Record<string, string>; body?: string; bodyBase64?: string; }
export interface RegistrationResult {
  state?: "waiting_for_scan" | "authorized" | "error"; verificationUrl?: string;
  qrSvg?: string; expiresAt?: number; expiresIn?: number; config?: Record<string, unknown>;
  userId?: string; error?: string; response?: ProviderHttpResponse;
}
export interface ConnectProviderHandlers {
  validate?(params: { providerId: string; domain: string; config: Record<string, unknown> }): unknown | Promise<unknown>;
  verify?(params: { providerId: string; domain: string; config: Record<string, unknown> }): unknown | Promise<unknown>;
  registrationBegin?(params: { providerId: string; id: string; domain: string; callbackUrl: string }): RegistrationResult | Promise<RegistrationResult>;
  registrationStatus?(params: { providerId: string; id: string }): RegistrationResult | Promise<RegistrationResult>;
  registrationCallback?(params: { providerId: string; id: string; request: ProviderHttpRequest }): RegistrationResult | Promise<RegistrationResult>;
}

function hostCall<T>(method: string, params: unknown = {}): Promise<T> {
  const id = nextHostCallId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    process.stdout.write(JSON.stringify({ type: "grove:host_call", id, method, params }) + "\n");
  });
}

export const grove = {
  ...baseGrove,
  events: {
    ...baseGrove.events,
    on<T = unknown>(name: string, callback: (data: T) => void): () => void {
      const set = eventHandlers[name] ?? (eventHandlers[name] = new Set());
      set.add(callback as EventHandler);
      return () => set.delete(callback as EventHandler);
    },
  },
  connect: {
    records: {
      list: () => hostCall<ConnectRecord[]>("connect.records.list"),
      get: (id: string) => hostCall<ConnectRecord>("connect.records.get", { id }),
      update: (id: string, config: Record<string, unknown>) => hostCall<ConnectRecord>("connect.records.update", { id, config }),
    },
    setStatus: (connectionId: string, state: "offline" | "connecting" | "online" | "error", detail?: string) =>
      hostCall<{ ok: true }>("connect.status", { connectionId, state, detail }),
    deliverMessage: (connectionId: string, message: InboundMessage) =>
      hostCall<{ ok: true }>("connect.deliverMessage", { connectionId, message }),
    deliverAction: <T = unknown>(connectionId: string, action: InboundAction) =>
      hostCall<T>("connect.deliverAction", { connectionId, action }),
  },
};

/** Register a method the panel or Grove registration flow can call. */
export function registerHandler(method: string, fn: Handler): void {
  if (handlers[method]) console.error(`[grove] registerHandler: overwriting "${method}"`);
  handlers[method] = fn;
}

/** Attach optional registration/config handlers to the normal plugin backend. */
export function registerConnectProvider(provider: ConnectProviderHandlers): void {
  const methods: Array<[string, Handler | undefined]> = [
    ["connect.validate", provider.validate as Handler | undefined],
    ["connect.verify", provider.verify as Handler | undefined],
    ["connect.registration.begin", provider.registrationBegin as Handler | undefined],
    ["connect.registration.status", provider.registrationStatus as Handler | undefined],
    ["connect.registration.callback", provider.registrationCallback as Handler | undefined],
  ];
  for (const [name, handler] of methods) if (handler) registerHandler(name, handler);
}

/** Start the backend protocol after registering handlers and event listeners. */
export function serve(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { return; }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    const message = value as { type?: string; id?: number; method?: string; params?: unknown; name?: string; data?: unknown; result?: unknown; error?: { message?: string } };
    if (message.type === "grove:event" && typeof message.name === "string") {
      for (const callback of eventHandlers[message.name] ?? []) callback(message.data);
      return;
    }
    if (message.type === "grove:host_response" && typeof message.id === "number") {
      const call = pending.get(message.id);
      if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message ?? "Grove host call failed"));
      else call.resolve(message.result);
      return;
    }
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    void (async () => {
      const fn = handlers[message.method!];
      if (!fn) { reply(message.id!, undefined, `unknown method: ${message.method}`); return; }
      try { reply(message.id!, await fn(message.params)); }
      catch (error) { reply(message.id!, undefined, error instanceof Error ? error.message : String(error)); }
    })();
  });
}

function reply(id: number, result?: unknown, error?: string): void {
  process.stdout.write(JSON.stringify(error ? { id, error: { message: error } } : { id, result: result ?? null }) + "\n");
}
"#;

// Shared code between the panel (browser build) and any node side (MCP server /
// backend). Both build targets import this one file, so types + constants are
// defined ONCE instead of copy-pasted into each — the panel persists a value
// and the server reads it back with the exact same `PluginState` type and key.
const SCAFFOLD_SHARED_TS: &str = r#"// Types & constants shared by src/main.ts (panel) and any node-side code
// (MCP server / backend). Define them here once; import from both sides.

/** Storage key for the panel's persisted state. */
export const STATE_KEY = "state";

/** Shape of the data the panel persists. A backend/MCP server reading the same
 *  value via grove.storage gets it with this exact type. */
export interface PluginState {
  count: number;
}

/** Payload of an event the server pushes and the panel listens for. Pass it as
 *  the type arg on both sides so they stay in sync:
 *    grove.events.emit<CountChanged>("count-changed", { count });   // server
 *    grove.events.on<CountChanged>("count-changed", (d) => d.count); // panel
 */
export interface CountChanged {
  count: number;
}
"#;

const SCAFFOLD_MAIN_TS: &str = r#"import { grove } from "./grove-sdk";
import { STATE_KEY, type PluginState } from "./shared";

// Styled entirely with Grove's theme variables (the SDK applies the current
// theme to :root and keeps it live), so this panel matches Grove and follows
// theme switches in Settings.
const app = document.getElementById("app")!;
app.innerHTML = `
  <style>
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: var(--color-bg); color: var(--color-text); }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; box-sizing: border-box; }
    .card { width: 100%; max-width: 30rem; padding: 1.5rem; border-radius: .75rem; border: 1px solid var(--color-border); background: var(--color-bg-secondary); }
    h1 { margin: 0 0 .35rem; font-size: 1.25rem; color: var(--color-text); }
    p { margin: .4rem 0; color: var(--color-text-muted); font-size: .875rem; }
    code { color: var(--color-highlight); }
    .count { color: var(--color-highlight); font-weight: 600; }
    button { margin-top: 1rem; padding: .5rem .9rem; border-radius: .5rem; border: none; background: var(--color-highlight); color: #fff; cursor: pointer; font-size: .875rem; font-weight: 500; }
    button:hover { opacity: .9; }
  </style>
  <div class="wrap"><div class="card">
    <h1>Hello from __NAME__ 👋</h1>
    <p id="info">Connecting to Grove…</p>
    <p>Persisted count: <span class="count" id="count">0</span></p>
    <button id="inc">Increment &amp; save</button>
    <p>This panel uses Grove's theme — switch themes in Settings and watch it follow.</p>
    <p>Edit <code>src/main.ts</code>, run <code>npm run dev</code>, then hit Reload.</p>
  </div></div>
`;

const infoEl = document.getElementById("info")!;
const countEl = document.getElementById("count")!;

async function init() {
  try {
    const info = await grove.host.getInfo();
    infoEl.textContent =
      `Project: ${info.projectName ?? "(none)"} · type: ${info.projectType ?? "-"} · task: ${info.taskId ?? "(none)"}`;
    // KV sugar + a type/key shared with any node side (see src/shared.ts).
    const state = (await grove.storage.global.get<PluginState>(STATE_KEY)) ?? { count: 0 };
    let count = state.count;
    countEl.textContent = String(count);
    document.getElementById("inc")!.addEventListener("click", async () => {
      count += 1;
      await grove.storage.global.set(STATE_KEY, { count } satisfies PluginState);
      countEl.textContent = String(count);
    });
  } catch (err) {
    infoEl.textContent = "SDK error: " + (err instanceof Error ? err.message : String(err));
  }
}
void init();
"#;

const SCAFFOLD_README: &str = r#"# __NAME__

A Grove plugin (vite + TypeScript).

## Develop

```
npm install     # install dev deps (vite, typescript)
npm run dev      # rebuild dist/ on every change — hit Reload in Grove's panel
npm run build    # produce a clean dist/ for publishing
```

Ship the `dist/` folder (commit it for git installs, include it in the zip for
local installs). The panel entry is `dist/index.html`.

## Layout
- `plugin.json` — manifest: name, version, permissions, contributes
- `src/main.ts` — your panel UI
- `src/grove-sdk/` — vendored SDK (panel · MCP · backend, including Connect).
  Refresh it via **Settings → Plugins → Update SDK**; don't edit by hand.
- `index.html` · `vite.config.ts` — build config
- `dist/` — built output · `skills/` — SKILL.md folders · `docs/` — full guide

## SDK
- Panel: `import { grove } from "./grove-sdk"` → `grove.host.getInfo()`,
  `grove.storage.{global,project,task}.*` (`storage:read`/`storage:write`),
  `grove.project.*` (`project:read`), `grove.exec(...)` (`exec`),
  `grove.backend.invoke(...)`
- MCP / backend: `import { grove } from "./grove-sdk/mcp"` (or
  `./grove-sdk/backend`) → the SAME API, plus `grove.paths.*` for native libs
  (node 24+ required)
- IM Connect uses the normal backend SDK: `grove.connect` for records and
  inbound delivery, plus `grove.events.on(...)` for Radio and Connect events.

See `docs/plugin-development.md` for the full reference.
"#;

/// Write the vendored SDK into `<dir>/src/grove-sdk/`, isolated from the user's
/// own `src/` code. Shared by scaffold and the dev-only "Update SDK" action so
/// the two never drift. Overwrites only these three files, nothing else.
fn write_sdk_files(dir: &std::path::Path) -> std::io::Result<()> {
    let sdk = dir.join("src").join("grove-sdk");
    std::fs::create_dir_all(&sdk)?;
    std::fs::write(sdk.join("index.ts"), SCAFFOLD_GROVE_TS)?; // panel SDK
    std::fs::write(sdk.join("mcp.ts"), SCAFFOLD_GROVE_MCP_TS)?;
    std::fs::write(sdk.join("backend.ts"), SCAFFOLD_GROVE_BACKEND_TS)?;
    Ok(())
}

/// Compare the vendored SDK with the exact SDK shipped by this Grove build.
/// This intentionally compares contents instead of plugin/app version numbers:
/// the SDK can change independently of a plugin's own semantic version.
fn plugin_sdk_status(local_path: &str) -> &'static str {
    let sdk = std::path::Path::new(local_path)
        .join("src")
        .join("grove-sdk");
    let expected = [
        ("index.ts", SCAFFOLD_GROVE_TS.as_bytes()),
        ("mcp.ts", SCAFFOLD_GROVE_MCP_TS.as_bytes()),
        ("backend.ts", SCAFFOLD_GROVE_BACKEND_TS.as_bytes()),
    ];
    let mut found = 0;
    for (name, contents) in expected {
        if let Ok(actual) = std::fs::read(sdk.join(name)) {
            found += 1;
            if actual != contents {
                return "outdated";
            }
        }
    }
    if found == 0 {
        "missing"
    } else if found < 3 {
        "outdated"
    } else {
        "current"
    }
}

/// POST /api/v1/plugins/{id}/update-sdk — rewrite a **dev** plugin's vendored
/// SDK (`src/grove-sdk/*`) to the version shipped with this Grove. Dev-only:
/// local/git plugins are immutable copies, so refreshing their SDK wouldn't
/// reach your source — re-import those instead. Touches only the SDK files,
/// never your code or manifest; run `npm run build` afterwards.
pub async fn update_plugin_sdk(
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let plugin = crate::storage::plugins::get(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?
        .ok_or_else(|| ApiError::not_found(format!("plugin not found: {}", id)))?;
    if plugin.source != "dev" {
        return Err(ApiError::bad_request(
            "Update SDK is only for dev plugins; local/git plugins are copies — re-import to update.".to_string(),
        ));
    }
    let dir = std::path::Path::new(&plugin.local_path);
    if !dir.join("src").is_dir() {
        return Err(ApiError::bad_request(
            "plugin has no src/ folder to update".to_string(),
        ));
    }
    write_sdk_files(dir)
        .map_err(|e| ApiError::internal(format!("failed to write SDK files: {}", e)))?;
    // Remove the pre-grove-sdk/ flat SDK files so they don't duplicate/shadow
    // the new ones. These are Grove-managed filenames; if your code imported
    // them, repoint it at "./grove-sdk/…".
    let mut removed_legacy = Vec::new();
    for legacy in [
        "grove.ts",
        "grove-mcp.ts",
        "grove-backend.ts",
        "grove-sdk/connect.ts",
    ] {
        if std::fs::remove_file(dir.join("src").join(legacy)).is_ok() {
            removed_legacy.push(format!("src/{}", legacy));
        }
    }
    Ok(Json(json!({
        "ok": true,
        "files": ["src/grove-sdk/index.ts", "src/grove-sdk/mcp.ts", "src/grove-sdk/backend.ts"],
        "removedLegacy": removed_legacy,
    })))
}

/// POST /api/v1/plugins/scaffold — create `<chosen-parent>/<name>/` and write a
/// minimal plugin starter (`plugin.json` + `README.md`) into it.
///
/// Refuses to overwrite: if the subdirectory already has a `plugin.json`,
/// returns an error so we never clobber a user's existing files.
pub async fn scaffold_plugin(
    Json(req): Json<ScaffoldPluginRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let parent = validate_plugin_path(&req.path).map_err(ApiError::bad_request)?;
    if !parent.exists() {
        return Err(ApiError::bad_request(format!(
            "folder does not exist: {}",
            parent.display()
        )));
    }

    // Validate the name: non-empty, no path separators or traversal — the
    // subdirectory must stay inside the chosen parent.
    let name = req.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("plugin name must not be empty"));
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(ApiError::bad_request(
            "plugin name must not contain path separators or `..`",
        ));
    }

    let dir = parent.join(name);
    let manifest_path = dir.join("plugin.json");
    if manifest_path.exists() {
        return Err(ApiError::bad_request(format!(
            "{} already contains a plugin.json — refusing to overwrite",
            dir.display()
        )));
    }

    std::fs::create_dir_all(&dir)
        .map_err(|e| ApiError::bad_request(format!("could not create {}: {}", dir.display(), e)))?;

    // Write a file at `<dir>/<rel>`, creating parent dirs as needed.
    let write = |rel: &str, contents: &str| -> Result<(), (StatusCode, Json<ApiError>)> {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ApiError::bad_request(format!("could not create {}: {}", parent.display(), e))
            })?;
        }
        std::fs::write(&path, contents).map_err(|e| {
            ApiError::bad_request(format!("could not write {}: {}", path.display(), e))
        })
    };

    // The default scaffold is panel-only (no node required). The two `"//…"`
    // keys are inert (Grove only reads `mcp` / `backend`) but show newcomers the
    // exact shape of the other contribution points and how to switch them on —
    // their SDKs (src/grove-sdk/mcp.ts, src/grove-sdk/backend.ts) are scaffolded.
    let manifest = json!({
        "name": name,
        "version": "0.0.1",
        "description": "",
        "//icon": "Optional: a square image shipped in the plugin (e.g. \"icon.png\" / \"assets/icon.svg\") OR an emoji (e.g. \"🧩\"). Shows in the sidebar, panel tab, and plugin list. Rename this key to \"icon\" to use it; omit for the default icon.",
        "permissions": ["storage:read", "storage:write"],
        "contributes": {
            "panel": { "title": name, "entry": "dist/index.html", "side": "right" },
            "//mcp": {
                "command": "node",
                "args": ["dist/server.js"],
                "note": "To expose tools to the AI agent: add src/server.ts (import from ./grove-sdk/mcp) — it builds to dist/server.js automatically — then rename this key to \"mcp\". Needs node >= 24. See docs/plugin-development.md."
            },
            "//backend": {
                "command": "node",
                "args": ["dist/backend.js"],
                "note": "For a private node backend your panel calls via grove.backend.invoke(): add src/backend.ts (import from ./grove-sdk/backend) — it builds to dist/backend.js automatically — then rename this key to \"backend\". Needs node >= 24. See docs/plugin-development.md."
            },
            "//connectProviders": [{
                "id": "example",
                "name": name,
                "setup_modes": ["form"],
                "config_fields": [],
                "note": "To provide an IM adapter: enable contributes.backend, declare connect:provider, then use grove.connect and grove.events from the backend SDK."
            }]
        }
    });
    let manifest_str = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest)
            .map_err(|e| ApiError::internal(format!("failed to render plugin.json: {}", e)))?
    );
    // A canonical Agent Skill: the folder name MUST equal the `name` in
    // frontmatter, lowercase-kebab. Derive a slug from the plugin name.
    let skill_slug = {
        let mut s = String::new();
        let mut prev_dash = false;
        for ch in name.chars() {
            if ch.is_ascii_alphanumeric() {
                s.push(ch.to_ascii_lowercase());
                prev_dash = false;
            } else if !prev_dash {
                s.push('-');
                prev_dash = true;
            }
        }
        let s = s.trim_matches('-').to_string();
        if s.is_empty() {
            "example".to_string()
        } else {
            s
        }
    };
    let skill_name = format!("{skill_slug}-hello");
    let skill_md = format!(
        "---\nname: {skill_name}\ndescription: Use this skill when the user wants a hello-world demo from the {name} plugin — it shows the SKILL.md format (frontmatter name matches the folder; description states when to use the skill in the third person).\n---\n\n# {name} — hello\n\nWhen this skill is invoked:\n\n1. Greet the user and mention you are running from the **{name}** Grove plugin.\n2. Replace these steps with your skill's real instructions.\n\nKeep instructions concrete and imperative — they are read by the AI agent, not the user.\n"
    );

    // A buildable vite + TypeScript project. The shipped artifact is `dist/`
    // (built by `make build`); Grove serves `dist/index.html`. The full dev
    // guide is embedded at compile time from `docs/plugin-development.md` so an
    // AI coding agent opening this folder can read it in-repo (single source of
    // truth — editing the canonical doc keeps every scaffold in sync).
    write("plugin.json", &manifest_str)?;
    write("package.json", SCAFFOLD_PKG_JSON)?;
    write("vite.config.ts", SCAFFOLD_VITE_CONFIG)?;
    write("scripts/build-server.mjs", SCAFFOLD_BUILD_SERVER_MJS)?;
    write("scripts/publish.mjs", SCAFFOLD_PUBLISH_MJS)?;
    write("tsconfig.json", SCAFFOLD_TSCONFIG)?;
    write("Makefile", SCAFFOLD_MAKEFILE)?;
    write(".gitignore", SCAFFOLD_GITIGNORE)?;
    write("index.html", &SCAFFOLD_INDEX_HTML.replace("__NAME__", name))?;
    // SDK lives in its own folder so it stays clearly separated from your code.
    write_sdk_files(&dir)
        .map_err(|e| ApiError::bad_request(format!("could not write SDK files: {}", e)))?;
    write("src/shared.ts", SCAFFOLD_SHARED_TS)?;
    write("src/main.ts", &SCAFFOLD_MAIN_TS.replace("__NAME__", name))?;
    write("README.md", &SCAFFOLD_README.replace("__NAME__", name))?;
    write(&format!("skills/{skill_name}/SKILL.md"), &skill_md)?;
    write("docs/plugin-development.md", PLUGIN_DEV_GUIDE)?;

    // Auto-register the freshly scaffolded plugin so it shows up in the list
    // immediately (dev plugin = referenced by this folder path, not copied).
    let dir_str = dir.display().to_string();
    let plugin = crate::storage::plugins::upsert(
        &crate::storage::plugins::new_id(),
        name,
        "0.0.1",
        "dev",
        &dir_str,
        None,
        None,
    )
    .map_err(|e| ApiError::internal(format!("failed to register plugin: {}", e)))?;
    sync_plugin_skills(&plugin.id, &plugin.name, &plugin.local_path);
    crate::plugins::backend::registered(&plugin).await;

    Ok(Json(json!({
        "ok": true,
        "id": plugin.id,
        "path": dir_str,
        "name": name,
        // The panel entry is dist/index.html, which doesn't exist until the
        // author builds. Surface the exact next steps so the dialog can show them.
        "next": format!("cd {} && npm install && npm run dev", dir_str),
    })))
}

// ─── Registry: list / register / delete ──────────────────────────────────────

/// Read `contributes.mcp.command` from a plugin folder's manifest (if any).
fn plugin_mcp_command(local_path: &str) -> Option<String> {
    let s = std::fs::read_to_string(std::path::Path::new(local_path).join("plugin.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    v.get("contributes")?
        .get("mcp")?
        .get("command")?
        .as_str()
        .filter(|c| !c.is_empty())
        .map(String::from)
}

/// Whether a bare command name resolves on PATH (`which`/`where`). Commands
/// given as absolute paths are reported as available (we don't probe the FS).
fn command_available(cmd: &str) -> bool {
    if cmd.contains('/') || cmd.contains('\\') {
        return std::path::Path::new(cmd).exists();
    }
    let probe = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    std::process::Command::new(probe)
        .arg(cmd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// GET /api/v1/plugins — list registered plugins. Each entry is enriched with a
/// `runtime` object when the plugin contributes an MCP server, so the UI can warn
/// if the required `command` isn't installed.
pub async fn list_plugins() -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let plugins = crate::storage::plugins::list()
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?;
    let enriched: Vec<serde_json::Value> = plugins
        .iter()
        .map(|p| {
            let mut v = serde_json::to_value(p).unwrap_or_else(|_| json!({}));
            if let Ok(raw) =
                std::fs::read_to_string(std::path::Path::new(&p.local_path).join("plugin.json"))
            {
                if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(name) = manifest.get("name").and_then(serde_json::Value::as_str) {
                        v["name"] = json!(name);
                    }
                    if let Some(version) =
                        manifest.get("version").and_then(serde_json::Value::as_str)
                    {
                        v["version"] = json!(version);
                    }
                }
            }
            v["permissions"] = json!(read_permissions_at(&p.local_path));
            v["contributes"] = read_contributes_at(&p.local_path);
            // Folder still on disk? A user may delete the source folder without
            // uninstalling — surface it as "missing" so the row can be cleaned up.
            v["exists"] = json!(std::path::Path::new(&p.local_path).is_dir());
            v["built"] = json!(plugin_is_built(&p.local_path));
            // Per-capability: which declared entries are not built
            // aren't actually built — so the UI can say "mcp not built" instead
            // of a misleading blanket "ready".
            v["unbuilt"] = json!(unbuilt_entries(&p.local_path));
            v["icon"] = json!(read_icon_at(&p.local_path));
            if p.source == "dev" {
                v["sdk_status"] = json!(plugin_sdk_status(&p.local_path));
            }
            if let Some(cmd) = plugin_mcp_command(&p.local_path) {
                let available = command_available(&cmd);
                v["runtime"] = json!({ "command": cmd, "available": available });
            }
            v
        })
        .collect();
    Ok(Json(json!({ "plugins": enriched })))
}

#[derive(Debug, Deserialize)]
pub struct RegisterPluginRequest {
    /// Absolute path to an existing plugin folder (must contain plugin.json).
    pub path: String,
}

/// POST /api/v1/plugins — register an existing plugin folder as a dev plugin.
/// Reads its plugin.json for the name. Idempotent on path.
pub async fn register_plugin(
    Json(req): Json<RegisterPluginRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let dir = validate_plugin_path(&req.path).map_err(ApiError::bad_request)?;
    let manifest_path = dir.join("plugin.json");
    let manifest_str = std::fs::read_to_string(&manifest_path)
        .map_err(|_| ApiError::bad_request(format!("no plugin.json in {}", dir.display())))?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_str)
        .map_err(|e| ApiError::bad_request(format!("invalid plugin.json: {}", e)))?;
    validate_connect_provider_manifest(&manifest)?;
    let name = manifest
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("plugin.json is missing a \"name\""));
    }
    let version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0");
    let plugin = crate::storage::plugins::upsert(
        &crate::storage::plugins::new_id(),
        name,
        version,
        "dev",
        &dir.display().to_string(),
        None,
        None,
    )
    .map_err(|e| ApiError::internal(format!("failed to register: {}", e)))?;
    sync_plugin_skills(&plugin.id, &plugin.name, &plugin.local_path);
    crate::plugins::backend::registered(&plugin).await;
    Ok(Json(json!({ "ok": true, "plugin": plugin })))
}

/// DELETE /api/v1/plugins/{id} — unregister a dev plugin. Only removes the
/// registry entry; never touches the user's plugin folder on disk.
pub async fn delete_plugin(
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    // local/git plugins live under ~/.grove/plugins/<id> and we own them —
    // remove the files. dev plugins point at the user's own folder; never
    // touch it, just drop the registry row.
    let plugin = crate::storage::plugins::get(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?;
    // Stop every long-lived process before removing an installed plugin's
    // executable files or private data.
    crate::plugins::backend::shutdown_plugin(&id).await;
    crate::plugins::connect_provider::remove_plugin_records(&id)
        .map_err(|e| ApiError::internal(format!("failed to remove plugin Connect records: {e}")))?;
    if let Some(p) = &plugin {
        if p.source != "dev" {
            let owned = plugins_dir().join(&id);
            if owned.exists() {
                std::fs::remove_dir_all(&owned).map_err(|e| {
                    ApiError::internal(format!("failed to remove plugin files: {}", e))
                })?;
            }
        }
    }
    // Plugin KV data is Grove-owned (under ~/.grove/plugins-data) regardless of
    // source — always remove it on uninstall.
    let _ = crate::storage::plugin_data::remove_all(&id);
    // Unmount the plugin's skill source — by its readable name and the legacy
    // id-based name (older installs), so uninstall is clean either way.
    if let Some(p) = &plugin {
        let _ = crate::operations::skills::remove_local_source(&plugin_skill_source_name(&p.name));
    }
    let _ = crate::operations::skills::remove_local_source(&format!("plugin:{}", id));
    let removed = crate::storage::plugins::delete(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?;
    Ok(Json(json!({ "ok": removed })))
}

/// POST /api/v1/plugins/{id}/reveal — open the plugin's folder in the OS file
/// manager (Finder / Explorer / xdg-open). For dev plugins this is the user's
/// own source folder; for local/git it's the copy under ~/.grove/plugins/<id>.
pub async fn reveal_plugin_folder(
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let plugin = crate::storage::plugins::get(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?
        .ok_or_else(|| ApiError::not_found(format!("plugin not found: {}", id)))?;
    let path = std::path::PathBuf::from(&plugin.local_path);
    if !path.exists() {
        return Err(ApiError::bad_request(format!(
            "plugin folder no longer exists: {}",
            plugin.local_path
        )));
    }
    super::studio_common::open_in_file_manager(&path);
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/plugins/{id}/asset-session — after the normal HMAC middleware
/// authenticates the SPA, mint a per-process capability scoped to this one
/// plugin's static asset path.
pub async fn create_plugin_asset_session(
    State(auth): State<Arc<ServerAuth>>,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    crate::storage::plugins::get(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?
        .ok_or_else(|| ApiError::not_found(format!("plugin not found: {}", id)))?;

    Ok(Json(json!({ "token": auth.plugin_asset_token(&id) })))
}

/// GET /api/v1/plugins/{id}/asset/{*path} — serve a file from the plugin's
/// folder for its iframe panel. The resolved path is canonicalized and must
/// stay inside the plugin folder (no `..` traversal).
pub async fn serve_plugin_asset(
    Path((id, asset)): Path<(String, String)>,
) -> Result<axum::response::Response, (StatusCode, Json<ApiError>)> {
    serve_plugin_asset_file(id, asset)
}

/// GET /api/v1/plugin-assets/{token}/{id}/{*path} — browser-native resource
/// route. Keeping the capability in a path prefix lets relative module, style,
/// font, and image URLs inherit it without exposing Grove's main HMAC secret.
pub async fn serve_plugin_session_asset(
    State(auth): State<Arc<ServerAuth>>,
    Path((token, id, asset)): Path<(String, String, String)>,
) -> Result<axum::response::Response, (StatusCode, Json<ApiError>)> {
    if !auth.verify_plugin_asset_token(&id, &token) {
        return Err(ApiError::with_status(
            StatusCode::UNAUTHORIZED,
            "plugin asset session required",
        ));
    }
    serve_plugin_asset_file(id, asset)
}

fn serve_plugin_asset_file(
    id: String,
    asset: String,
) -> Result<axum::response::Response, (StatusCode, Json<ApiError>)> {
    let plugin = crate::storage::plugins::get(&id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?
        .ok_or_else(|| ApiError::not_found(format!("plugin not found: {}", id)))?;

    let base = std::path::PathBuf::from(&plugin.local_path);
    let base_canon = base
        .canonicalize()
        .map_err(|e| ApiError::not_found(format!("plugin folder unavailable: {}", e)))?;
    let full_canon = base
        .join(&asset)
        .canonicalize()
        .map_err(|_| ApiError::not_found(format!("asset not found: {}", asset)))?;
    if !full_canon.starts_with(&base_canon) {
        return Err(ApiError::forbidden("asset path escapes the plugin folder"));
    }

    let bytes = std::fs::read(&full_canon)
        .map_err(|_| ApiError::not_found(format!("asset not found: {}", asset)))?;
    let content_type = mime_guess::from_path(&full_canon).first_or_octet_stream();
    let is_html = content_type.as_ref() == "text/html";

    let mut response = (
        [
            (header::CONTENT_TYPE, content_type.as_ref().to_string()),
            (header::CACHE_CONTROL, "no-store".to_string()),
            // The panel iframe runs sandboxed WITHOUT allow-same-origin (opaque
            // origin) so it can't reach Grove's API directly — the postMessage
            // bridge is its only channel. But its own module scripts then load
            // cross-origin, which requires CORS. Possession of the scoped
            // capability URL authorizes these static bytes; API routes never
            // send this header, which keeps the iframe isolated from Grove.
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*".to_string()),
            (header::REFERRER_POLICY, "no-referrer".to_string()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        bytes,
    )
        .into_response();
    if is_html {
        // Preserve the opaque-origin sandbox even if somebody opens the asset
        // URL directly rather than through PluginFrame's iframe attribute.
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            "sandbox allow-scripts; frame-ancestors 'self'"
                .parse()
                .expect("static CSP"),
        );
    }
    Ok(response)
}

// ─── VFS: /project/ (read current task's working dir) ────────────────────────
//
// The unified VFS exposes two mounts: `/plugin/` (the plugin's private storage,
// handled by the data-dir routes) and `/project/` (the CURRENT task's root —
// a coding worktree or a Studio task dir; the two are mutually exclusive, so
// one mount covers both, and the plugin learns the kind via host.getInfo's
// `projectType`). `/project/` is READ-ONLY this phase; write is a high-risk
// capability deferred to the consent UX. Gated by the `project:read` permission.

/// Resolve the on-disk root directory of a task (its worktree for coding, its
/// studio dir for studio) from the project hash id + task id.
fn resolve_task_root(
    project_id: &str,
    task_id: &str,
) -> Result<std::path::PathBuf, (StatusCode, Json<ApiError>)> {
    let projects = crate::storage::workspace::load_projects()
        .map_err(|e| ApiError::internal(format!("failed to load projects: {}", e)))?;
    let project = projects
        .iter()
        .find(|p| crate::storage::workspace::project_hash(&p.path) == project_id)
        .ok_or_else(|| ApiError::not_found("project not found"))?;
    let project_key = crate::storage::workspace::project_hash(&project.path);
    let task = crate::storage::tasks::get_task(&project_key, task_id)
        .map_err(|e| ApiError::internal(format!("failed to load task: {}", e)))?
        .ok_or_else(|| ApiError::not_found("task not found"))?;
    Ok(std::path::PathBuf::from(&task.worktree_path))
}

/// Join `rel` onto `base`, canonicalize, and refuse anything that escapes
/// `base` (zip-slip / `..` traversal). Empty `rel` resolves to `base` itself.
fn resolve_within(
    base: &std::path::Path,
    rel: &str,
) -> Result<std::path::PathBuf, (StatusCode, Json<ApiError>)> {
    let base_canon = base
        .canonicalize()
        .map_err(|e| ApiError::not_found(format!("project dir unavailable: {}", e)))?;
    let full = base_canon
        .join(rel.trim_start_matches('/'))
        .canonicalize()
        .map_err(|_| ApiError::not_found(format!("path not found: {}", rel)))?;
    if !full.starts_with(&base_canon) {
        return Err(ApiError::forbidden("path escapes the project directory"));
    }
    Ok(full)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectVfsQuery {
    pub project_id: String,
    pub task_id: String,
    #[serde(default)]
    pub path: String,
}

/// GET /api/v1/plugins/{id}/project-file — read a UTF-8 text file from the
/// current task's working directory. Requires the `project:read` permission.
pub async fn read_project_file(
    Path(id): Path<String>,
    Query(q): Query<ProjectVfsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "project:read")?;
    let root = resolve_task_root(&q.project_id, &q.task_id)?;
    let target = resolve_within(&root, &q.path)?;
    const MAX: u64 = 8 * 1024 * 1024;
    let meta = std::fs::metadata(&target)
        .map_err(|_| ApiError::not_found(format!("file not found: {}", q.path)))?;
    if meta.is_dir() {
        return Err(ApiError::bad_request("path is a directory, not a file"));
    }
    if meta.len() > MAX {
        return Err(ApiError::bad_request("file too large to read (> 8MB)"));
    }
    let bytes = std::fs::read(&target)
        .map_err(|e| ApiError::internal(format!("failed to read file: {}", e)))?;
    let content =
        String::from_utf8(bytes).map_err(|_| ApiError::bad_request("not a UTF-8 text file"))?;
    Ok(Json(json!({ "content": content })))
}

/// GET /api/v1/plugins/{id}/project-dir — list a directory inside the current
/// task's working directory. Requires the `project:read` permission.
pub async fn list_project_dir(
    Path(id): Path<String>,
    Query(q): Query<ProjectVfsQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "project:read")?;
    let root = resolve_task_root(&q.project_id, &q.task_id)?;
    let dir = resolve_within(&root, &q.path)?;
    if !dir.is_dir() {
        return Err(ApiError::bad_request("path is not a directory"));
    }
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| ApiError::internal(format!("failed to read directory: {}", e)))?
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(json!({ "name": name, "isDir": is_dir }));
    }
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Ok(Json(json!({ "entries": entries })))
}

// ─── Install: local copy / git clone ─────────────────────────────────────────

/// `~/.grove/plugins` — where local/git plugins are copied/cloned (one
/// subdir per plugin id). dev plugins are NOT stored here (they reference the
/// user's own folder).
fn plugins_dir() -> std::path::PathBuf {
    crate::storage::grove_dir().join("plugins")
}

/// A readable, stable skill-source name for a plugin: `plugin:<name>` with the
/// name sanitized to safe chars. The `plugin:` prefix marks it plugin-owned
/// (the UI forbids manual deletion); the suffix is the plugin's display name so
/// the Skills view shows e.g. `plugin:my-plugin` rather than `plugin:pl-<uuid>`.
fn plugin_skill_source_name(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "plugin:unnamed".to_string()
    } else {
        format!("plugin:{}", slug)
    }
}

/// Mount/unmount a plugin's `skills/` folder as a Grove skill source named
/// `plugin:<name>`. Best-effort — a skills failure must not block plugin ops.
/// Also removes the legacy `plugin:<id>` source so older installs migrate to
/// the readable name on the next sync.
fn sync_plugin_skills(plugin_id: &str, plugin_name: &str, local_path: &str) {
    let source_name = plugin_skill_source_name(plugin_name);
    let legacy = format!("plugin:{}", plugin_id);
    if legacy != source_name {
        let _ = crate::operations::skills::remove_local_source(&legacy);
    }
    let skills_dir = std::path::Path::new(local_path).join("skills");
    if skills_dir.is_dir() {
        let _ = crate::operations::skills::add_local_source(
            &source_name,
            &skills_dir.display().to_string(),
        );
    } else {
        let _ = crate::operations::skills::remove_local_source(&source_name);
    }
}

/// Read (name, version) from a plugin folder's plugin.json.
fn read_manifest(dir: &std::path::Path) -> Result<(String, String), (StatusCode, Json<ApiError>)> {
    let s = std::fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| ApiError::bad_request(format!("no plugin.json in {}", dir.display())))?;
    let v: serde_json::Value = serde_json::from_str(&s)
        .map_err(|e| ApiError::bad_request(format!("invalid plugin.json: {}", e)))?;
    validate_connect_provider_manifest(&v)?;
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("plugin.json is missing a \"name\""));
    }
    let version = v
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    Ok((name, version))
}

fn validate_connect_provider_manifest(
    manifest: &serde_json::Value,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(value) = manifest
        .get("contributes")
        .and_then(|value| value.get("connectProviders"))
    else {
        return Ok(());
    };
    let providers = value
        .as_array()
        .ok_or_else(|| ApiError::bad_request("contributes.connectProviders must be an array"))?;
    let has_permission = manifest
        .get("permissions")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .any(|value| value.as_str() == Some("connect:provider"));
    if !has_permission {
        return Err(ApiError::bad_request(
            "contributes.connectProviders requires the connect:provider permission",
        ));
    }
    if manifest
        .get("contributes")
        .and_then(|value| value.get("backend"))
        .is_none()
    {
        return Err(ApiError::bad_request(
            "contributes.connectProviders requires contributes.backend",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for provider in providers {
        let id = provider
            .get("id")
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .trim();
        if id.is_empty() || id.contains('/') || id.contains(':') {
            return Err(ApiError::bad_request(
                "each connect provider needs an id without ':' or '/'",
            ));
        }
        if !ids.insert(id) {
            return Err(ApiError::bad_request(format!(
                "duplicate connect provider id: {id}"
            )));
        }
        for field in ["name"] {
            if provider
                .get(field)
                .and_then(|value| value.as_str())
                .is_none_or(|value| value.trim().is_empty())
            {
                return Err(ApiError::bad_request(format!(
                    "connect provider {id} is missing {field}"
                )));
            }
        }
        if let Some(modes) = provider.get("setup_modes") {
            let modes = modes.as_array().ok_or_else(|| {
                ApiError::bad_request(format!(
                    "connect provider {id} setup_modes must be an array"
                ))
            })?;
            for mode in modes.iter().filter_map(|value| value.as_str()) {
                if !matches!(mode, "form" | "manual" | "oauth" | "qr") {
                    return Err(ApiError::bad_request(format!(
                        "connect provider {id} has unsupported setup mode {mode}"
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Verify a plugin ships its built UI entries. Grove never builds plugins, so an
/// *imported* (local/git/zip) plugin must already contain the file each
/// `contributes.{panel,sidebar}.entry` points at (typically `dist/index.html`).
/// If a declared entry is missing the plugin is unbuilt — reject the import so
/// the user runs `make build` and ships `dist/`. Not called for `dev` plugins,
/// which are built in place as you develop.
fn verify_entries_built(dir: &std::path::Path) -> Result<(), (StatusCode, Json<ApiError>)> {
    let s = std::fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| ApiError::bad_request(format!("no plugin.json in {}", dir.display())))?;
    let manifest: serde_json::Value = serde_json::from_str(&s)
        .map_err(|e| ApiError::bad_request(format!("invalid plugin.json: {}", e)))?;
    let contributes = manifest.get("contributes");
    for key in ["panel", "sidebar"] {
        let entry = contributes
            .and_then(|c| c.get(key))
            .and_then(|p| p.get("entry"))
            .and_then(|e| e.as_str());
        if let Some(entry) = entry {
            if !dir.join(entry).is_file() {
                return Err(ApiError::bad_request(format!(
                    "plugin is not built: the {} entry \"{}\" is missing. Build the plugin (`make build`) and ship its `dist/` folder before importing.",
                    key, entry
                )));
            }
        }
    }
    Ok(())
}

/// Whether every declared UI entry file exists on disk (i.e. the plugin is
/// built). Imported plugins are verified at install so this is always true for
/// them; it only ever reports false for an unbuilt `dev` plugin. Plugins with
/// no UI entry (mcp-only) are trivially "built".
fn plugin_is_built(local_path: &str) -> bool {
    let dir = std::path::Path::new(local_path);
    let manifest = std::fs::read_to_string(dir.join("plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let Some(manifest) = manifest else {
        return true; // can't tell — don't nag
    };
    let contributes = manifest.get("contributes");
    for key in ["panel", "sidebar"] {
        let entry = contributes
            .and_then(|c| c.get(key))
            .and_then(|p| p.get("entry"))
            .and_then(|e| e.as_str());
        if let Some(entry) = entry {
            if !dir.join(entry).is_file() {
                return false;
            }
        }
    }
    true
}

/// Names of declared contribution points whose built entry is missing on disk
/// (`panel`/`sidebar` by `entry`, `mcp`/`backend` by a `.js`-ish file in `args`).
/// Empty = everything declared is built. Drives the detailed status in the UI.
fn unbuilt_entries(local_path: &str) -> Vec<String> {
    let dir = std::path::Path::new(local_path);
    let Some(manifest) = std::fs::read_to_string(dir.join("plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    else {
        return Vec::new();
    };
    let c = manifest.get("contributes");
    let mut missing = Vec::new();
    for key in ["panel", "sidebar"] {
        if let Some(entry) = c
            .and_then(|c| c.get(key))
            .and_then(|p| p.get("entry"))
            .and_then(|e| e.as_str())
        {
            if !dir.join(entry).is_file() {
                missing.push(key.to_string());
            }
        }
    }
    for key in ["mcp", "backend"] {
        if let Some(args) = c
            .and_then(|c| c.get(key))
            .and_then(|m| m.get("args"))
            .and_then(|a| a.as_array())
        {
            let entry = args
                .iter()
                .filter_map(|a| a.as_str())
                .find(|s| s.ends_with(".js") || s.ends_with(".cjs") || s.ends_with(".mjs"));
            if let Some(entry) = entry {
                if !dir.join(entry).is_file() {
                    missing.push(key.to_string());
                }
            }
        }
    }
    missing
}

/// The plugin's top-level `icon` manifest field (a path relative to the plugin
/// folder, or an emoji). None when unset — the UI falls back to a generic icon.
fn read_icon_at(local_path: &str) -> Option<String> {
    std::fs::read_to_string(std::path::Path::new(local_path).join("plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("icon").and_then(|i| i.as_str()).map(String::from))
}

/// `git clone --depth 1 <url> <dest>` — mirrors operations::skills::git_clone.
fn git_clone(url: &str, dest: &std::path::Path) -> Result<(), (StatusCode, Json<ApiError>)> {
    let output = Command::new("git")
        .args(["clone", "--depth", "1", url])
        .arg(dest)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| ApiError::internal(format!("failed to run git: {}", e)))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(ApiError::bad_request(format!(
            "git clone failed: {}",
            stderr.trim()
        )));
    }
    Ok(())
}

/// Recursively copy a directory tree (files + subdirs; symlinks skipped).
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct InstallLocalRequest {
    /// Absolute path to an existing plugin folder (must contain plugin.json).
    pub path: String,
}

/// POST /api/v1/plugins/install-local — copy an existing plugin folder into
/// `~/.grove/plugins/<id>` and register it (source = "local").
pub async fn install_local(
    Json(req): Json<InstallLocalRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let src = validate_plugin_path(&req.path).map_err(ApiError::bad_request)?;
    let plugin = install_plugin_from_source(&src, "local", None, None).await?;
    Ok(Json(json!({ "ok": true, "plugin": plugin })))
}

/// Install a discovered Plugin artifact from an already materialized Source.
/// The Source remains the catalog authority; the Plugin runtime receives an
/// owned snapshot under ~/.grove/plugins so source sync cannot execute changed
/// code without an explicit reinstall/update action.
pub(crate) async fn install_plugin_from_source(
    src: &std::path::Path,
    source: &str,
    git_url: Option<&str>,
    subpath: Option<&str>,
) -> Result<crate::storage::plugins::Plugin, (StatusCode, Json<ApiError>)> {
    let (name, version) = read_manifest(src)?;
    verify_entries_built(src)?;

    let id = crate::storage::plugins::new_id();
    let dest = plugins_dir().join(&id);
    copy_dir_recursive(src, &dest)
        .map_err(|e| ApiError::internal(format!("failed to copy plugin: {}", e)))?;

    let plugin = crate::storage::plugins::upsert(
        &id,
        &name,
        &version,
        source,
        &dest.display().to_string(),
        git_url,
        subpath,
    )
    .map_err(|e| ApiError::internal(format!("failed to register: {}", e)))?;
    sync_plugin_skills(&plugin.id, &plugin.name, &plugin.local_path);
    crate::plugins::backend::registered(&plugin).await;
    Ok(plugin)
}

/// Find the directory inside `root` that actually holds the plugin (its
/// `plugin.json`). Zipping a folder usually nests everything under a single
/// top-level dir (`my-plugin/plugin.json`), but a user may also zip the
/// folder's *contents* (`plugin.json` at the archive root). Handle both, plus
/// the macOS Finder case where a stray `__MACOSX/` sibling is present.
fn find_plugin_root(root: &std::path::Path) -> Option<std::path::PathBuf> {
    if root.join("plugin.json").is_file() {
        return Some(root.to_path_buf());
    }
    let mut real_dirs = Vec::new();
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        // Ignore the Finder metadata sibling that Compress adds.
        if name == std::ffi::OsStr::new("__MACOSX") {
            continue;
        }
        if path.is_dir() {
            real_dirs.push(path);
        }
    }
    if real_dirs.len() == 1 && real_dirs[0].join("plugin.json").is_file() {
        return Some(real_dirs.remove(0));
    }
    None
}

/// POST /api/v1/plugins/install-zip — accept an uploaded `.zip` (multipart field
/// `file`), extract it, locate the `plugin.json`, copy the plugin into
/// `~/.grove/plugins/<id>` and register it (source = "local"). Saves the user
/// from unzipping by hand. Same end state as `install_local`.
pub async fn install_zip(
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let mut zip_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(format!("invalid upload: {}", e)))?
    {
        if field.name() == Some("file") {
            zip_bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(format!("could not read upload: {}", e)))?
                    .to_vec(),
            );
        }
    }
    let zip_bytes = zip_bytes.ok_or_else(|| ApiError::bad_request("no `file` field in upload"))?;
    if zip_bytes.is_empty() {
        return Err(ApiError::bad_request("uploaded file is empty"));
    }

    let id = crate::storage::plugins::new_id();
    // Extract into a staging dir first, then promote the real plugin root into
    // its final id-named dir. Staging is always cleaned up.
    let staging = plugins_dir().join(format!("{}-staging", id));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| ApiError::internal(format!("could not create staging dir: {}", e)))?;

    let result = (|| {
        crate::storage::agent_install::extract_zip(&zip_bytes, &staging)
            .map_err(|e| ApiError::bad_request(format!("could not unzip: {}", e)))?;
        let plugin_root = find_plugin_root(&staging).ok_or_else(|| {
            ApiError::bad_request("no plugin.json found in the zip (expected at the root or in a single top-level folder)")
        })?;
        let (name, version) = read_manifest(&plugin_root)?;
        verify_entries_built(&plugin_root)?;
        let dest = plugins_dir().join(&id);
        copy_dir_recursive(&plugin_root, &dest)
            .map_err(|e| ApiError::internal(format!("failed to copy plugin: {}", e)))?;
        Ok::<_, (StatusCode, Json<ApiError>)>((name, version, dest))
    })();

    let _ = std::fs::remove_dir_all(&staging);
    let (name, version, dest) = result?;

    let plugin = crate::storage::plugins::upsert(
        &id,
        &name,
        &version,
        "local",
        &dest.display().to_string(),
        None,
        None,
    )
    .map_err(|e| ApiError::internal(format!("failed to register: {}", e)))?;
    sync_plugin_skills(&plugin.id, &plugin.name, &plugin.local_path);
    crate::plugins::backend::registered(&plugin).await;
    Ok(Json(json!({ "ok": true, "plugin": plugin })))
}

#[derive(Debug, Deserialize)]
pub struct InstallGitRequest {
    /// Git URL to clone.
    pub url: String,
    /// Optional subdirectory inside the repo that contains plugin.json.
    #[serde(default)]
    pub subpath: Option<String>,
}

/// POST /api/v1/plugins/install-git — clone a repo into `~/.grove/plugins/<id>`,
/// and register the plugin found at `<id>[/subpath]` (source = "git").
pub async fn install_git(
    Json(req): Json<InstallGitRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let url = req.url.trim();
    if url.is_empty() {
        return Err(ApiError::bad_request("git url must not be empty"));
    }
    let id = crate::storage::plugins::new_id();
    let clone_dir = plugins_dir().join(&id);

    git_clone(url, &clone_dir)?;

    // plugin.json is at the repo root, or inside subpath if given.
    let plugin_dir = match req.subpath.as_deref() {
        Some(sp) if !sp.trim().is_empty() => clone_dir.join(sp.trim()),
        _ => clone_dir.clone(),
    };
    let (name, version) = match read_manifest(&plugin_dir) {
        Ok(m) => m,
        Err(e) => {
            // Not a valid plugin — clean up the clone.
            let _ = std::fs::remove_dir_all(&clone_dir);
            return Err(e);
        }
    };
    // Imported plugins must ship their built dist/ — Grove never builds.
    if let Err(e) = verify_entries_built(&plugin_dir) {
        let _ = std::fs::remove_dir_all(&clone_dir);
        return Err(e);
    }

    let plugin = crate::storage::plugins::upsert(
        &id,
        &name,
        &version,
        "git",
        &plugin_dir.display().to_string(),
        Some(url),
        req.subpath.as_deref(),
    )
    .map_err(|e| ApiError::internal(format!("failed to register: {}", e)))?;
    sync_plugin_skills(&plugin.id, &plugin.name, &plugin.local_path);
    crate::plugins::backend::registered(&plugin).await;
    Ok(Json(json!({ "ok": true, "plugin": plugin })))
}

// ─── Permissions + file storage ──────────────────────────────────────────────

/// Read the `permissions` array from a plugin folder's manifest.
fn read_permissions_at(local_path: &str) -> Vec<String> {
    std::fs::read_to_string(std::path::Path::new(local_path).join("plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            v.get("permissions").and_then(|p| p.as_array()).map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Which contribution points a plugin declares, surfaced to the UI so it can
/// decide where the plugin can open: a workspace FlexLayout panel
/// (`contributes.panel`), a top-level sidebar page (`contributes.sidebar`), or
/// an MCP server (`contributes.mcp`). `sidebar` carries its display title/icon.
fn read_contributes_at(local_path: &str) -> serde_json::Value {
    let manifest = std::fs::read_to_string(std::path::Path::new(local_path).join("plugin.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| json!({}));
    let c = manifest.get("contributes");
    let panel = c.and_then(|c| c.get("panel"));
    let sidebar = c.and_then(|c| c.get("sidebar"));
    let mcp = c.and_then(|c| c.get("mcp")).is_some();
    let backend = c.and_then(|c| c.get("backend")).is_some();
    let connect_providers = c
        .and_then(|c| c.get("connectProviders"))
        .and_then(|value| value.as_array())
        .map(|providers| providers.len())
        .unwrap_or_default();
    json!({
        "panel": panel.map(|p| json!({
            "title": p.get("title").and_then(|v| v.as_str()),
            "side": p.get("side").and_then(|v| v.as_str()),
            "shortcut": p.get("shortcut").and_then(|v| v.as_str()),
        })),
        "sidebar": sidebar.map(|s| json!({
            "title": s.get("title").and_then(|v| v.as_str()),
            "icon": s.get("icon").and_then(|v| v.as_str()),
        })),
        "mcp": mcp,
        "backend": backend,
        "connectProviders": connect_providers,
    })
}

/// Declared permissions of a registered plugin (by id).
fn plugin_permissions(id: &str) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let plugin = crate::storage::plugins::get(id)
        .map_err(|e| ApiError::internal(format!("registry error: {}", e)))?
        .ok_or_else(|| ApiError::not_found(format!("plugin not found: {}", id)))?;
    Ok(read_permissions_at(&plugin.local_path))
}

/// Error out unless the plugin declares `perm` in its manifest permissions.
fn ensure_permission(id: &str, perm: &str) -> Result<(), (StatusCode, Json<ApiError>)> {
    if plugin_permissions(id)?.iter().any(|p| p == perm) {
        Ok(())
    } else {
        Err(ApiError::forbidden(format!(
            "plugin did not declare the \"{}\" permission",
            perm
        )))
    }
}

#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub content: String,
}

/// Scope selector shared by every storage endpoint: `global` (default, the
/// plugin's cross-project store), `project` (needs `projectId`), or `task`
/// (needs `projectId` + `taskId`). Ids are Grove's own (project path hash /
/// task id), passed by the frontend host. `path` carries the dir for listing.
#[derive(Debug, Deserialize)]
pub struct ScopeQuery {
    #[serde(default)]
    pub scope: String,
    #[serde(default, rename = "projectId")]
    pub project_id: Option<String>,
    #[serde(default, rename = "taskId")]
    pub task_id: Option<String>,
    #[serde(default)]
    pub path: String,
}

impl ScopeQuery {
    fn resolve(&self) -> Result<crate::storage::plugin_data::Scope, (StatusCode, Json<ApiError>)> {
        use crate::storage::plugin_data::Scope;
        match self.scope.as_str() {
            "" | "global" => Ok(Scope::Global),
            "project" => {
                let p = self.project_id.clone().ok_or_else(|| {
                    ApiError::bad_request("project scope requires projectId".to_string())
                })?;
                Ok(Scope::Project(p))
            }
            "task" => {
                let p = self.project_id.clone().ok_or_else(|| {
                    ApiError::bad_request("task scope requires projectId".to_string())
                })?;
                let t = self.task_id.clone().ok_or_else(|| {
                    ApiError::bad_request("task scope requires taskId".to_string())
                })?;
                Ok(Scope::Task(p, t))
            }
            other => Err(ApiError::bad_request(format!("unknown scope: {}", other))),
        }
    }
}

/// GET /api/v1/plugins/{id}/data/{*path}?scope=&projectId=&taskId= — read a
/// text file from the given storage scope. `{ "content": <string> | null }`.
pub async fn read_plugin_data(
    Path((id, rel)): Path<(String, String)>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "storage:read")?;
    let scope = q.resolve()?;
    let content = crate::storage::plugin_data::read_file(&id, &scope, &rel)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?;
    Ok(Json(json!({ "content": content })))
}

/// PUT /api/v1/plugins/{id}/data/{*path} — write a text file. Body: `{ content }`.
pub async fn write_plugin_data(
    Path((id, rel)): Path<(String, String)>,
    Query(q): Query<ScopeQuery>,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "storage:write")?;
    let scope = q.resolve()?;
    crate::storage::plugin_data::write_file(&id, &scope, &rel, &req.content)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?;
    Ok(Json(json!({ "ok": true })))
}

/// DELETE /api/v1/plugins/{id}/data/{*path} — delete a file.
pub async fn delete_plugin_data(
    Path((id, rel)): Path<(String, String)>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "storage:write")?;
    let scope = q.resolve()?;
    let removed = crate::storage::plugin_data::delete_file(&id, &scope, &rel)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?;
    Ok(Json(json!({ "ok": removed })))
}

/// GET /api/v1/plugins/{id}/data-dir?path=&scope=&projectId=&taskId= — list
/// entries under a dir in the given scope. Each entry is `{ name, isDir }` —
/// same shape as the /project/ listing.
pub async fn list_plugin_data(
    Path(id): Path<String>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "storage:read")?;
    let scope = q.resolve()?;
    let entries: Vec<serde_json::Value> = crate::storage::plugin_data::list(&id, &scope, &q.path)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?
        .into_iter()
        .map(|(name, is_dir)| json!({ "name": name, "isDir": is_dir }))
        .collect();
    Ok(Json(json!({ "entries": entries })))
}

/// GET /api/v1/plugins/{id}/data-bytes/{*path} — read a binary file as base64.
/// Returns `{ "content": <base64 string> | null }`.
pub async fn read_plugin_bytes(
    Path((id, rel)): Path<(String, String)>,
    Query(q): Query<ScopeQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    use base64::Engine;
    ensure_permission(&id, "storage:read")?;
    let scope = q.resolve()?;
    let bytes = crate::storage::plugin_data::read_bytes(&id, &scope, &rel)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?;
    let content = bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b));
    Ok(Json(json!({ "content": content })))
}

/// PUT /api/v1/plugins/{id}/data-bytes/{*path} — write a binary file from
/// base64. Body: `{ content: <base64 string> }`.
pub async fn write_plugin_bytes(
    Path((id, rel)): Path<(String, String)>,
    Query(q): Query<ScopeQuery>,
    Json(req): Json<WriteFileRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    use base64::Engine;
    ensure_permission(&id, "storage:write")?;
    let scope = q.resolve()?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(req.content.as_bytes())
        .map_err(|e| ApiError::bad_request(format!("invalid base64: {}", e)))?;
    crate::storage::plugin_data::write_bytes(&id, &scope, &rel, &bytes)
        .map_err(|e| ApiError::bad_request(format!("storage error: {}", e)))?;
    Ok(Json(json!({ "ok": true })))
}

// ─── contributes.backend (panel ↔ node backend RPC) ──────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInvokeRequest {
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    /// Optional per-call timeout (ms) for a slow backend op; clamped server-side.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// POST /api/v1/plugins/{id}/backend/invoke — call a method on the plugin's
/// node backend (`contributes.backend`). Body:
/// `{ method, params, projectId?, taskId? }`. With both ids the backend is
/// task-scoped (gets that task's project fs access); without, it's app-scoped.
///
/// No per-call permission gate: the backend already runs with runtime access
/// derived from the manifest, so the manifest is the single source of truth.
pub async fn backend_invoke(
    Path(id): Path<String>,
    Json(req): Json<BackendInvokeRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let task = match (req.project_id.as_deref(), req.task_id.as_deref()) {
        (Some(p), Some(t)) => Some((p, t)),
        _ => None,
    };
    let result =
        crate::plugins::backend::invoke(&id, task, &req.method, req.params, req.timeout_ms)
            .await
            .map_err(|e| ApiError::bad_request(format!("backend invoke failed: {}", e)))?;
    Ok(Json(json!({ "result": result })))
}

// ─── exec (grove.exec — Grove-mediated command execution) ─────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub project_id: String,
    pub task_id: String,
}

/// POST /api/v1/plugins/{id}/exec — run a command in the current task's working
/// directory, streaming NDJSON output (`{type:"stdout"|"stderr"|"exit"|"error"}`).
/// Requires the high-risk `exec` permission (≈ full machine trust).
pub async fn exec_command(
    Path(id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Result<axum::response::Response, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "exec")?;
    let root = resolve_task_root(&req.project_id, &req.task_id)?;
    let cwd = root.display().to_string();
    let rx = crate::plugins::exec::run(req.command, req.args, cwd);
    let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
    let body = axum::body::Body::from_stream(stream);
    Ok(([(header::CONTENT_TYPE, "application/x-ndjson")], body).into_response())
}

// ─── events (plugin event bus: MCP/backend → panel) ──────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsSubscribeQuery {
    #[serde(default)]
    pub task_id: Option<String>,
}

/// GET /api/v1/plugins/{id}/events/subscribe?taskId= — SSE stream of events for
/// (plugin, task). The host (`PluginFrame`) opens this and relays each event
/// into the sandboxed panel iframe; the panel never opens it directly.
pub async fn subscribe_events(
    Path(id): Path<String>,
    Query(q): Query<EventsSubscribeQuery>,
) -> axum::response::Response {
    use futures::StreamExt;
    let task = q.task_id.unwrap_or_else(|| "global".to_string());
    // A plugin only joins the task-scoped radio/ACP firehose if it declared
    // `chat:read`; otherwise it still gets its own backend/MCP `emit` events.
    let radio = plugin_permissions(&id)
        .map(|perms| perms.iter().any(|p| p == "chat:read"))
        .unwrap_or(false);
    let rx = crate::plugins::events::subscribe(&id, &task, radio);
    let stream =
        tokio_stream::wrappers::UnboundedReceiverStream::new(rx).map(Ok::<String, std::io::Error>);
    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmitEventRequest {
    pub name: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default)]
    pub task_id: Option<String>,
}

/// Constant-time string equality, to avoid leaking the events token via timing.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// POST /api/v1/plugins/{id}/events — emit an event from a plugin's MCP server
/// (its stdio is the agent channel, so it calls back over HTTP). Authenticated
/// by the per-process events token (`X-Grove-Events-Token`) — a node child
/// process isn't a normal Grove client. The backend emits in-process instead.
pub async fn emit_event(
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
    Json(req): Json<EmitEventRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let token = headers
        .get("x-grove-events-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ct_eq(token, crate::plugins::events::token()) {
        return Err(ApiError::forbidden("invalid events token".to_string()));
    }
    let task = req.task_id.unwrap_or_else(|| "global".to_string());
    crate::plugins::events::publish(&id, &task, &json!({ "name": req.name, "data": req.data }));
    Ok(Json(json!({ "ok": true })))
}

// ─── chat (grove.chat — list sessions, inject prompts) ───────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatListQuery {
    pub project_id: String,
    pub task_id: String,
}

/// GET /api/v1/plugins/{id}/chat/list?projectId=&taskId= — the task's chat
/// sessions. Requires `chat:read`. (`projectId` from the client is already the
/// project hash, i.e. the storage `project_key`.)
pub async fn chat_list(
    Path(id): Path<String>,
    Query(q): Query<ChatListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "chat:read")?;
    let chats = crate::storage::tasks::load_chat_sessions(&q.project_id, &q.task_id)
        .map_err(|e| ApiError::internal(format!("failed to load chats: {}", e)))?;
    let chats: Vec<serde_json::Value> = chats
        .into_iter()
        .map(|c| {
            json!({
                "id": c.id,
                "title": c.title,
                "agent": c.agent,
            })
        })
        .collect();
    Ok(Json(json!({ "chats": chats })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSendRequest {
    pub project_id: String,
    pub task_id: String,
    pub chat_id: String,
    pub text: String,
}

/// POST /api/v1/plugins/{id}/chat/send — inject a user prompt into a chat's ACP
/// session, spawning it on demand. Wrapped in a `plugin_inject` grove-meta
/// envelope so the chat shows the message came from this plugin. Requires
/// `chat:write`.
///
/// Delivery (spawn-on-demand + busy/queue + send) is delegated wholesale to
/// `agent_graph::user_ops::user_send_message` — the same path the Agent Graph
/// uses for a user-initiated send — so none of that logic is duplicated here.
pub async fn chat_send(
    Path(id): Path<String>,
    Json(req): Json<ChatSendRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    ensure_permission(&id, "chat:write")?;
    if req.text.trim().is_empty() {
        return Err(ApiError::bad_request("text must not be empty"));
    }
    // Plugin display name for the injected pill; fall back to the id.
    let plugin_name = crate::storage::plugins::get(&id)
        .ok()
        .flatten()
        .map(|p| p.name)
        .unwrap_or_else(|| id.clone());
    let body = crate::agent_graph::inject::build_plugin_inject_prompt(&id, &plugin_name, &req.text);
    crate::agent_graph::user_ops::user_send_message(
        &req.project_id,
        &req.task_id,
        &req.chat_id,
        &body,
    )
    .await
    .map_err(|e| ApiError::bad_request(format!("could not deliver prompt: {}", e)))?;
    Ok(Json(json!({ "ok": true })))
}
