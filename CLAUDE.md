# Grove - Project Guide

## What Grove Is

Grove is a **Context Harness** built on an **AI-native OS**.

**Two layers.**
- **AI-native OS (mechanism)** — the ACP-based substrate: connect to any AI, control its context I/O, manage its lifecycle. Defines *how the system talks to the underlying AI*.
- **Context Harness (policy)** — what the human does on top: capture, organize, inject, and review context to steer the agents. Defines *how humans steer AI, through context*.

The premise: humans no longer produce the final artifact (code, designs) — the agents do. The human's one job is to **manage context**. Everything Grove does drives the friction of that exchange toward zero.

**Where it sits.** ACP standardizes how *software* talks to AI: human · client · agent. Grove is the layer above — it replaces the *client* with **context**, so the triad becomes **human ⇄ context ⇄ agent**. ACP decides how the system reaches AI capability; Grove decides how people do — through context they can see and shape.

**The model.** Two actors — **Human** and **AI**. One object — **Context**, either *internal* (in the system) or *external* (out in the world). Every feature is one action on context:
- **Capture** — external context → internal. By the human (curating outside info) or the AI itself (web search / Figma / MCP fetch).
- **Organize** — structure & curate internal context; long-term memory is just AI-produced context, organized for reuse.
- **Inject** — context → AI. Two modes: *pull* (AI self-fetches, internal or external) and *push* (human loads context & instructions into the prompt).
- **Negotiate** — human ⇄ AI via *organizing templates* (surveys, review comments) that crystallize the exchange into reusable context.

Everything else people call Grove — "the multi-agent IDE", "parallel agent manager", "AI team tool" — is one action or one downstream effect of this harness, not its essence. Ten agents in parallel is a *topology*; shipping fast is a *result* of feeding the harness good context.

**Plugins** (next phase) open the policy layer: users and the community build new context pipes and organizing templates on top of the stable OS — turning Grove from a tool into a platform.

**Headline features**:
- **Every coding agent in parallel** — 10 built-in (Claude Code, Codex, Gemini CLI, Copilot, Cursor, Junie, Trae, Kimi, Qwen, OpenCode), 3 more ACP-ready (Hermes, Kiro, OpenClaw), plus BYO via ACP-over-stdio or HTTP. Each task = its own git worktree + terminal session, so agents don't collide.
- **Agent Graph** — typed DAG of agents exchanging structured `<grove-meta>` messages. Planner spawns coder; coder spawns reviewer. Exposed as MCP tools so any agent can drive it.
- **Studio** — first-class surface for non-coders (designers, PMs, brand). Excalidraw canvases agents can read, shared assets hard-linked across worktrees, Project Memory + Workspace Instructions editor.
- **Code Review** — threaded resolvable comments, AI batch-fixer, commit → rebase → merge → archive in one step with squash-merge detection.
- **Five surfaces from one binary**: TUI · Web · GUI · Remote (LAN + HMAC, for phones) · Radio (voice walkie-talkie from phone).

The Web IDE is the main event (FlexLayout, 10 panel types, IDE Layout mode, ⌘K palette). The terminal app (`grove tui`) is a thin client of the same server: projects, tasks and sessions in a sidebar, and the chat beside it.

**Positioning**: Grove serves three audiences on the same project — power devs (10 agents in parallel + Agent Graph), visual thinkers (Studio + sketch-driven workflow), non-technical collaborators (no terminal, no git, ship via Studio + Radio).

## Browser Control

Agents drive browsers through the `browser` tool, a thin pass-through to the [agent-browser](https://github.com/vercel-labs/agent-browser) npm package, always its latest release, run with `npx` (`src/browser/`). Grove passes the tool name and arguments through and returns the result as it came. Don't add wrappers, rewrite arguments or results, retry, or add tools of Grove's own. Grove owns only what is around the call:

- **Which browser** — each Task's test browser (logins kept per Project), or the user's own when a call names `target: "personal"`. The test browser is downloaded with `agent-browser install` on first use, unless agent-browser was already given a browser (`AGENT_BROWSER_EXECUTABLE_PATH`, or `executablePath` in `~/.agent-browser/config.json`); where the download fails, as on Linux ARM64, the agent is told to install Chrome or Chromium and set `executablePath`. A call that tries to choose another browser itself (`session`, `--cdp`, `connect` and the like) or to get the bound browser's connection (`get_cdp_url`) is refused, since that would get around the approval and the sensitive-tool switch. Results come back as agent-browser returns them, minus its `data.lifecycle` launch bookkeeping and `structuredContent.stdout` (a string copy of `structuredContent.response`).
- **Approval** — the user's own browser needs the user's approval, once per chat session, asked in that session's chat (`src/session_approval.rs`), unless the user set it to Allow. The test browser needs none.
- **Sensitive tools** — tools that read login data stay off in the user's own browser until the user turns on `sensitive_tools` (a denylist in `src/browser/mod.rs`).
- **Settings** — `enabled`; the user's own browser as Off / Ask / Allow (`personal_browser`, `personal_browser_bypass`); `sensitive_tools`.

The user's own browser is reached by CDP over the Companion extension (`grove-extension/src/background/cdpRelay.ts`), which only forwards: the driver sees every tab the extension can attach to (pages a browser or policy closes to extensions are left out), with Chrome's own target ids, and `Browser.close`, `Target.activateTarget` and `Page.bringToFront` are never carried out, so the agent never takes the user's screen. The driver reports the size of a browser it would launch, not the user's page, so screencast frames are made the page's size and the panel maps clicks by the frame. Bump the Companion's manifest version once per release, not on every change.

The Browser panel is for watching the agent and taking over: it lists the test browser's tabs and the tabs in the user's browser the agent has been on, with the live page. × closes a tab in the panel and nothing else; approval is never changed from the panel.

**Computer use** works the same way: the `computer` tool passes calls to the [agent-desktop](https://www.npmjs.com/package/agent-desktop) MCP server, latest release, unchanged (`src/computer.rs`). Each chat session gets its own agent-desktop session and asks the user in its chat before its first call; Settings sets it to Off / Ask / Allow (`computer_use`, `computer_use_bypass`). The panel shows each session's latest screenshot in a Computer tab ahead of the browser tabs; × closes the tab until the next screenshot.

## Design (Studio)

Agents design UI as plain HTML pages under a Studio task's `design/`, and the Design panel shows them as artboards on a board the user can play, comment on and rearrange (`src/storage/designs.rs`, `src/api/handlers/tasks/designs.rs`, `grove-web/src/components/Studio/DesignPage/`).

- **Files** — `design/<design>/{design.json, <page>.html, assets/}`. `design/system/` is a link to the Project's one design system (`~/.grove/studios/<hash>/design-system/`), shared by every task. The agent writes all of it with its own file tools. Grove writes `design.json` only when the user drags something or a page's rendered height is measured, and changes nothing else in the file. A `design.json` that does not parse is never written over. A write the panel makes to a page or stylesheet carries what it read (`expect`) and is refused when the file has changed since, undo included.
- **Design system on the Studio page** — the Project's design system is also read from the Project itself, with no task: `GET /projects/{id}/design-system` (+ `/pages/{file}`, files under `/design-files/system/{token}/{project}/system/…`). The Studio page's Design system card shows that board to look at (`orbit/studio/DesignSystemCard.tsx`, the Design panel under `designSystemKey`); editing and comments stay in a task's Design panel.
- **Agent tools** — `design_read_me` (the reference) and `design_read` (`src/cli/mcp.rs`). The agent sees a page through what an open Design panel rendered and uploaded: an image and a page check, kept in `.preview/`. Nothing on the server runs a browser; with no panel open the tool says so.
- **Isolation** — pages run in sandboxed frames with an opaque origin and talk to the panel over postMessage only (`DesignPage/bridge.js`). The files they load come through a token path, `/design-files/{token}/…`, the same way plugin panel assets do.
- **Layout of the panel** — nothing but the board and what floats over it: the design picker in its top left corner (the task's designs, and a zip in or out), Play, the inspector switch and zoom in its top right, the tools with undo and redo along the bottom. One surface for all of them. The inspector opens beside the board.
- **Editing** — on the board the user picks an element (Select tool) and changes it in the inspector: layers, text, size, layout, colors, order. The change is made in the frame at once and written into the page's HTML file by XPath (`DesignPage/designEdit.ts`, mirrored in `bridge.js`); an element the page's own script drew is refused. Editing is off while the task's agent is working.
- **Tweaks** — the CSS variables a page uses (its own `<style>` and the stylesheets it links under `design/`) are listed in the inspector; changing one rewrites its first definition in that stylesheet.
- **Marks** — notes, text, shapes and pen strokes the user puts on the board live in `design.json` under `marks`. Only the panel writes them; the agent reads them through `design_read`. The Frame tool adds an empty `untitled-N.html` page.
- **Sharing** — a Task share link also shows the boards (`/share/{token}/designs`, `SharedTaskView`): visitors look, play and, where the link allows, comment on elements; they change nothing. The Design panel reads a share through `shareDesignSource` in `grove-web/src/api/designs.ts`. Only Studio tasks share designs. The files a shared page loads come through `/share/{token}/design-files/{visitor}/{pass}/…`, checked against the link on every request, so they stop with the link or the visitor.
- **Import and export** — plain files in a zip, the layout Open Design and Claude Design write and read (`src/storage/design_transfer.rs`). A design goes out as `<design>/…` beside `system/…`; the design system on its own goes out as `system/…` alone. A page also goes out as one HTML file with its files inside, or as the image the panel last rendered. A zip comes in as new designs, never over an existing one; a design system it brings is installed when the Project has none, and otherwise the panel asks Skip or Overwrite (the import is refused with 409 until `system=` says which).
- **Comments** — review comments on the page file, with the element in `anchor_text`. Its pin is put on the element found by the recorded path, selector and text (`grove-web/src/utils/commentAnchor.js`, the one implementation, also used by file previews and chat messages), and drawn as stale when the element reads differently or is gone. A comment waits on the board; the agent hears of it only when the user sends it, one thread from its popover or every open one of the design from the inspector's Comments tab. A Studio agent answers them with `reply_review`. Comments on an Artifacts preview are the same kind, on `input/…` and `output/…` paths (`FilePreviewDrawer`, `useArtifactsPanel`). Someone on a share link reads every thread, the owner's and the agent's included, comments on designs and output files, and replies (`/share/{token}/comments/{id}/replies`).

## Tech Stack

- **Backend**: Rust 2021, axum (HTTP/WS), tokio, ratatui (TUI), Tauri 2 (desktop shell)
- **Frontend** (`grove-web/`): React 19, TypeScript 5.9, Vite 7, TailwindCSS 4, FlexLayout, Excalidraw, Monaco, xterm.js
- **Protocols**: ACP (Agent Client Protocol) for agent integration; MCP for tool-exposing servers
- **Storage**: TOML files + SQLite (`rusqlite` bundled) under `~/.grove/`
- **Embedded assets**: `rust-embed` 8 (debug → reads from filesystem; release → baked into binary)

## Project Structure

```
src/
├── main.rs                # Entry point + binary mode dispatch
├── cli/                   # Subcommands: gui, mcp, acp, web, hooks, migrate, ...
│   └── chat/              # The terminal app (`grove tui` / `grove cli`): a server client
├── api/                   # axum HTTP/WS API (consumed by GUI + external)
│   ├── mod.rs             # Router, embedded-asset serving
│   ├── handlers/          # Per-feature route handlers
│   ├── perf_middleware.rs # ⓘ perf-monitor: per-route timing histogram
│   └── perf_tracing.rs    # ⓘ perf-monitor: tracing collector
├── git/                   # Git CLI wrappers
├── tmux/                  # tmux session management
├── acp/                   # ACP (Agent Client Protocol) integration
├── agent_graph/           # Inter-agent spawn / send / reply tools
├── browser/               # Browser control: agent-browser driver, per-Task sessions, Companion relay
├── machines/              # Paired Grove servers: pairing, link, per-machine proxy
├── platform.rs            # OS differences: path spelling, console detach, process trees, script shell
├── storage/               # Persistence (config, tasks, notes, workspace)
├── model/                 # Data structures (Worktree, Task, Workspace)
├── theme/                 # 8 themes + dark/light detection
├── tray/                  # macOS tray icon
└── update/                # Self-update

grove-web/src/
├── main.tsx               # React entry
├── App.tsx                # Root component, theme/auth/project providers
├── api/                   # Backend API clients
├── components/            # React components (Tasks, Blitz, Studio, Editor, ...)
│   └── Tasks/TaskView/TaskChat.tsx  # ⚠ ~7000 LOC, hot path for perf work
├── context/               # React contexts
├── hooks/                 # useTaskPageState, useTaskOperations, ...
├── perf/                  # ⓘ Perf monitor (perf build only; tree-shaken in prod)
└── utils/                 # Shared helpers
```

## Core Concepts

### Hierarchy

```
Workspace (multiple projects) → Project (git repo) → Task (worktree + tmux session)
```

### Entry Logic

- `grove` outside a git repo → Workspace view
- `grove` inside a git repo → Project view
- `grove --features gui -- gui` → Tauri GUI window

### Task States

- `Live (●)` — tmux session running
- `Idle (○)` — no active session
- `Merged (✓)` — merged to target branch
- `Conflict / Broken / Archived` — see `model/worktree.rs`

## Build & Run

Use the **Makefile** for everything common — `make` lists targets.

Run targets align with `grove` subcommands. Append `PERF=1` to enable the
perf-monitor (backend instrumentation + frontend perf panel); applies to
`gui` / `web` / `web-build`.

```
make gui            # web build + cargo run --features gui -- gui
PERF=1 make gui     # web build (perf) + cargo run --features gui,perf-monitor -- gui
make web            # web build + cargo run -- web (browser at localhost:3001)
PERF=1 make web     # web build (perf) + cargo run --features perf-monitor -- web
make tui            # cargo run (no GUI, no web build)
make web-build      # web build only (PERF=1 wires in perf monitor)
make web-dev        # vite dev server (proxy /api → 3001)
make check          # cargo check across all feature combos
make fmt / lint     # cargo fmt / cargo clippy -D warnings
make ci             # full pre-push: fmt + clippy + test + web-lint + web build
make clean          # cargo clean + rm dist
```

### Cargo Features

- `gui` — Tauri GUI shell + webview (the desktop app)
- `perf-monitor` — Backend perf instrumentation: sysinfo endpoint, per-handler timing middleware, in-memory tracing collector, `/api/v1/perf/*` routes

Production releases ship with `gui` only. `perf-monitor` is dev-only.

## Data Storage

```
~/.grove/
├── config.toml                    # Theme + global settings
├── machines.toml                  # This machine's profile + paired machines (0600, holds device keys)
├── grove.db                       # SQLite — projects, tasks, review comments,
│                                  #   agent graph, custom agents, etc.
└── projects/<path-hash>/
    └── notes/<task-id>.md         # Markdown notes (still on disk)
```

Older layouts (per-task `ai/<task-id>/`, `review/<task-id>.json`,
`tasks/<id>/review.json`, `project.toml`, `tasks.toml`, `archived.toml`) are
all migrated into SQLite by the v1.x → v2.3 migration chain. `grove migrate
--prune` removes the leftover files.

## Web Frontend

### Build

```
cd grove-web && pnpm run build       # → grove-web/dist (clean prod, no perf code)
cd grove-web && pnpm run build:perf  # → grove-web/dist (with perf monitor)
```

The Rust binary embeds `grove-web/dist`. In **debug builds** (`cargo run`) the embed reads from disk on each request — rebuilding the web frontend takes effect without re-compiling Rust. In **release builds** the dist is baked into the binary.

### Hooks Architecture

`grove-web/src/hooks/` centralizes shared task-page logic so Blitz mode (`BlitzPage.tsx`) and Zen mode (`TasksPage.tsx`) don't duplicate code:

- `useTaskPageState` — selection, panels, search, messages
- `useTaskNavigation` — j/k navigation, context menu positioning
- `useTaskOperations` — commit / merge / archive / sync / rebase / reset / clean
- `usePostMergeArchive` — post-merge archive workflow

### Terminal colors

The terminal app reads colors from the configured theme (`cli::chat::render::Palette`, built from `ThemeColors`), never hardcoded `Color::Yellow` etc.

## Perf Monitoring System

Grove ships an in-house perf monitor that's **only included in dev/perf builds**. Production users see nothing.

### Two-layer gating (zero overhead in prod)

| Layer | Mechanism | When active |
|---|---|---|
| Frontend | Vite mode `perf` (`if (import.meta.env.MODE === "perf")`) | `pnpm run build:perf` only — vite tree-shakes the entire `src/perf/` tree from `pnpm run build` output |
| Backend | Cargo feature `perf-monitor` (`#[cfg(feature = "perf-monitor")]`) | `cargo build --features perf-monitor` only — release binaries omit the dep, routes, and middleware |

### How to use

```
PERF=1 make gui     # full rebuild + run with monitoring
```

Then in the Tauri window:
- **Right-click → Inspect** (or Cmd+Opt+I / Ctrl+Shift+I / F12) — open webview devtools
- **Ctrl+Shift+P** — toggle the perf panel (or click the floating dot bottom-right)

### Panel tabs

| Tab | Source | What it shows |
|---|---|---|
| timeline | Frontend | All events in time order: longtask / event / fetch / ws / mark / react-render |
| memory | Backend (sysinfo) | RSS + CPU% trend lines, latest values |
| renders | Frontend (React Profiler) | Per-component commit times, sorted by total cost |
| network | Frontend | fetch + WS latency, top 50 |
| backend | Backend (axum middleware) | Per-route P50/P95/P99/max + count, sorted by P95 |

Click a row in **backend** to expand recent traces for that route. Click any trace to see the span tree (Gantt-style).

### Adding tracing to a slow handler

Workflow: notice in `backend` tab that some route is slow → add `#[tracing::instrument]` to its handler → rebuild → re-trigger → look at trace detail → fix → remove the instrument.

```rust
// Wrap a whole handler. cfg_attr means prod binaries don't even compile the macro.
#[cfg_attr(feature = "perf-monitor", tracing::instrument(skip_all, fields(project_id = %id)))]
pub async fn get_status(Path(id): Path<String>) -> Result<...> {
    // Sub-spans for finer breakdown:
    #[cfg(feature = "perf-monitor")]
    let _s = tracing::info_span!("parse_output", lines = output.len()).entered();
    parse_git_output(&output)?;
    // _s drops at end of scope, span closes
}
```

Notes:
- Use `skip_all` to avoid serialising large args; pull only what you need into `fields(...)`.
- Sub-spans need `#[cfg(feature = "perf-monitor")]` because the inner code references `tracing::info_span!`. Top-level handler attribute can use `cfg_attr` instead — cleaner.
- Each route keeps the most recent **50 traces** (ring buffer, ~1-2KB each). `/perf/*` endpoints are excluded so the panel doesn't observe itself.
- Delete the instrument once you're done optimizing — keeps prod-equivalent code clean.

### Perf endpoints (perf-monitor build only)

```
GET  /api/v1/perf/sysinfo                — process RSS + CPU%
GET  /api/v1/perf/handler-stats          — per-route latency histogram
POST /api/v1/perf/handler-stats/reset    — clear histogram (use before a measurement)
GET  /api/v1/perf/traces?route=<key>     — recent trace list for a route
GET  /api/v1/perf/traces/{trace_id}      — full span tree for one trace
```

Reset the histogram before measuring an isolated operation; otherwise the cold-start burst skews percentiles.

## CLI Subcommands

- `grove` — Launcher panel: Recent / Web / App / CLI (each local or another machine) / Remote; replays the last mode when not run in a terminal
- `grove tui` — Terminal app: sidebar (projects › tasks › sessions, Buddies) + chat, backed by the Grove server
- `grove cli ls | new | send | log | agents` — Non-interactive session commands for scripts and agents (`--remote` to reach another machine)
- `grove web` — Browser IDE on `http://localhost:3001`
- `grove gui` — Native desktop window (requires `--features gui` build)
- `grove remote` (formerly `grove mobile`) — Let phones and other machines connect (LAN, HMAC-signed requests); `--private` for localhost-only, `--passkey <key>` for custom secret
- `grove mcp` — MCP server (stdio) for orchestrator agents
- `grove acp` — Headless ACP bridge
- `grove hooks <level>` — Send notification (`notice` / `warn` / `critical`)
- `grove register` / `grove remove` — Manage registered projects
- `grove migrate` — Legacy storage migration

## AI Integration Flow (per-task)

1. Task is created → git worktree (Coding) or `~/.grove/studios/<project>/tasks/<task>/` (Studio)
2. tmux/Zellij session is launched with env vars: `GROVE_PROJECT`, `GROVE_TASK_ID`, `GROVE_TASK_NAME`, `GROVE_BRANCH`, `GROVE_TARGET`, `GROVE_PROJECT_NAME`
3. Agents in the task call back to Grove via the built-in MCP server (read notes, reply to reviews, complete the task)

## Development Guidelines

### Completion Summary (Required)

After any code change, end your response with explicit build status:

```
## Build Status
- ✅/⚠️ pnpm run build (or build:perf): ...
- ✅/⚠️ Rust backend: needs/doesn't need rebuild
```

So the user knows what to run without re-reading the conversation.

### Rust Checks (Required Before Commit)

```
make ci             # one shot: fmt + clippy + test + web-lint + web build
```

The pre-commit hook (`.githooks/pre-commit`) runs:

1. `cargo fmt --all -- --check`
2. `cargo clippy -- -D warnings`
3. `cargo test`
4. `pnpm eslint src/ --max-warnings 0` (in `grove-web/`)
5. Version bump check (Cargo.toml differs from `master`, except on `master` itself)

Activate it once per clone:

```
git config core.hooksPath .githooks
```

### Commit Discipline

- One commit per bug fix or feature — group related changes
- Each commit self-contained
- Don't combine "add UI" and "add handlers" into separate commits if they're one feature
- Use `git rebase -i` / `--amend` to consolidate if you slipped

### Theme Colors

```rust
Style::default().fg(colors.highlight)   // ✅
Style::default().fg(Color::Yellow)      // ❌
```

### Terminal app (`src/cli/chat/`)

A client of the Grove server like the GUI: REST + the chat WebSocket, never local storage. Keep it to talking with agents and managing projects, tasks and sessions — GUI-only features (resources, automation, memory, git operations) stay in the GUI.

### Plugins

A change to the plugin API ships with its docs in the same commit:
`docs/plugin-development.md`, `docs/plugin.schema.json` for manifest fields,
and the SDK in `src/api/handlers/plugins.rs`. New host calls go in
`src/plugins/host_api.rs` with a permission; `src/plugins/e2e_tests.rs` runs real
sandboxed node processes against them.

### Git / tmux

All shell-out wrappers live in `src/git/mod.rs` and `src/tmux/mod.rs` — don't call `Command` from elsewhere.
