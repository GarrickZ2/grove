# Grove Capabilities

A reference of what Grove can do, organized by capability area.
Reflects version 0.9.0 (2026-04-19).

---

## 1. Foundation

### 1.1 Isolation model
- Per-task **Git worktree** — each task lives on its own branch in its own directory
- Per-task **tmux / Zellij session** — persistent, independent terminal environment (Unix)
- Per-task **spec** (`Task Notes`) — agents read intent before touching code
- Per-task storage directory `~/.grove/projects/<hash>/tasks/<id>/` for chats, notes, reviews, activity, sketches, artifacts

### 1.2 Non-worktree tasks
- **Local Task** — lightweight per-project task without a worktree, for notes/planning
- **Non-git projects** — register and manage plain directories without git init

### 1.3 Storage backend
- **SQLite** (`~/.grove/grove.db`) — WAL mode, transactions, busy_timeout for multi-process safety
- **Auto-migration** from legacy TOML/JSON storage, chained through storage versions
- `grove migrate --prune` — remove legacy files after confirmation

---

## 2. Multi-Agent Support (ACP)

### 2.1 Built-in agents
Claude Code · Codex · Gemini CLI · GitHub Copilot · Cursor Agent · Junie · Trae CLI · Kimi · Qwen · OpenCode · Hermes · Kiro · OpenClaw (13 total)

### 2.2 ACP protocol
- Full ACP client (JSON-RPC over stdio), tracks `ProtocolVersion::V1`
- Real-time streaming of messages, thoughts, tool calls, plan updates
- Permission request UI with approve/deny
- Headless `grove acp` subprocess bridge
- Multimedia content: image, audio, resource blocks

### 2.3 Custom agents
- Local command agents (spawn via CLI)
- Remote URL agents (HTTP endpoint)
- Per-chat model & mode selection
- Availability detection (unavailable agents hidden from picker)

### 2.4 Chat sessions
- Multiple chat sessions per task
- Create / rename / delete / switch
- Per-chat history persisted as JSONL with turn-level compaction
- Automatic replay on WebSocket reconnect
- Pending message queue with pause/resume across disconnects
- Read-only observation mode when session owned by another process
- **Take Control** to reclaim ownership
- Sender badges distinguish orchestrator messages from user messages

### 2.5 Chat input
- `@` file mentions with fuzzy search (files, folders, Notes)
- Shift+Tab mode cycling
- Multimedia attachments (image / audio / file) with labeled references
- Shell mode (`!`) — run commands in task worktree with streaming output
- Expandable text input
- Drag-drop over full chat window

### 2.6 Plan & Todo panels
- **Todo panel** — structured checklist from ACP Plan notifications
- **Plan panel** — full markdown plan file, auto-refresh on agent writes
- Auto-collapse when input expands

---

## 3. Orchestration & MCP

### 3.1 Grove as MCP server
`grove mcp` exposes Grove to other agents. Context-aware tool filtering:

**Management tools** (outside a Grove task):
- `grove_add_project_by_path`, `grove_list_projects`
- `grove_create_task`, `grove_list_tasks`
- `grove_list_agents`
- `grove_start_chat`, `grove_chat_status`, `grove_send_prompt`, `grove_list_chats`
- `grove_edit_note`

**Execution tools** (inside a Grove task):
- `grove_status` — confirm context
- `grove_read_notes` / `grove_edit_note` — task spec
- `grove_read_review` / `grove_reply_review` / `grove_add_comment` — code review
- `grove_complete_task` — commit → rebase → merge → archive
- `grove_sketch_read_me` / `grove_sketch_list` / `grove_sketch_read` / `grove_sketch_draw` — checkpoint-driven sketch control

### 3.2 Orchestrator / Worker hierarchy
- Orchestrator agent creates tasks and spawns worker agents
- Worker agents receive injected Grove MCP for self-management
- Sender badges in the UI distinguish orchestrator-authored messages

### 3.3 Fuzzy search across list tools
`grove_list_*` tools accept substring, word-prefix, and initials matching.

---

## 4. Workspace & IDE

### 4.1 FlexLayout
Multi-panel drag-and-drop workspace. 10 panel types:

Terminal · Chat · Review · Editor · Stats · Git · Notes · Comments · Artifacts · Sketch

- Panel-level maximize/minimize
- Middle-click to close tabs
- Tab numbering resets when all tabs close
- Saved layouts per workspace
- Tab double-click to rename
- Workspace state preserved across tab switches

### 4.2 IDE Layout mode
- Familiar IDE-style layout
- Task switcher popup (⌘K) for rapid task jumping

### 4.3 Breadcrumb & panel add
- Breadcrumb bar with back button, project, task, branch, inline git actions (Commit / Merge / Sync + overflow)
- Panel add menu at FlexLayout tab bar `[+]`
- Empty workspace shows quick-add buttons + ⌘K hint

### 4.4 Editor panel
- File tree browser
- File system operations (create / delete / rename) via context menu
- Syntax-highlighted file preview
- Markdown preview mode
- Image / SVG / Mermaid / D2 preview

### 4.5 Terminal panel
- xterm-based web terminal
- Instance caching across task switches
- Three-state toggle (hide / show / pop-out)
- Theme aligned with app theme
- Resize-safe when tab hidden

### 4.6 Themes
11 themes (Dracula / Nord / Gruvbox / Tokyo Night / Catppuccin / …) with auto dark/light detection.

### 4.7 Zen vs Blitz modes
- **Zen** — single-project focus
- **Blitz** — all tasks across all projects in one view

### 4.8 Command palette
- Context-aware ranking by page context and usage intent
- ⌘K shortcut on Tasks and Blitz pages

---

## 5. Studio

### 5.1 Resource management
- Per-project Studio page
- Resource / artifact / working directory panels
- **Shared Assets file manager** — upload, organize, sync

### 5.2 Memory editing
- **Project Memory** panel with markdown preview
- **Workspace Instructions** panel with markdown preview
- Visual editors — no markdown CLI required

### 5.3 Artifact preview
- Live auto-refresh during agent activity
- Inline **D2 diagram** rendering with source/preview toggle
- Inline **Mermaid diagram** rendering
- **Image lightbox** — fullscreen overlay for PNG / JPG / WEBP / GIF / SVG with scroll-wheel zoom panning

### 5.4 Code snapshot
- On task archive, final code state is captured for statistics and audit

### 5.5 Panel rotation
- Click a right-panel title to promote it to the main area

---

## 6. Sketches (Excalidraw)

- **First-class Sketch panel** type in FlexLayout
- Per-task sketch storage under the task workdir
- Tab bar with right-click rename / delete
- Multi-client **live updates** over WebSocket (real-time collaborative editing)
- Lazy-loaded Excalidraw bundle
- REST API: list / create / delete / rename; scene GET/PUT; element-level PATCH
- Broadcast channel ships scene payloads inside `SketchUpdated` events
- MCP tools: `grove_sketch_read_me` (format reference, called once), `grove_sketch_list`, `grove_sketch_read`, `grove_sketch_draw` (checkpoint-driven create-or-update)
- Pending-save flush on unmount / tab switch
- Path-traversal validation on `sketch_id`

---

## 7. Grove Radio — voice control

### 7.1 Walkie-talkie dispatch
- TaskGroup-based channel grid with frequency bands
- `_main` group always shown first (matches Blitz sidebar order)
- Real-time WebSocket sync

### 7.2 Voice input
- Hold-to-talk recording with configurable audio quality
- Cancel gesture (slide) to abort mid-recording
- Transcription routed to **Chat** session or **Terminal** (per-slot mode toggle)
- Voice → Terminal uses cached WebSocket with carriage-return handling

### 7.3 Live sync with Blitz
- Radio mode / session changes pre-emptively switch the Blitz desktop panel (chat tab / terminal tab / specific chat session) via `SetTarget`
- ACP busy/idle transitions broadcast `RadioEvent::TaskBusy` for instant status-light updates (replaces 2-second polling)
- `grove:switch-chat` CustomEvent keeps chat panels in sync

### 7.4 Audio transcription configuration
- AI settings page for transcription provider configuration
- Per-slot mode state (mode + chat_id target)

---

## 8. Remote Access (`grove mobile`)

### 8.1 Authentication
- **HMAC-SHA256 request signing** — secret key never sent over the wire
- Nonce-based replay prevention with ±60s timestamp window
- Pure JS SHA-256 fallback for non-secure-context browsers

### 8.2 Transport options
- Plain HTTP (default, LAN-trusted)
- `--tls` — self-signed certificate HTTPS
- `--cert` / `--key` — user-provided CA-signed certificate
- `--host <ip>` — bind to a specific interface
- `--public` — bind to 0.0.0.0 (all interfaces)

### 8.3 Onboarding
- QR code printed in terminal with embedded secret
- `AuthGate` component handles secret extraction and HMAC verification

### 8.4 Notifications
- Native macOS notifications via `UNUserNotificationCenter` with Grove icon
- Native Windows notifications
- Cross-platform notification via `grove hooks notice | warn | critical`

---

## 9. Spec → Develop → Review → Ship Workflow

### 9.1 Spec
- Task Notes markdown editor, auto-save on navigation
- `GROVE_*` env vars exported into the task's tmux/Zellij session (`GROVE_PROJECT`, `GROVE_TASK_ID`, `GROVE_TASK_NAME`, `GROVE_BRANCH`, `GROVE_TARGET`, `GROVE_PROJECT_NAME`)
- Agents read their own spec via MCP `grove_status` + `grove_read_notes`
- For Studio tasks, per-project `memory.md` and `instructions.md` are symlinked into every task as the living spec

### 9.2 Develop
- **Chat mode** — unified chat UI for every agent
- **CLI mode** — native terminal, full agent experience
- Agent picker per chat with availability detection
- Plan + Todo panels show agent progress

### 9.3 Review
- Line-level comments with threads
- `@` file mention inside comments (autocomplete)
- Bulk comment resolve with status and author filters
- AI-assisted fixer for review comments
- All Files mode with VSCode-style file icons
- File preview drawer with syntax highlighting, image / SVG / Mermaid / D2 / markdown rendering, lightbox
- Display mode toggle (Code / Split / Preview) across all files

### 9.4 Ship
- Cross-branch merge — auto checkout target, merge, return
- One-step: commit → rebase → merge → archive
- Squash merge detection via diff fallback
- Branch drawer with Go To Task / Rebase / Archive / Clean actions
- Archived task section with Recover / Clean

### 9.5 Statistics (beta)
- **AI Work Breakdown** — tool calls per task, plans per task, spec-length vs interventions scatter
- **Review Intelligence** — AI adoption rate, hit rate, rounds-per-fix
- **Agent Leaderboard** — canonical name aggregation, work + review panels
- Flexible time range picker
- Backed by `GET /api/v1/projects/{id}/statistics`

---

## 10. Skills

### 10.1 Marketplace
- Full-stack skill marketplace (backend storage + REST + frontend)
- `SkillsPage` with Agents / Sources / Explore tabs
- Sidebar navigation entry

### 10.2 Installation
- One-click install / uninstall
- Per-agent install state (each agent has its own action button)
- Global or project-level scope
- Skill hash stability across Rust versions (FNV-1a)

### 10.3 SKILL.md
- YAML frontmatter with block-scalar support (`>` folded, `|` literal)

---

## 11. Interfaces

### 11.1 `grove tui`
Keyboard-first terminal UI. Keys: `n` new · `Enter` open · `Space` actions · `j/k` navigate · `Tab` tabs · `/` search · `p` preview · `t` theme · `?` help · `q` quit.

### 11.2 `grove web`
Full-featured browser IDE. `localhost`-only by default, port configurable (`--port`).

### 11.3 `grove gui`
Tauri 2 native window. macOS included in `.dmg`; Linux via `GROVE_GUI=1`; Windows via `cargo install --features gui`.
- macOS AppBundle PATH expansion for tmux/claude/fzf
- Daemonize on startup (releases terminal)
- In-app updates with progress + restart dialog (AppBundle)

### 11.4 `grove mobile`
LAN access with HMAC auth — see §8.

### 11.5 Smart launch resume
`grove` (no args) replays the last used launch mode with its arguments; defaults to TUI on first run.

### 11.6 CLI project management
- `grove register` — register current directory as a project
- `grove remove` — unregister a project

### 11.7 Hooks CLI
- `grove hooks notice | warn | critical` — fire system notifications (for agents to call at end of turn)

---

## 12. Platform Support

- **macOS** 12+ — universal binary (Apple Silicon + Intel), `.dmg` bundle with GUI
- **Linux** — Debian/Ubuntu, separate GUI artifact, WebKitGTK runtime deps
- **Windows** 10/11 — `grove web` / `grove mcp` / `grove acp` / `grove gui` native; `grove tui` / `grove fp` show WSL2 guidance
- **Cross-platform filesystem links** — unified hard links + junctions (Windows) / symlinks (Unix)
- **Windows CI & release artifacts** — x64 + best-effort ARM64 `.zip`
- **WSL** supported via the Linux binary

---

## 13. Developer Extension Points

### 13.1 Hooks
- `grove hooks <level>` CLI for agent-triggered notifications
- Sound and notification settings in-app (`h` key)

### 13.2 MCP
- Grove-as-server exposes task management tools
- Injected into every ACP session by default
- Context-aware tool filtering (orchestrator vs worker)

### 13.3 Skills SDK
- Any agent can ship skills via the marketplace
- `using-grove-sketch`-style guidance skills for agent onboarding

### 13.4 Custom agents
- Local command or remote URL
- Per-chat model + mode configuration

---

## 14. Notable Quality-of-Life

- AutoLink — symlink heavy dependencies across worktrees (excluded from git/review)
- Smart launch resume
- Command palette context-aware ranking
- Image / SVG / Mermaid / D2 previews everywhere
- Smooth crossfade when switching tasks in Zen/Blitz
- CJK path support (git octal-escape decoding) across all git ops
- IME composition safety (Chinese/Japanese input doesn't trigger hotkeys)
- ⌘+Shift+[/] workspace tab switching
- File path click in chat jumps to All Files mode with flash highlight

---

## 15. Agent Ecosystem at a Glance

| Surface | Input | Output | Who uses it |
|---|---|---|---|
| TUI | Keyboard | Terminal | Power developer |
| Web IDE | Mouse + keyboard | Browser | Any developer |
| GUI | Mouse + keyboard | Native window | Any developer (desktop) |
| Mobile | Touch + voice | Phone browser | Remote / on-the-go |
| Radio | Voice (hold-to-talk) | Chat or Terminal | Hands-free / non-technical |
| Studio | Click / drag-drop | Browser | Non-technical collaborator |
| Sketch | Draw | Canvas + MCP | Visual thinker |
| MCP | Tool calls | Any agent | Orchestrator AI |
