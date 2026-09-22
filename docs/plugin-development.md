# Grove Plugins — Developer Guide

A Grove plugin is a folder with a `plugin.json` manifest. It can contribute a
**panel**, a **sidebar page**, **skills**, an **MCP server**, and/or a **node
backend**, and reads context + persists data through a **typed SDK**.

## Quick start

**Settings → Plugins → Develop Plugin** → name it → pick a folder. Grove
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
drop that into Grove → Settings → Plugins → Add → From Local. For a git install,
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
│   └── grove-sdk/       # vendored SDK — refresh via Settings → Plugins → Update SDK
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

## Panel SDK — `grove` (typed)

Import from `src/grove-sdk` in your panel code. Every call is a typed Promise.
The panel runs in a **fully isolated** sandboxed iframe (opaque origin) — it
cannot touch Grove or the filesystem except through this SDK.

```ts
import { grove } from "./grove-sdk";

const info = await grove.host.getInfo();
// { projectId, projectName, projectType: "repo"|"studio"|null, taskId }
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

### Theme

The SDK applies Grove's theme to your `:root` automatically (so `var(--color-bg)`
etc. match Grove and follow theme switches). `grove.theme.getColors()` /
`isLight()` / `onChange(cb)`.

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
| `panel` | Workspace panel (task-scoped) | task toolbar `[+]` menu, or its keybinding |
| `sidebar` | Top-level page (app-scoped) | the sidebar nav entry |

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
| `connect:provider` | access owned Connect records and deliver external messages | ⚠ high |
| `exec` | run commands (`grove.exec` / `child_process`) | ⚠⚠ full machine trust |

A plugin can only use what it declares; high-risk permissions are flagged in the
plugin list and confirmed on install. Network access is **not** a Grove
permission — Node's model can't enforce it, so Grove doesn't pretend to.

## Keybindings

A `panel.shortcut` (or the user, in Settings → Shortcuts) binds a key to
`panel.plugin:<id>.open` — added on install, removed on uninstall.

## Installing

From **Settings → Plugins**:

- **Develop** — scaffold a new plugin (dev).
- **Add → From Local** — drop a `.zip` or pick a folder (copied into Grove).
- **Add → From Git** — clone a repo (optional subpath).
- **Add → Dev folder** — reference a folder in place (hot-reload).

`local`/`git` plugins live under `~/.grove/plugins/<id>` (files removed on
uninstall); `dev` plugins reference your folder, which Grove does not delete.
Uninstall also removes the plugin's Grove-managed data and IM Connect records.
