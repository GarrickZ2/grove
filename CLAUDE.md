# Grove - Project Guide

## What Grove Is

Grove is a workspace for humans + AI agents to build software together. Single Rust binary; multiple surfaces; opinionated on rigorous review and structured agent collaboration.

**Headline features**:
- **Every coding agent in parallel** — 10 built-in (Claude Code, Codex, Gemini CLI, Copilot, Cursor, Junie, Trae, Kimi, Qwen, OpenCode), 3 more ACP-ready (Hermes, Kiro, OpenClaw), plus BYO via ACP-over-stdio or HTTP. Each task = its own git worktree + terminal session, so agents don't collide.
- **Agent Graph** — typed DAG of agents exchanging structured `<grove-meta>` messages. Planner spawns coder; coder spawns reviewer. 6 MCP tools (`grove_agent_spawn` / `_send` / `_reply` / `_contacts` / `_capability` / `_get_spawn_candidates`).
- **Studio** — first-class surface for non-coders (designers, PMs, brand). Excalidraw canvases agents can read, shared assets hard-linked across worktrees, Project Memory + Workspace Instructions editor.
- **Code Review** — threaded resolvable comments, AI batch-fixer, commit → rebase → merge → archive in one step with squash-merge detection.
- **Five surfaces from one binary**: TUI · Web · GUI · Mobile (LAN + HMAC) · Radio (voice walkie-talkie from phone).

The Web IDE is the main event (FlexLayout, 10 panel types, IDE Layout mode, ⌘K palette). The TUI is the original keyboard-first surface — still here, still fast.

**Positioning**: Grove serves three audiences on the same project — power devs (10 agents in parallel + Agent Graph), visual thinkers (Studio + sketch-driven workflow), non-technical collaborators (no terminal, no git, ship via Studio + Radio).

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
├── app.rs                 # TUI app state + core logic
├── event.rs               # TUI keyboard handling
├── cli/                   # Subcommands: gui, mcp, acp, web, hooks, migrate, ...
├── api/                   # axum HTTP/WS API (consumed by GUI + external)
│   ├── mod.rs             # Router, embedded-asset serving
│   ├── handlers/          # Per-feature route handlers
│   ├── perf_middleware.rs # ⓘ perf-monitor: per-route timing histogram
│   └── perf_tracing.rs    # ⓘ perf-monitor: tracing collector
├── git/                   # Git CLI wrappers
├── tmux/                  # tmux session management
├── acp/                   # ACP (Agent Client Protocol) integration
├── agent_graph/           # Inter-agent spawn / send / reply tools
├── storage/               # Persistence (config, tasks, notes, ai_data, workspace)
├── model/                 # Data structures (Worktree, Task, Workspace)
├── theme/                 # 8 themes + dark/light detection
├── tray/                  # macOS tray icon
├── update/                # Self-update
└── ui/                    # TUI widgets

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

```
make run            # web (prod) + cargo run --features gui -- gui
make perf           # web (perf) + cargo run --features gui,perf-monitor -- gui
make perf-run       # cargo run only (skip web rebuild)
make web-perf       # web build with perf monitor wired in
make web            # web build (clean prod)
make web-dev        # vite dev server (proxy /api → 3001)
make tui            # cargo run (no GUI, no web build)
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
cd grove-web && npm run build       # → grove-web/dist (clean prod, no perf code)
cd grove-web && npm run build:perf  # → grove-web/dist (with perf monitor)
```

The Rust binary embeds `grove-web/dist`. In **debug builds** (`cargo run`) the embed reads from disk on each request — rebuilding the web frontend takes effect without re-compiling Rust. In **release builds** the dist is baked into the binary.

### Hooks Architecture

`grove-web/src/hooks/` centralizes shared task-page logic so Blitz mode (`BlitzPage.tsx`) and Zen mode (`TasksPage.tsx`) don't duplicate code:

- `useTaskPageState` — selection, panels, search, messages
- `useTaskNavigation` — j/k navigation, context menu positioning
- `useTaskOperations` — commit / merge / archive / sync / rebase / reset / clean
- `usePostMergeArchive` — post-merge archive workflow

### Component Pattern (Rust UI)

```rust
pub fn render(frame: &mut Frame, area: Rect, data: &Data, colors: &ThemeColors) { ... }
```

Always read colors from `ThemeColors`, never hardcode `Color::Yellow` etc. Each theme defines `accent_palette: [Color; 10]` for gradient blocks.

## Perf Monitoring System

Grove ships an in-house perf monitor that's **only included in dev/perf builds**. Production users see nothing.

### Two-layer gating (zero overhead in prod)

| Layer | Mechanism | When active |
|---|---|---|
| Frontend | Vite mode `perf` (`if (import.meta.env.MODE === "perf")`) | `npm run build:perf` only — vite tree-shakes the entire `src/perf/` tree from `npm run build` output |
| Backend | Cargo feature `perf-monitor` (`#[cfg(feature = "perf-monitor")]`) | `cargo build --features perf-monitor` only — release binaries omit the dep, routes, and middleware |

### How to use

```
make perf           # full rebuild + run with monitoring
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

- `grove` — Smart start: resumes your last mode
- `grove tui` — Keyboard-first terminal UI
- `grove web` — Browser IDE on `http://localhost:3001`
- `grove gui` — Native desktop window (requires `--features gui` build)
- `grove mobile` — LAN access for phone / tablet (HMAC-signed requests)
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
- ✅/⚠️ npm run build (or build:perf): ...
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
4. `npx eslint src/ --max-warnings 0` (in `grove-web/`)
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

### Event Handling (TUI)

`event.rs` dispatches by priority: popups (help, dialogs) → mode events (Workspace / Project).

### Git / tmux

All shell-out wrappers live in `src/git/mod.rs` and `src/tmux/mod.rs` — don't call `Command` from elsewhere.

## TODO

- [ ] Diff view (Code Review)
- [ ] Ctrl-C exit support
- [ ] Homebrew formula
