# Grove Plugins — Developer Guide

A Grove plugin is a folder with a `plugin.json` manifest. It can contribute a
**panel**, a **sidebar page**, **skills**, an **MCP server**, and/or a **node
backend**, and reads context + persists data through a **typed SDK**.

## Quick start

**Extensions → Add → Plugin → Create new** → name it → pick a folder. Grove
scaffolds a vite + TypeScript project and registers it as a *dev* plugin. Then:

```
npm install      # install dev deps
npm run dev      # watch + rebuild panel AND server/backend — hit Reload in the panel
npm run build    # clean production build (panel + any server/backend)
npm run publish  # build + verify + package <name>-<version>.zip, ready to ship
```

`npm run publish` (or `make publish`) is the last step before distribution: it
checks every declared entry is built, then zips the install-only files
(`plugin.json` + `dist/` + `skills/` + `docs/`) into `<name>-<version>.zip` —
drop that into Grove → Extensions → Add → Plugin → Local package. For a git install,
just commit `dist/`. The panel entry is `dist/index.html`.

> **Node 24+ required for backends.** A plugin that ships an MCP server or a
> node backend runs with manifest-derived runtime access. Scoped permissions use
> Node's Permission Model (stable in node 24); `exec` grants full machine trust.
> Grove **refuses to launch** such a process on older node. Pure-panel plugins
> have no node requirement (they run in the browser).

## Anatomy

```
my-plugin/
├── plugin.json          # manifest
├── package.json · vite.config.ts · Makefile · tsconfig.json
├── index.html           # vite entry
├── src/
│   ├── main.ts          # your panel UI
│   ├── shared.ts        # types/constants shared by panel + MCP/backend
│   └── grove-sdk/       # vendored SDK — refresh via Extensions → your plugin → Manage → Update SDK
│       ├── index.ts     # panel SDK     → import { grove } from "./grove-sdk"
│       ├── mcp.ts       # MCP SDK       → import { grove } from "./grove-sdk/mcp"
│       └── backend.ts   # backend SDK   → import { … } from "./grove-sdk/backend"
├── dist/                # built, shipped output
├── skills/              # each subfolder with a SKILL.md → a Grove skill
└── docs/
```

## Manifest (`plugin.json`)

```jsonc
{
  "name": "my-plugin",
  "version": "0.1.0",
  "icon": "icon.png",
  "permissions": ["storage:read", "storage:write", "project:read"],
  "contributes": {
    "panel":   { "title": "My Plugin", "entry": "dist/index.html", "side": "right", "shortcut": "Mod+Alt+p" },
    "sidebar": { "title": "My Plugin", "entry": "dist/index.html" },
    "mcp":     { "command": "node", "args": ["dist/server.js"], "env": { "FOO": "bar" } },
    "backend": { "command": "node", "args": ["dist/backend.js"] }
  }
}
```

- **icon** *(optional)* — a square image shipped in the plugin (`"icon.png"`,
  `"assets/icon.svg"`; served via `/asset`) or an emoji (`"🧩"`). Shown in the
  sidebar, panel tab, and plugin list. Omit for a default puzzle glyph.
- **permissions** — what the SDK / node processes are allowed to do (see
  *Permissions*).
- **contributes.panel** — a workspace panel (task-scoped). `side`: `"left"`
  (aux) or `"right"` (info) column in IDE Layout. `shortcut`: optional default
  keybinding, user-reconfigurable in Settings → Shortcuts.
- **contributes.sidebar** — a top-level page (app-scoped).
- **contributes.mcp** — a stdio MCP server exposing tools to the **AI agent**.
- **contributes.backend** — a node process that can serve a panel, subscribe to
  Grove events, run workflows, or implement a Connect Provider. Independent of
  `mcp`: ship either, both, or neither.
- **contributes.connectProviders** — optional IM Provider metadata. It requires
  `contributes.backend` and the `connect:provider` permission; it does not start
  another process.
- **contributes.promptMiddleware** — optional `submit` and/or `dispatch` Prompt
  hooks. Uses the same backend process; requires `prompt:middleware`.

## Panel SDK — `grove` (typed)

Import from `src/grove-sdk` in your panel code. Every call is a typed Promise.
The panel runs in a **fully isolated** sandboxed iframe (opaque origin) — it
cannot touch Grove or the filesystem except through this SDK.

```ts
import { grove } from "./grove-sdk";

const info = await grove.host.getInfo();
// { projectId, projectName, projectType: "repo"|"studio"|null, taskId,
//   interface: "orbit"|"workbench" }   ← interface: absent on older Grove
```

### Storage — three scopes, KV + files

Each scope (`global` / `project` / `task`) has both a KV store (auto-JSON) and
file operations. Requires `storage:read` / `storage:write`.

```ts
// KV (the easy path)
await grove.storage.global.set("apiKey", "sk-…");   // cross-project
const key = await grove.storage.global.get<string>("apiKey");
await grove.storage.project.set("config", { theme: "dark" });  // this project
await grove.storage.task.set("draft", { body: "…" });          // this task only

// Files (when you need paths, binary, or listing)
await grove.storage.project.writeFile("cache/index.json", JSON.stringify(x));
const text  = await grove.storage.project.readFile("cache/index.json"); // string | null
const names = await grove.storage.project.list("cache");               // { name, isDir }[]
await grove.storage.task.writeBytes("thumb.png", bytes);               // Uint8Array
```

| Scope | Lives as long as | Use for |
|---|---|---|
| `global` | the plugin is installed | user prefs, auth tokens |
| `project` | the project exists | config, index caches |
| `task` | the task exists | drafts, transient state |

### Project files — read the current task

`project:read`, workspace panel only. Read-only.

```ts
const src = await grove.project.readFile("src/main.rs");   // string | null
const dir = await grove.project.list("src");               // { name, isDir }[]
```

### Chat — list sessions & inject prompts

Workspace panels only. The host scopes every call to **this panel's task** — a
plugin can't drive another task's agent.

```ts
// chat:read — the task's chat sessions, and which one the user has focused.
const chats = await grove.chat.list();          // ChatInfo[] {id,title,agent}
const active = grove.chat.activeChatId();        // string | null (read at call time)

// chat:write — inject a user prompt into a chat's agent (spawns the session on
// demand). It appears in the chat as a message from your plugin.
if (active) await grove.chat.sendPrompt({ chatId: active, text: "run the tests" });
```

> `chat:write` lets the plugin *drive the AI*; `chat:read` lets it *observe the
> AI's activity* (see `grove:radio` under Events). Both are flagged high-risk.

### exec — run a command (high-risk)

Stream a command's output from the task's working directory. Requires the
`exec` permission.

```ts
for await (const ev of grove.exec("go", ["test", "./..."])) {
  if (ev.type === "stdout") console.log(ev.line);
  else if (ev.type === "exit") console.log("exit", ev.code);
}
```

> `exec` is the **nuclear** permission: a spawned OS process is unsandboxable,
> so granting it is effectively full machine trust. Grove locks the working
> directory to the task root and caps runtime, but those are guardrails, not a
> security boundary. Use it only when you must.

### Backend — call your node process

If the plugin contributes a backend, the panel calls its methods:

```ts
const result = await grove.backend.invoke<{ rows: number }>("query", { sql: "…" });
```

### Theme, interface and Orbit tokens

Grove has two interfaces: **Orbit** (the redesigned UI) and **Workbench** (the
classic one). The user picks one in Settings → General → Interface. The SDK
applies the current look to your `:root` automatically and keeps it live on
every theme or interface switch:

| On your page | What it is |
|---|---|
| `--color-bg`, `--color-text`, `--color-text-muted`, `--color-border`, `--color-highlight`, … | the theme palette (unchanged since the first SDK) |
| `--o-*` (same names as Grove's own `orbit/tokens.css`) | the Orbit design tokens, resolved by Grove from the live document |
| `<html data-grove-interface="orbit\|workbench">` | which interface is showing |
| `<html data-grove-theme="light\|dark">` | the theme's mode |

The Orbit tokens:

| Group | Tokens |
|---|---|
| Surfaces & text | `--o-bg`, `--o-text`, `--o-muted`, `--o-group` (card fill), `--o-code`, `--o-frost`, `--o-track` |
| Lines & states | `--o-border`, `--o-border-strong`, `--o-hover`, `--o-selected`, `--o-ring-selected` |
| Accent & status | `--o-accent`, `--o-accent-soft`, `--o-success`, `--o-warn`, `--o-error`, `--o-info` |
| Buttons | `--o-ink` / `--o-on-ink` (primary = ink fill), `--o-on-accent` |
| Elevation | `--o-shadow`, `--o-shadow-1` (cards), `--o-shadow-2` (popovers) |
| Radii | `--o-radius-xs` 6 · `--o-radius-sm` 7 · `--o-radius` 8 · `--o-radius-md` 10 · `--o-radius-lg` 12 |
| Type | `--o-font-sans` (Grove's UI font), `--o-font-mono` |
| Motion | `--o-ease-out`, `--o-ease-pop`, `--o-ease-slide`, `--o-ease-toggle`, `--o-ease-draw`, `--o-ease-reflow`, `--o-dur-fast`, `--o-dur-*`, `--o-stagger` |

Grove sends the tokens under **both** interfaces. They derive from the active
theme, so a plugin styled only with `--o-*` looks native in Orbit and still
right in Workbench. Use `data-grove-interface` for the few things you want to
differ:

```css
body { margin: 0; font: 13px/1.5 var(--o-font-sans); background: var(--o-bg); color: var(--o-text); }
.card { border: 1px solid var(--o-border); border-radius: var(--o-radius-lg);
        background: var(--o-group); box-shadow: var(--o-shadow-1); }
.row:hover { background: var(--o-hover); }
.row.is-selected { background: var(--o-selected); }
.btn-primary { background: var(--o-ink); color: var(--o-on-ink); border-radius: var(--o-radius); }
/* Workbench's primary buttons use the accent colour. */
[data-grove-interface="workbench"] .btn-primary { background: var(--color-highlight); color: #fff; }
```

The same values in code:

```ts
grove.theme.getColors();     // ThemeColors | null — the --color-* palette
grove.theme.isLight();       // boolean
grove.theme.getInterface();  // "orbit" | "workbench"
grove.theme.getTokens();     // { "--o-bg": "#fff", "--o-radius": "8px", ... }
const off = grove.theme.onChange((t) => {
  // t: { id, isLight, colors, interface, tokens } — fires on theme AND interface changes
  chart.setDark(!t.isLight);
});
```

Token values are self-contained (`var()` references already substituted);
colours can be `color-mix(...)` expressions, which every engine Grove runs on
supports.

**Compatibility**

- *Old plugin, new Grove.* An SDK vendored before this change still gets
  `id` / `isLight` / `colors` exactly as before and ignores the new fields. It
  doesn't get `--o-*` or `data-grove-interface`; run **Update SDK** and rebuild
  to opt in.
- *New plugin, older Grove.* A Grove that doesn't send `interface` / `tokens`
  reports `getInterface() === "workbench"` and `getTokens()` returns `{}`. The
  SDK ships a fallback stylesheet that derives every `--o-*` token from
  `--color-*` the same way Grove does, so `var(--o-*)` styles still render. The
  fallback is the first `<style>` in `<head>`, so your own CSS can override it;
  the host's resolved values (inline on `:root`) override both.
- The scaffolded starter (`src/main.ts`) is styled this way: Orbit card,
  button and empty-state styles on the `--o-*` tokens.

### Navigation — open your page or Settings

`grove.navigate(target)` moves Grove to one of two places and resolves
`{ ok: true }` once it has:

```ts
// Your own top-level page (needs contributes.sidebar), e.g. a panel's
// "Open full view" button.
await grove.navigate({ to: "plugin-page" });

// Grove's Settings, optionally at a section.
await grove.navigate({ to: "settings" });
await grove.navigate({ to: "settings", section: "appearance" });
```

| Target | Opens | Notes |
|---|---|---|
| `{ to: "plugin-page" }` | This plugin's `contributes.sidebar` page | Always your own plugin: the host takes the id from your frame, never from the call |
| `{ to: "settings", section? }` | Settings | `section`: `agents`, `general`, `appearance`, `notifications`, `shortcuts`, `worktrees`, `voice`, `vcontrol`, `avoice`, `providers`, `system` |

Failures reject with a `GroveError`, so branch on `code`:

```ts
try {
  await grove.navigate({ to: "plugin-page" });
} catch (e) {
  if (e instanceof GroveError && e.code === "not_found") {
    // This plugin has no page (no contributes.sidebar).
  }
}
```

| `code` | When |
|---|---|
| `bad_request` | Unknown `to`, or a `section` Settings doesn't have |
| `not_found` | `plugin-page` but the plugin has no page |
| `forbidden` | The frame isn't on screen (a background tab, a hidden window): a plugin can only navigate while the user is looking at it |
| `unavailable` | The surface has no app shell to navigate (shouldn't happen in the web or desktop app) |
| `unknown_method` | Grove is older than this API |

Interfaces:

- **Orbit** opens the page or the Settings section directly. Settings also
  accepts the older Workbench section ids (`terminal`, `layout`, `autolink`,
  `indexing`, `browserControl`, `chat`) and lands where they live now.
- **Workbench** opens your page the same way. Settings opens at the top: the
  Workbench settings page has no deep links, so `section` is validated but not
  scrolled to.

Navigation is panel-only: the MCP and backend sides of the SDK don't have it.

### Utilities

`grove.util.uuid()` returns a collision-free UUID (wraps `crypto.randomUUID()`).
Available identically on the panel and MCP/backend sides — don't hand-roll one
from `Date.now()`/`Math.random()`.

### Sharing code between panel and server

The panel (browser build) and a server (node build) are separate bundles, but
they can `import` the same source. Put shared **types and constants** in
`src/shared.ts` and import from both — define them once instead of copy-pasting:

```ts
// src/shared.ts
export const STATE_KEY = "state";
export interface PluginState { count: number }

// src/main.ts (panel)            // src/server.ts (MCP)
import { STATE_KEY, type PluginState } from "./shared";
const s = await grove.storage.global.get<PluginState>(STATE_KEY);
```

The scaffold ships a `src/shared.ts` wired into `src/main.ts` as a starting point.

## MCP SDK — same `grove` API

Your MCP server uses the **same `grove` API** as the panel (from
`src/grove-sdk/mcp`) — identical shape, transport hidden.

```ts
import { grove } from "./grove-sdk/mcp";

const info  = await grove.host.getInfo();   // + taskName, branch
const src   = await grove.project.readFile("src/main.rs");
await grove.storage.global.set("token", "…");
```

### Real filesystem — `grove.paths`

The MCP server is a **host process with real filesystem access**, so for
anything heavier — a SQLite db, appended writes, search — use `grove.paths.*`
(raw dirs) with native Node libraries:

```ts
import { grove } from "./grove-sdk/mcp";
import { DatabaseSync } from "node:sqlite";      // built-in — no native addon
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

// A SQLite db in your global storage scope:
const db = new DatabaseSync(join(grove.paths.storage.global, "data.sqlite"));

// Incremental write (no full rewrite):
await appendFile(join(grove.paths.storage.global, "log.ndjson"), line + "\n");
```

`grove.paths` = `{ storage: { global, project, task }, project, plugin }`.
(The **panel** has no equivalent — it's an isolated iframe; do heavy data work
in the MCP server or backend, and have the panel read results via the SDK.)

Prefer Node's built-in **`node:sqlite`** over native addons like
`better-sqlite3`: the permission model blocks native addons by default, and the
built-in needs no `--allow-addons`. Running external tools (ripgrep, git) needs
the `exec` permission; plain fs does not.

### Testing a server offline

The SDK reads its context from the `GROVE_CONTEXT` env var that Grove injects.
To run a server **without launching Grove**, set it yourself — point storage at
a scratch dir and pipe a JSON-RPC line in:

```sh
export GROVE_CONTEXT='{"storage":{"global":"/tmp/p","project":null,"task":null},"projectDir":"'"$PWD"'","pluginDir":"'"$PWD"'","projectId":null,"taskId":null}'
echo '{"id":1,"method":"ping","params":{}}' | node dist/backend.js
```

`grove.storage.*` then reads/writes under `/tmp/p`, and `grove.paths.*` resolve
to the dirs you passed — enough to exercise handlers before wiring into Grove.

## Backend (`contributes.backend`)

A backend is a node process connected to Grove over bidirectional stdio. It can
serve panel RPC, subscribe to Grove events, and call host APIs such as
`grove.connect`. It has the **same `grove`** context/storage/paths as the MCP
server. Task-scoped processes are reaped when idle; the app-scoped backend stays
available for events and external integrations.

```ts
// src/backend.ts → built to dist/backend.js
import { grove, registerHandler, serve } from "./grove-sdk/backend";

registerHandler("query", async ({ sql }: { sql: string }) => {
  const dir = grove.paths.storage.project;
  // …run the query, return JSON-serializable data…
  return { rows: 42 };
});

serve();   // read stdin / write stdout — call once, after registering handlers
```

> stdout is the RPC channel — log with `console.error` (stderr), which Grove
> forwards to its log. A `console.log` would corrupt the protocol.
>
> Handlers run **concurrently** (each invoke is dispatched as it arrives), so if
> two can mutate the same file/KV key, serialize that yourself (e.g. an in-flight
> promise chain) — Grove doesn't queue calls for you.

### Prompt middleware

Declare the phases you implement in `plugin.json`:

```json
{
  "permissions": ["prompt:middleware", "chat:read"],
  "contributes": {
    "backend": { "command": "node", "args": ["dist/backend.js"] },
    "promptMiddleware": ["submit", "dispatch"]
  }
}
```

Register handlers before `serve()`:

```ts
import { grove, registerPromptMiddleware, serve } from "./grove-sdk/backend";

registerPromptMiddleware({
  submit: async ({ text }) => ({ allow: true, text: text.trim() }),
  dispatch: async ({ text }) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000;
    const { totalTokens } = await grove.usage.totalTokens(start, end);
    const budget = 10000; // Replace with your plugin's calorie-derived budget.
    return totalTokens >= budget
      ? { allow: false, reason: "Exercise more before your next Prompt." }
      : { allow: true, text };
  },
});
serve();
```

`submit` runs before admission to the immediate-send path or queue, including
queue edits. `dispatch` runs when the Prompt command reaches ACP, including
auto-sent queued messages. An ACP authentication retry reuses the first
`dispatch` result instead of invoking the hook twice. Both receive `{ projectId, taskId, chatId,
messageIds, text, sender }`. Return `{ allow: true, text? }` to continue (omit
`text` to keep it unchanged), or `{ allow: false, reason }` to reject. Only text
can be changed; Grove retains attachments, sender, message IDs, and config.
Hooks run in plugin installation order, passing modified text onward. A rejection,
backend failure, or timeout fails that Prompt visibly; it does not bypass the
hook. `grove.usage.totalTokens(fromTs, toTs)` requires `chat:read`, accepts a
half-open Unix-second interval, and sums recorded usage across Grove. It does
not reserve tokens for concurrent turns.
Completion observation remains on
`grove:radio`; there is no output middleware.

## Events (Grove, backend, and panel)

When a tool or backend method changes data, push an event so the panel
refreshes — no polling, no manual reload. A task-scoped event reaches that
task's panel; an app-scoped backend event reaches all open surfaces of its
plugin, including task panels and the sidebar.

Type the payload once in `src/shared.ts` and pass it as the type arg on both
sides — `emit` and `on` are generic, so the compiler checks both ends:

```ts
// src/shared.ts
export interface CasesChanged { count: number }

// MCP server / backend — after mutating data:
grove.events.emit<CasesChanged>("cases-changed", { count: cases.length });

// panel — `d` is typed { count: number }:
grove.events.on<CasesChanged>("cases-changed", (d) => reload(d.count)); // returns unsubscribe
```

Directions: **backend ⇄ panel** is full duplex (panel → backend via
`grove.backend.invoke`, backend → panel via events). Grove also pushes its own
events into the backend. **MCP → panel** is emit-only because the MCP process's
stdio belongs to the agent protocol. `emit` is fire-and-forget; no transport
setup is required.

### `grove:radio` — Grove's own agent activity (chat:read)

Both a panel and a backend can subscribe to the reserved `grove:radio` stream:
Grove's aggregated, task-scoped agent/chat activity — the same signal the Radio
phone and menubar tray consume. Requires `chat:read`.

```ts
grove.events.on("grove:radio", (e) => {
  // e is a tagged RadioEvent: e.type is "chat_status" | "task_busy" | ...
  // chat_status carries status / prompt / final message / todo progress, etc.
  if (e.type === "chat_status") refresh(e);
});
```

The backend receives Radio without a panel being open. A plugin may use it to
refresh UI, update its own database, trigger a workflow, or translate Grove
Session activity for an external service. Radio is a live event stream, not a
durable queue; do not assume replay after the plugin process was offline.
Grove starts an event-consuming backend when its plugin is installed or
registered, and starts installed backends again when Grove starts.

## IM Connect Provider

A Connect Provider is a use of the normal plugin backend, not a separate Grove
runtime. Grove supplies registration/configuration, Session delivery, and
events. Your backend owns the external platform connection — OAuth, webhook,
socket, long polling, signature validation, retries, and acknowledgements.

Declare the backend, permission, and Provider metadata:

```jsonc
{
  "permissions": ["connect:provider", "chat:read"],
  "contributes": {
    "backend": { "command": "node", "args": ["dist/backend.js"] },
    "connectProviders": [{
      "id": "example",
      "name": "Example IM",
      "setup_modes": ["form"], // "qr" / "oauth" are also supported
      "config_fields": [
        { "key": "token", "label": "Token", "secret": true, "required": true }
      ]
    }]
  }
}
```

`config_fields` only describes Grove's form. `secret` selects a masked input
and hides the saved value from the UI; the stored `config` remains opaque JSON.
Grove does not assign credential semantics or create a separate key store.
Grove constructs the OAuth/QR `callbackUrl` and passes it to the backend. For a
flow completed on another device, set `GROVE_PUBLIC_BASE_URL` to the Grove
server address reachable by that device; the default is local loopback.

The backend reads and updates only records owned by its own Providers:

```ts
import { grove, registerConnectProvider, serve } from "./grove-sdk/backend";
```

For QR or OAuth registration, attach optional handlers to the same backend:

```ts
registerConnectProvider({
  async registrationBegin({ providerId, id, callbackUrl }) {
    // Use providerId if this plugin contributes more than one Provider.
    return { state: "waiting_for_scan", verificationUrl: makeAuthUrl(id, callbackUrl) };
  },
  async registrationCallback({ request }) {
    const config = await finishOAuth(request);
    return { state: "authorized", config, response: { status: 200, body: "Connected" } };
  },
});
```

For form setup, Grove writes the form values directly to the Provider's Connect
record; no registration handler is required.

After `serve()` starts the bidirectional channel, deliver an external message
or card action into its configured Grove Session from your external transport
handler:

```ts
await grove.connect.deliverMessage(connectionId, {
  externalMessageId: message.id,
  conversationId: message.chatId,
  senderId: message.userId,
  text: message.text,
});

const result = await grove.connect.deliverAction(connectionId, {
  conversationId: action.chatId,
  senderId: action.userId,
  sourceMessageId: action.messageId,
  name: action.name,
  fields: action.fields,
});
```

Subscribe to Grove output through ordinary events. `grove:connect` is the
connection-targeted stream for replying to an external conversation;
`grove:radio` is the general task activity stream and may also drive unrelated
plugin workflows:

```ts
grove.events.on("grove:radio", event => {
  // Session status, completed turns, Permission, Form, and other agent activity.
});

grove.events.on("grove:connect", event => {
  // Connect record changes and direct text/card/status output for this Provider.
});

serve();

const records = await grove.connect.records.list();
const record = await grove.connect.records.get(records[0].id);
await grove.connect.records.update(record.id, { ...record.config, token: "new-value" });
```

There is deliberately no Grove platform-message webhook. Once your backend has
a record, it chooses how to connect to the external platform and calls
`deliverMessage` / `deliverAction` when something should enter Grove.

## Where a plugin opens

| Contribution | Surface | How to open |
|---|---|---|
| `panel` | Workspace panel (task-scoped) | Workbench: task toolbar `[+]` menu. Orbit: the workspace toolbar / panel picker. Either: its keybinding |
| `sidebar` | Top-level page (app-scoped) | Workbench: the sidebar nav entry. Orbit: sidebar **More** group, or ⌘K "Go to <title>" |

In Orbit a sidebar page opens inside Orbit's page frame: a page header with the
plugin's `icon` and `contributes.sidebar.title` (or its name), and your UI edge
to edge below it, so don't draw a second title bar. A panel sits in Orbit's
panel frame (glyph tile with your icon, title, ⋯ menu; a dev plugin's **Reload**
is in that ⋯ menu). Size your layout to the frame, not the window.

A plugin can move Grove to exactly two places, through `grove.navigate` (see
[Navigation](#navigation--open-your-page-or-settings)): its **own** page and
Grove's Settings. It can't open another plugin's page, other panels or a URL.
The only ids a plugin declares are its own (`plugin:<id>` for its page,
`panel.plugin:<id>.open` for its keybinding).

## Skills

Each subfolder under `skills/` that contains a `SKILL.md` (with `name` /
`description` frontmatter) is mounted into Grove's Skill module as the source
`plugin:<id>` — added on install, removed on uninstall.

## MCP tools

Declare `contributes.mcp` to expose tools to the AI agent. Just add
`src/server.ts` (import from `./grove-sdk/mcp`) — the scaffold's build bundles it
to `dist/server.js` automatically (via `scripts/build-server.mjs`), in both
`npm run dev` (watched) and `npm run build`. Then declare:

```jsonc
"mcp": { "command": "node", "args": ["dist/server.js"] }
```

- The build never wipes your server bundle — `vite` (panel) and `esbuild`
  (server) share `dist/` without clobbering (`emptyOutDir: false`).
- Relative paths in `command`/`args` resolve against the plugin folder.
- `command` must be on the user's PATH (e.g. `node`); the plugin list warns if
  it's missing, or if node is older than 24.
- Get context via the `grove` SDK, not env.

## Permissions

Permissions are **enforced**, not advisory. The panel iframe is isolated
(opaque origin) so the SDK is its only channel. Node processes (mcp / backend)
use Node's Permission Model for scoped permissions. Declaring `exec` disables
that model for the process because an arbitrary child process can already access
the full machine; this also prevents Node from propagating parent filesystem
restrictions into external Node/shebang CLIs.

| Permission | Grants | Risk |
|---|---|---|
| `storage:read` | read the plugin's storage (all scopes) | — |
| `storage:write` | write the plugin's storage | — |
| `project:read` | read the current task's working dir | — |
| `project:write` | write the current task's working dir | ⚠ high |
| `chat:read` | list chats + receive `grove:radio` agent activity | ⚠ high |
| `chat:write` | inject prompts into a chat's agent (`grove.chat.sendPrompt`) | ⚠ high |
| `prompt:middleware` | inspect, reject, or modify Prompt text before ACP | ⚠ high |
| `connect:provider` | access owned Connect records and deliver external messages | ⚠ high |
| `exec` | run commands (`grove.exec` / `child_process`) | ⚠⚠ full machine trust |

A plugin can only use what it declares; high-risk permissions are flagged in the
plugin list and confirmed on install. Network access is **not** a Grove
permission — Node's model can't enforce it, so Grove doesn't pretend to.

## Keybindings

A `panel.shortcut` (or the user, in Settings → Keyboard Shortcuts) binds a key to
`panel.plugin:<id>.open` — added on install, removed on uninstall.

## Installing

From **Extensions → Add → Plugin** (same place in Orbit and Workbench):

- **Create new** — scaffold a new plugin (dev).
- **Local package** — drop a `.zip` or pick a folder (copied into Grove).
- **Git repository** — clone a repo (optional subpath).
- **Development folder** — reference a folder in place (hot-reload).

`local`/`git` plugins live under `~/.grove/plugins/<id>` (files removed on
uninstall); `dev` plugins reference your folder, which Grove does not delete.
Uninstall also removes the plugin's Grove-managed data and IM Connect records.
