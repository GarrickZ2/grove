# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.10.5] - 2026-05-07

### Added

- **Symbol indexing for Go (tree-sitter)** — Per-project `SymbolStore` backed by SQLite + in-memory cache, populated by a tree-sitter-go grammar that extracts top-level decls and struct fields. Index builds lazily on first access and stays current via watcher-driven incremental updates with a coalescing scheduler and mtime-gated writes. Exposed over HTTP (`lookup` / `reindex`) and wired into Monaco for cmd+click jump-to-definition, cmd+hover underline (via `DefinitionProvider`), peek preview, double-click navigation, and a multi-candidate picker when a name resolves to several symbols.
- **Symbol Indexing settings panel** — New "Code Repo Indexing" section in Settings: master toggle + per-language enable list, with VSCode-style language icons on the chips and a portal'd language picker. `openSections` init updated so the section actually expands.
- **`@ Share History` chat mention** — In a chat, `@` another chat to share its `history.jsonl` as context. Mention dropdown and `@file` chips now render VSCode file icons instead of generic glyphs.
- **Project rename via inline edit on ProjectCard** — Click to rename projects directly from the card without opening settings.
- **Drag-select preview comments** — Drag across multiple preview blocks to attach one comment to the whole range.
- **Markdown TOC + IDE keep-alive panes** — TOC for markdown previews; IDE panes survive layout changes without losing terminal/process state.
- **Per-task watcher event subscription API** — Lets clients subscribe to filesystem events scoped to a single task; tasks now activate explicitly via `/activate` instead of implicitly on first read.

### Improved

- **Local Task created at project registration** — Previously lazy-on-read, which left projects in an inconsistent state until first open. Now created up front so downstream code can rely on it existing.
- **Tasks migrated to SQLite (storage v2.3 → v2.4)** — Moves task records out of TOML into `grove.db` alongside the rest of v2.3's migrated data. Migration is guarded with the same safety checks used for the review/notes migrations.
- **Mobile web UI usability** — Layout, hit targets, and overflow handling reworked so the web IDE is actually usable on a phone (not just on tablets).
- **Misc UI polish + small backend fixes** — assorted rough edges across the web frontend and Rust handlers.

### Fixed

- **Symbols index hardening per code review** — coding-task scope honored, comprehensive Go query (no missed decls), multi-candidate UI surfaces ambiguity instead of silently picking one, peek preview shows real file content, double-click navigation routes correctly, unused `/search` endpoint removed.
- **Symbol cache lifecycle** — cached rows are dropped when a task is deleted *or* archived (previously archive leaked stale rows).
- **Settings outside-click missed portal'd picker** — outside-click handler now sees clicks landing on portal'd picker DOM; section also renamed to "Code Repo Indexing" for clarity.
- **Review hardening sweep** — fixes across symbols indexing, storage migrations, chat draft persistence, and UI per review feedback.

## [0.10.4] - 2026-05-04

### Added

- **In-app performance monitor** — Dev-only perf panel (gated behind `perf-monitor` Cargo feature + Vite `perf` mode, tree-shaken from prod) with timeline / memory / renders / network / backend tabs. Backend exposes `/api/v1/perf/*` endpoints (sysinfo, per-route latency histogram, per-trace span tree); production builds omit the dep, routes, and middleware entirely.
- **React Compiler enabled** — `babel-plugin-react-compiler@1.0.0` wired into the Vite pipeline, applying automatic component- and variable-level memoization across the entire web tree. ~97% of source files are auto-memoized; the remaining ~3% (root `App`, `XTerminal`, and dynamic-import sites in Studio / walkie-talkie / hotkeys) carry an explicit `"use no memo"` directive. Set `REACT_COMPILER_LOG=1` during `vite build` to inspect per-file compile decisions.

### Improved

- **React-19 hooks compliance sweep across 50+ files** — adopted React 19 / React Compiler safety patterns end-to-end: prop-change reset state via stored markers, `ResizeObserver` driving container size state, ref writes deferred to `useEffect`, derived state replacing `setState`-in-effect anti-patterns. Eliminated 124 hook-rule violations introduced by `eslint-plugin-react-hooks@7.1.1` and 95 `try/finally` Compiler bailouts plus 30+ `Support value blocks within try/catch` bailouts.
- **TaskGraph + TaskChat decomposition** — extracted `GraphContextToolbar` (~620 LOC, 9 sub-components) and shared graph types out of the 2900-line `TaskGraph.tsx`, and pulled four focused hooks (`useACPAvailability`, `useActiveChatId`, `useChatPositioning`, `useInitialChatLoad`) out of `TaskChat.tsx` so their internal `let`-and-cleanup patterns can be Compiler-optimized independently.
- **TaskChat virtualization** — ~7000 LOC chat view now virtualized via `react-virtuoso`, eliminating jank on long conversations.
- **Backend hot-path fork+exec elimination** — replaced shell-out git calls with `gix`, swapped plist parsing to a native crate, and parallelized eligible passes with `rayon`.
- **xterm WebGL renderer** — terminal panel now uses `@xterm/addon-webgl` for smoother scrolling and lower CPU on busy output.
- **Event timeline diagnostics** — perf monitor's event timeline reworked to actually highlight pathological spans instead of drowning them in noise.

### Fixed

- **Code review findings + GUI mic, notification deep-links, IDE resize** — addressed review feedback covering the GUI microphone permission flow, notification deep-link routing, and IDE panel resize edge cases.
- **z.ai 5-hour token quota window** — quota matcher now keys on duration instead of fragile label regex, so the 5-hour window is detected correctly.
- **Lightbox panning + fullscreen window toggle** — restored panning behavior and fixed the fullscreen toggle interaction.
- **Review-comment migration: orphaned data on non-2.2 upgrade paths** — `migrate_review_to_sqlite` now runs for any pre-2.3 user (was previously gated on `version == "2.2"`, silently skipping users coming from 1.0/1.1/2.0/2.1). Source `review.json` files are renamed to `.json.migrated` after import, and rename failures are logged instead of swallowed.
- **`gix_log_target_to_head` correctness on long-lived branches** — bidirectional BFS now correctly excludes the merge-base and its ancestors from the HEAD-only walk. Earlier, mb was discovered but never inserted into the exclusion set, so commits at the merge boundary leaked into `target..HEAD`. Walk also short-circuits once it crosses below mb's commit-time, bounding work on huge histories.
- **Bulk delete couldn't target unattributed comments** — `ConversationSidebar` was filtering on the display label `"Unknown"` while comments were stored with `agent=""`. Agent buckets now key on the raw column value (with `""` rendered as "Unknown" only for display) and the backend matches both bare-agent and legacy `"agent (role)"` display strings via a `CASE WHEN role=''` clause, so comments with empty role still match.
- **Agent display string `" (Reviewer)"`** — `formatAgentDisplay` returned a leading-space parenthesis-only string when `agent=""` and `role` was set; now falls back to `"Unknown (Reviewer)"`.
- **`normalize_agent_name` over-matched** — substring match misclassified e.g. `"openai-proxy"` as Codex; switched to token-based matching (split on whitespace / `-` / `_` / `.`) and dropped the `openai` → Codex alias entirely.
- **Typewriter 1-frame garbled flash on stream resets** — when target text was replaced (not extended), `useTypewriter` previously rendered `newTarget.slice(0, oldRevealed)` for one frame before the reset effect fired. Reset is now detected during render so the slice already reflects the new target.
- **TrayPopover stale-running header** — `totalRunning` now respects the `show.running` toggle, so disabling the section actually clears the header count and lets the empty-state placeholder render.
- **TaskGraph zoom widget overlap in narrow split-panes** — moved from bottom-right to top-right so it never competes with the centered context toolbar for horizontal space.

### Improved

- **`grove migrate` CLI shares startup migration code** — the manual subcommand now calls the same `ensure_storage_version()` chain that runs at boot (was a stale v1.0 → v1.1-only file rearranger that wrote `tasks/<id>/review.json` files the v2.3 reader doesn't pick up). `--dry-run` flag dropped — it only ever applied to the legacy step. `--prune` extended for v2.3 leftovers (per-task `review.json[.migrated]`, the older `review/` directory, and pre-2.0 `ai/<task>/` per-task review folders).
- **Review-comment SQL hardening** — `bulk_delete_comments` no longer pushes parameter values twice (the second batch was dead code); `add_comment` defaults `end_line` to `start_line` for inline comments when callers omit it.
- **AbortController for `DiffReviewPage` task-path lookup** — rapid prop changes now actually cancel the in-flight `listTasks` requests instead of just gating their `setState`.

## [0.10.3] - 2026-04-30

### Added

- **Menubar tray** — macOS-first menubar tray with a React popover, chat-grained state stream, and a Settings panel for tray and system notification preferences.
- **Agent graph tools** — `spawn`, `send`, `reply`, and `contacts` actions exposed over MCP HTTP transport, enabling orchestrator agents to drive agent-graph interactions programmatically.

### Improved

- **Preview comments as Grove meta cards** — comment blocks in the preview pane now render as styled Grove meta cards for cleaner visual hierarchy.

### Fixed

- **ACP agent availability checks** — stale availability status for ACP agents is now resolved correctly.
- **Config field cleanup** — removed dead `hooks.banner/enabled` fields and addressed follow-up findings from the ACP review.

## [0.10.2] - 2026-04-28

### Added

- **Push for branches without upstream** — Dashboard "Push" no longer requires an existing `origin/<branch>` ref. `RepoStatusResponse` now exposes `has_remote` (origin remote configured) alongside `has_origin` (upstream tracking ref); the button enables whenever a remote exists, and the backend pushes with `-u` so a brand-new local branch is published in one click.
- **README install split + `docs/install.md`** — Install section reorganised into "For Humans" (paste a prompt to your LLM agent) and "For LLM Agents" (`curl` the guide). New `docs/install.md` is an end-to-end, agent-friendly installation reference (platform detection, installers, verification, first run, uninstall).

### Fixed

- **ACP orphan permission requests** — fresh WebSocket connect now cancels permission requests left behind by a previous session so the new client doesn't inherit stale prompts.
- **Chat unblocked for npx-only setups** — surfaces npx download progress instead of looking idle while the agent CLI bootstraps.
- **Preview Comment mode stickiness** — Comment mode now persists across submissions in the preview pane.
- **TaskGraph polish** — toolbar layout, arrowhead rendering, and the Remind action UX cleaned up.
- **Tauri webview** — external links open in the system browser; embedded images resolve correctly inside the GUI.
- **Grove stays alive on macOS window close** — closing the GUI window no longer terminates the Grove process.

### Improved

- **GUI/Web devtools + sandboxed-iframe storage** — devtools shortcut wired up; sandboxed iframes get a localStorage shim; project list refreshes on Open.

## [0.10.1] - 2026-04-28

### Added

- **`grove mcp-bridge` subcommand** — stdio↔HTTP bridge for ACP agents that ignore MCP servers injected via `NewSessionRequest.mcp_servers` (Trae and similar). Users wire `command: "grove", args: ["mcp-bridge"]` into the agent's own MCP config; the bridge reads JSON-RPC from stdin, POSTs to the in-process agent_graph MCP HTTP listener, decodes SSE responses with byte-level UTF-8 buffering across chunk boundaries, and forwards results to stdout. Each request runs on its own task; configurable timeout via `GROVE_MCP_BRIDGE_TIMEOUT_SECS` (default 300s).

### Improved

- **Token / port discovery for MCP** — agent_graph token is now generated BEFORE the agent subprocess is spawned and injected into env vars (`GROVE_MCP_TOKEN`, `GROVE_MCP_PORT`), so children of the agent process (like `grove mcp-bridge`) inherit them. Listener boot atomically writes `~/.grove/mcp.port` (`<port> <pid>`) for ad-hoc fallback discovery, with cross-platform pid health check to detect stale files from a prior Grove process.
- **Agent Graph layout preservation** — the graph view no longer rearranges existing nodes when new nodes / edges arrive (post spawn / send / chat-status flip). User drags persist; synthetic pins added by the layout effect are tracked separately and released on `sim.on("end")` instead of a fixed timeout.
- **Marketing site** — index.html hero now showcases Agent Graph; new sub-blocks under § 02 AGENTS (Agent Graph) and § 03 STUDIO (a real Studio task in flight). README updated to match.

### Fixed

- **PATCH 204 "Internal Error" on graph edge purpose edits** — `apiClient.patch` was calling `response.json()` unconditionally, throwing `SyntaxError` on the empty 204 body even though the backend wrote successfully. Aligned with `put` / `delete` / `post` (text empty → `undefined`, otherwise `JSON.parse`).
- **`AgentGraphTokenGuard` dead code** — token lifetime moved entirely to `run_acp_session::EarlyTokenGuard`; the orphaned struct + Drop impl removed so future maintainers can't accidentally double-unregister.

## [0.10.0] - 2026-04-27

### Added

- **Agent Graph (DAG of agents)** — full feature stack: SQLite storage with FK + cycle detection, single-in-flight pending messages per (from, to), per-session DAG queries, edge CRUD with bidirectional/cycle/same-task guards, HTTP MCP listener (Streamable HTTP transport) injected into ACP `NewSessionRequest`, 6 MCP tools (`grove_agent_spawn` / `_send` / `_reply` / `_contacts` / `_capability` / `_get_spawn_candidates`), event-driven state machine with chat-grained `ChatStatus` / `PendingChanged` / `ChatListChanged` push, and `<grove-meta>` envelope wrapping for all agent-to-agent prompts
- **Agent Graph web UI** — d3-force rendering tab, full editing layer (spawn / connect / duty / delete), @-mention picker, hover cards with pending message data, floating context toolbar (replaces popup card), permission id-aware reconcile, narrow-width composer/sidebar fixes
- **Custom Agents (personas)** — user-defined persona layer over base agents with per-persona model/mode/effort/system-prompt; system prompt injected on Create via `<user-system-prompt-{nonce}>` envelope; `available_custom_agents` exposed to peers via `grove_agent_contacts`
- **User-driven graph operations** — graph spawn endpoint, edge add/delete with auto-`PendingChanged` events, `grove_user_remind` (envelope-wrapped reminder distinct from new user prompt), per-chat duty PATCH endpoint with `force=true` user override
- **Agent usage / quota** — provider-based quota system with 6 new agents and safe-guard water-level marker on the progress bar
- **Hooks Configuration** — UI to configure hook commands; notification sound split into Agent Response / Permission Required tracks
- **Chat polish** — Save To Note button in Plan sub-panel, Cmd+F in-panel search for Preview & Chat, link resources for Artifacts & Shared Assets, preview comments on artifact / review previews, `sketch://` chips, unified Uploads + Working Directory list, agent quota refresh on idle (vs 60s polling)

### Improved

- **ACP** — zero-config ACP via npx fallback; claude-agent-acp effort selector + toolbar fit; chat history caps tool content at 32KB and tail-reads large files; Cursor Agent / Junie support with unified agent icons
- **Storage** — SQLite-backed hooks; chat_history `compact` rename falls back to copy on cross-device EXDEV; `gc_orphans` reverse-scans (only checks tasks with sessions) and skips on IO errors instead of mass-deleting
- **HTTP API hardening** — `get_app_icon` rejects non-absolute and `..` paths; `patch_config` serialized via async mutex to prevent concurrent overwrites
- **`grove-meta` envelopes** — agent-to-agent prompts now carry structured JSON (`type` / `data` / `system-prompt`) inside `<grove-meta>` tags; receiving frontend renders meta-aware chips
- **Project add navigation, draft preservation, last tab memory** — minor UX fixes across web

### Fixed

- **Agent Graph review fixes (two rounds)**
  - **Concurrency** — `is_busy` Relaxed-load-then-branch race in `deliver_to_session` / `user_send_message` replaced with `compare_exchange(false, true)` CAS; failure path stores false to release the claim
  - **Storage error model** — new `GroveError::StorageTagged { tag, msg }`; storage layer raises stable tags via `storage_tagged`; `From<GroveError> for AgentGraphError` matches tags exactly instead of `String::contains`
  - **Migration safety** — dropped fragile `chats.toml` rename in `migrate_chats` (new service reads SQLite only); FK constraints added to `agent_edge` / `agent_pending_message` with table-rebuild migration that pre-counts and logs orphan rows being dropped
  - **Atomicity** — `graph_add_edge` now validates the edge before writing duty (and rolls back the edge on duty failure); `grove_agent_send` rolls back duty when delivery fails after a fresh duty assignment; `custom_agent::update` wrapped in transaction with row-affected check
  - **Concurrency / queue** — `resume_queue` re-inserts the popped message at the head when `try_enqueue_prompt` fails; `insert_pending_message` maps SQLite UNIQUE constraint failures to `previous_message_pending` instead of opaque internal errors
  - **User vs AI duty lock** — `update_chat_duty` gains `force: bool`; user-facing PATCH path uses `force=true`, AI tool paths use `false`; closes the bug where users couldn't edit a duty once any AI had set it
  - **MCP tool descriptions** — rewritten to describe the `<grove-meta>` envelope and warn that `grove_agent_capability` does not auto-spawn
  - **`user_remind` envelope** — new `InjectKind::Remind`, `deliver_user_remind` helper with same CAS / spawn-on-demand semantics; receiver can distinguish reminder from a fresh user request
  - **`</user-system-prompt id=...>` invalid XML** — closing tag attribute removed; nonce now baked into the tag name
  - **HTTP error mapping** — `unknown_base_agent` returns 400 instead of 500 for `POST/PATCH /custom-agents`
  - **`user_spawn_node` failure visibility** — broadcasts `ChatStatus("disconnected")` instead of only `eprintln`, so UI nodes don't hang in `connecting`
- **Test infra** — mock cmd loop now emits `Busy{true}` before `Busy{false}` to mirror prod behavior

## [0.9.3] - 2026-04-21

### Added

- **Thought-level selector** — reasoning-effort dropdown surfaced end-to-end: ACP backend plumbs the selector, MCP exposes it via `grove_chat_status` / `grove_send_prompt`, and the web chat control bar renders a per-chat dropdown
- **Sketch chips in chat** — `sketch://` references render as clickable chips that open the referenced sketch

### Improved

- **ACP 0.11 upgrade** — migrated to `agent-client-protocol` 0.11 builder API
- **Chat reliability** — second Ctrl-C now force-exits to escape a hung graceful shutdown
- **Test stability** — consolidated DB test locks to fix parallel flakiness

### Fixed

- **Sketch UX** — per-sketch history, correct arrow bindings, cross-sketch state leak, and tab UX issues
- **ACP placeholder bubbles** — empty-text thought chunks are skipped so no blank bubbles appear
- **GUI inline-code URLs** — inline-code URLs now wrap and are clickable in the GUI
- **Review follow-ups** — three rounds of code-review fixes across the v0.9.2..HEAD range

## [0.9.2] - 2026-04-20

### Fixed

- **ACP chat history integrity** — atomic `history.jsonl` appends prevent concurrent-write races (`{a}{b}` interleaving); reader now tolerates concatenated JSON
- **ACP permission lifecycle** — user replies always persist by emitting `PermissionResponse` regardless of oneshot receiver state; orphan `permission_request` entries are cleaned up on WebSocket reconnect across three cases (backend-drained, WS-only with backend pending, stale 1-shot)
- **ACP tool call updates** — `ToolCallUpdate` content/locations are now merged per ACP spec (increment, superset-replace, dup-skip) instead of overwriting; frontend reducer mirrors this behavior, covered by new `compact_events` unit tests
- **Plan tool completion** — synthesize `ToolCallUpdate{completed}` for `todo_write` / `update_plan` when `SessionUpdate::Plan` arrives, so Trae plan tools close properly; pending list is cleared on real completion
- **File explorer symlink loops** — `walkdir` now uses a `max_depth` guard to defend against symlink cycles
- **Welcome page hover** — separated entrance animation from hover transition so `Feature` icons no longer appear stuck after the cursor leaves
- **macOS folder-access prompts** — added `NSDesktopFolderUsageDescription`, Documents, Downloads, Removable / Network Volumes, and AppleEvents usage strings to `src-tauri/Info.plist` so TCC shows a clear reason and persists the grant across launches

### Improved

- **Action chip UI** — per-kind icons (bash / skill / todo / mcp / permission), labels derived from content/locations, click-to-expand inline markdown panel, trailing Chevron/ExternalLink affordance, disabled state when non-interactive
- **Terminal PATH fallback** — `/opt/homebrew/bin` is now included in the fallback PATH

## [0.9.1] - 2026-04-20

### Fixed

- **Web IDE polish** — restored IDE layout shortcuts, Studio `@` mentions, and flushed sketch thumbnail alignment
- **Agent auto-selection** — installed agents are now auto-selected on server start so users don't need to pick them manually

## [0.9.0] - 2026-04-19

### Added

- **Sketches (Excalidraw) panel** — new first-class Sketch panel type integrates Excalidraw into FlexLayout: per-task sketch storage under the task workdir, tab bar with right-click rename/delete, multi-client live updates over WebSocket, and lazy-loaded bundle to keep the main chunk small
- **Sketch REST & WS API** — list/create/delete/rename endpoints, scene GET/PUT, element-level PATCH, and a broadcast channel that ships scene payloads inside `SketchUpdated` events so clients update without refetching
- **Sketch MCP tools** — `sketch_list`, `sketch_read`, `sketch_new`, `sketch_patch`, and `sketch_replace` exposed via MCP, with management instructions and a `using-grove-sketch` skill
- **Run in Terminal** — open a task's tmux session in the system terminal, plus modernized code blocks in chat rendering

### Improved

- **Windows support** — hardened install script, native notifications, and platform gating across `grove web`, `grove mcp`, `grove acp`, and `grove gui`; agent detection now works on Windows

### Fixed

- **Terminal panel regression** — terminal panel chrome restored and task re-entry no longer drops the active session
- **Sketch data integrity** — path-traversal validation on `sketch_id`, pending-save flush on unmount/tab switch, and realtime resilience hardening



### Added

- **Windows cross-platform support** — Grove now builds and runs on Windows; `grove web`, `grove mcp`, `grove acp`, and `grove gui` work natively, while `grove tui` and `grove fp` show a clear message directing users to WSL2 or `grove web`
- **Cross-platform filesystem links** — new `fs_link` module provides unified hard links (files) and junctions on Windows / symlinks on Unix for directories, so features like skill links, studio workdir links, and artifacts work without Developer Mode
- **Windows CI & release artifacts** — CI matrix now builds on `windows-latest` (x64 and best-effort ARM64); release workflow produces a `.zip` Windows package uploaded to GitHub Releases

### Fixed

- **Git `/dev/null` portability** — `git diff --no-index` paths now pick `NUL` on Windows and `/dev/null` elsewhere, fixing diff generation on Windows
- **ACP Unix socket gating** — cross-process ACP socket listener and probe are gated to Unix; Windows falls back to in-process session lookup with a clear error for cross-process attempts
- **GUI daemonization on Windows** — uses `CREATE_NEW_PROCESS_GROUP` as the Windows equivalent of Unix process groups; PATH expansion logic restricted to macOS AppBundle only

## [0.8.9] - 2026-04-16

### Added

- **D2 diagram preview** — Studio now renders D2 diagrams inline with a source/preview toggle; All Files nav fixed
- **Shared Assets file manager** — full file manager for Shared Assets with artifact sync support
- **ImageLightbox component** — reusable fullscreen lightbox for images, SVG, mermaid, and markdown previews
- **Lightbox in FilePreviewDrawer & DiffFileView** — click any image/SVG to open fullscreen lightbox with scroll-wheel zoom panning
- **Preview mode for memory panels** — Project Memory and Workspace Instructions panels now support markdown preview mode
- **Panel rotation** — clicking a right-panel title promotes it to the main area for focused viewing
- **Linux GUI release build** — CI now produces a Linux GUI release artifact

### Improved

- **Studio tab icon** — Resource tab renamed to Studio with a Layers icon for clarity
- **Workspace state persistence** — workspace view state is preserved across tab switches; re-clicking Tasks exits the workspace
- **Panel height** — main area panels now fill full height correctly (motion.div, section, and preview div)

### Fixed

- **UX polish & stale closures** — code review pass: ESC conflict resolution, stale closure fixes, and UX refinements
- **Redundant maximize badge** — removed Maximize2 badge from main panel when content is already in main view
- **Panel rotation polish** — sidebar conditional classes, click padding, and Maximize2 tooltip improvements
- **Syntax highlighting in FilePreviewDrawer** — code files now render with proper syntax highlighting
- **ImageLightbox click wiring** — onImageClick correctly wired into MarkdownRenderer in ACP Chat messages
- **CI lockfile & env var** — fixed pnpm frozen lockfile check and `GROVE_GUI` env var reference in README

## [0.8.8] - 2026-04-13

### Added

- **IDE layout mode** — new IDE layout with a task switcher popup for quickly jumping between tasks
- **Live artifact preview refresh** — artifact preview panel now auto-refreshes while the agent is busy, showing real-time output

## [0.8.7] - 2026-04-12

### Added

- **Hermes / Kiro / OpenClaw agents** — added three new agent presets; agent list is now sorted alphabetically
- **ACP 0.10 support** — bumped ACP protocol to version 0.10
- **Studio project support** — new Studio page with resources, artifacts, and working directory management

### Improved

- **Studio resource layout** — optimized Studio project resource panel layout
- **Studio memory editor** — merged memory editor panel into Studio, resolving conflicts
- **API handler organization** — modularized handlers and unified error/studio patterns for cleaner code

### Fixed

- **API code review findings** — deduplicated logic, unified patterns, and fixed error handling across project/task/artifact handlers
- **Empty Blitz list after migration** — `task_group_slots` is now populated on migration, fixing the blank Blitz list bug
- **Radio cancel gesture + audio config** — added cancel gesture support, audio configuration, and recording quality improvements

## [0.8.6] - 2026-04-07

### Fixed

- **Radio session selection on task switch** — Radio now sends the correct target (mode + chat_id) from the tapped slot's state so Blitz switches to the right session instead of always the newest
- **Busy state on reconnect** — server sends current `Busy` state when a WebSocket reconnects to an existing ACP session, preventing stale idle/busy display after task switches
- **Chat list ordering** — Radio session dropdown now shows newest sessions first
- **TaskChat state isolation** — added `key` prop to force clean remount on task switch, preventing busy state leaking between tasks
- **WS message routing race** — `activeChatIdRef` is now synced immediately on chat switch, preventing messages from the old session polluting the new one
- **External chat switch consistency** — `grove:switch-chat` event handler now uses full `switchChat` logic (save/restore state, sync ref) instead of bare `setActiveChatId`
- **Radio hold-start target** — hold-to-record now reads the target slot's mode/session state instead of the previous slot's
- **Stale pending chat cleanup** — `__grove_pending_chat` is cleared at the start of each focus event to prevent stale values from previous tasks
- **macOS-only keychain code** — added `cfg(target_os = "macos")` to suppress dead_code warning on other platforms

## [0.8.5] - 2026-04-07

### Added

- **Radio Chat/Terminal mode switching** — per-task mode toggle on Radio page; voice transcripts can be sent to a chat session or directly to the terminal
- **Real-time Blitz sync** — Radio mode/session changes preemptively switch Blitz desktop panel (chat tab, terminal tab, or specific chat session) via SetTarget messages
- **Terminal input from Radio** — voice transcripts in terminal mode are injected into the desktop terminal via cached WebSocket with proper carriage return handling
- **ACP busy state push** — agent busy/idle transitions broadcast `RadioEvent::TaskBusy` for instant Radio status light updates, replacing pure 2-second polling
- **Chat session switching** — Radio session dropdown triggers `grove:switch-chat` CustomEvent so Blitz chat panel switches to the selected session

### Improved

- **Radio group ordering** — `_main` group is always displayed first, matching Blitz sidebar order
- **Blitz UI cleanup** — removed aurora background effect, outer padding, and rounded corners from main content area and TaskInfoPanel

### Fixed

- **Auto-scroll on Radio messages** — chat view now auto-scrolls to bottom when receiving user messages from Radio
- **AnimatePresence ref clearing** — callback ref prevents exit animation from nullifying `taskViewRef`, fixing broken panel switching after task changes
- **Auto-migration scope** — SQLite migration only runs for UI startup commands (Tui/Web/Mobile/Gui), not CLI subcommands

## [0.8.4] - 2026-04-06

### Added

- **SQLite storage backend** — migrated projects, taskgroups, AI providers/audio, and skills from file-based TOML/JSON to a single `~/.grove/grove.db` database with WAL mode, transactions, and busy_timeout for multi-process safety
- **Auto-migration (v2.0)** — startup detects legacy storage versions and chains migrations (1.0 → 1.1 → 2.0); original files left untouched for safe rollback
- **`grove migrate --prune`** — removes legacy files after confirming SQLite migration is correct
- **Grove Radio walkie-talkie** — TaskGroup-based dispatch system with channel grid, frequency bands, and real-time WebSocket synchronization
- **Agent usage quota badge** — displays Claude Code, Codex, and Gemini usage quotas with visual progress indicators
- **Non-git project support** — register and manage plain directories without git initialization

### Improved

- **Storage atomicity** — all write operations (upsert, delete, renumber) wrapped in SQLite transactions; cascading cleanup on project deletion with position renumbering
- **Skill hash stability** — `compute_repo_key` switched from `DefaultHasher` to FNV-1a for cross-Rust-version determinism; migration remaps existing keys
- **Task group lifecycle** — `create_task` auto-assigns to system groups and broadcasts GroupChanged; `delete_project` notifies Radio/Blitz clients
- **Markdown renderer** — restored inline code FileChip navigation and styled fenced code block containers; added CJK/Unicode file path support

### Fixed

- **Page scroll lock** — fixed body overflow when switching between views
- **Tool section timing** — corrected ACP tool call display order in chat
- **Permission serialization** — fixed permission prompt data marshaling
- **Review refresh** — resolved stale review panel after task operations
- **Session name tests** — adapted to dynamic `MAX_SESSION_NAME_LEN` based on platform socket path limits

## [0.8.3] - 2026-04-03

### Added

- **Mermaid diagram rendering** — markdown code blocks with `mermaid` language are rendered as interactive diagrams in preview and chat
- **Extensible preview renderer system** — new `PreviewRenderer` registry supports markdown, mermaid, SVG, and image file previews without if/else chains
- **SVG file preview** — `.svg` files render as inline graphics in the review preview drawer
- **Image file preview** — `.png`, `.jpg`, `.webp`, `.gif` files preview via API in the review drawer
- **Mermaid/MMD file preview** — `.mmd` and `.mermaid` files render as diagrams in the review preview drawer
- **Display Mode toggle** — cycle button (Code / Split / Preview) to batch-control preview state across all files in review

### Improved

- **Unified markdown rendering** — migrated `CommentsTab` from raw `ReactMarkdown` to shared `MarkdownRenderer` component
- **Agent icons** — replaced `@lobehub/icons` dependency with lightweight local SVG icons, removing heavy transitive deps (`es-toolkit`, `antd`)
- **CJK path support** — added `git_unquote()` utility to decode git's octal-escaped non-ASCII paths across all git operations (`list_files`, `diff_stat`, `conflict_files`, `get_raw_diff`, watcher)

### Fixed

- **Terminal crash loop** — disposed stale terminal cache when WebSocket is dead, preventing flash-close loop on reopen
- **All Files mode missing CJK files** — files with Chinese/Japanese/Korean names were filtered out due to git's octal path escaping

## [0.8.2] - 2026-04-02

### Added

- **Attachment labeling system** — attachments now display sequential labels (Image #1, Audio #2, File #3) with hover badges for inserting reference chips into chat
- **Workspace tab switching** — added Cmd+Shift+[/] keyboard shortcut for switching between workspace tabs

### Improved

- **Chat auto-scroll** — replaced IntersectionObserver with wheel/touch tracking for more reliable auto-scroll behavior
- **Chat input layout** — dynamic bottom padding via ResizeObserver ensures chat input area adapts correctly
- **Polling performance** — polling effect uses ref to avoid unnecessary restarts; blob URLs revoked on attachment clear to prevent memory leaks
- **Tail signature performance** — uses content length instead of full string comparison

### Fixed

- **Slash commands** — buffered WebSocket events now processed correctly for slash command responses
- **ACP session race condition** — upsert session.json for AvailableCommands to fix startup race condition
- **ACP exit code** — exit_code clamped to non-negative before u32 cast
- **Review page empty file** — empty file content no longer shows error (added null check)

## [0.8.1] - 2026-04-01

### Added

- **CLI project management commands** — new `grove register` and `grove remove` commands for managing projects directly from the command line
- **Dashboard redesign** — redesigned Dashboard with Hero section, Pulse activity view, Repo Control panel, and onboarding guidance
- **Work sidebar tab** — split Local task into a dedicated Work tab in the sidebar for better task organization

### Improved

- **Terminal instance caching** — terminal instances are now cached across task switches, preserving session state and avoiding unnecessary re-creation
- **Settings redesign** — redesigned Terminal and Chat settings pages with unified session creation flow
- **Chat session recovery** — refined chat session recovery and workspace UX improvements

## [0.8.0] - 2026-03-30

### Added

- **AI settings page** — new settings page with audio transcription configuration and AI provider management
- **Bulk comment cleanup** — review comments can now be bulk-resolved with status and author filters

### Improved

- **ACP chat session management** — refined session management UI with optimized chat history loading and prevention of load_session replay duplication
- **ACP chat tool display** — improved tool call rendering UX in chat conversations
- **ACP chat stability** — fixed message state drift, review resolve behavior, observer mode, and overall chat UI stability
- **MCP upgrade** — upgraded rmcp to 1.3 with inlined nested schemas for better agent compatibility

### Fixed

- **Weekly activity chart** — corrected bar rendering in the weekly activity chart

## [0.7.14] - 2026-03-26

### Added

- **Image lightbox** — clicking image thumbnails in chat (both input attachments and sent messages) now opens a fullscreen lightbox overlay with Escape key support, replacing the previous open-in-new-tab behavior

### Improved

- **ACP package migration** — `claude-code-acp` has been renamed to `claude-agent-acp`. Settings now prefer the new package, with automatic fallback to the deprecated name. Users with only the old package see a single upgrade banner with copy-to-clipboard install command

## [0.7.13] - 2026-03-26

### Added

- **Shell mode** — press `!` in chat to execute terminal commands directly, bypassing the AI agent. Commands run in the task's worktree with real-time streaming output, exit code display, and kill support via the stop button
- **GUI daemonize** — `grove gui` now forks to background and releases the terminal immediately. Closing the terminal no longer kills the GUI window. Logs written to `~/.grove/gui.log`

### Improved

- **Chat history compaction** — terminal output chunks are now merged during history compaction, preventing unbounded history file growth
- **Chat history replay** — unresolved terminal executions are automatically cancelled on reconnect, preventing stuck "running..." indicators
- **ESLint cleanup** — removed unnecessary eslint-disable comments across the codebase, fixing root causes instead of suppressing warnings

## [0.7.12] - 2026-03-25

### Added

- **Chat file path navigation** — clicking file path links in ACP Chat messages now opens the Review panel in All Files mode, scrolls to the target file and line, with a flash highlight animation
- **Chat attachment resource links** — chat attachments can now include resource links
- **Grove MCP server injection** — ACP sessions now have the Grove MCP server injected for task orchestration

### Fixed

- **Permission prompt resolution** — fixed permission prompt targeting to resolve against the correct chat session
- **CI build** — use pnpm for eslint CI job; use Node 20 LTS to avoid npm exit handler crash; add .npmrc with legacy-peer-deps for React 19

### Improved

- **UI selection behavior** — refined selection behavior and chat interactions across the web frontend

## [0.7.11] - 2026-03-24

### Added

- **Context-aware command palette ranking** — command suggestions are now ranked by page context and usage intent, with a dedicated ranking utility shared across Blitz and Tasks pages

### Changed

- **Task Chat composer redesign** — the Web chat composer now uses a floating, narrower workbench-style layout with integrated Todo/Plan/Pending controls, relocated Model/Mode controls, and improved panel toggling behavior
- **Task Chat busy state styling** — replaced the previous SVG-based busy border treatment with a border-focused animated highlight implementation
- **Terminal theme settings** — Web terminal theme selection is now aligned with the app theme model and no longer relies on the old standalone terminal theme config path

### Improved

- **Web terminal interactions** — improved terminal hotkeys, tab lifecycle handling, and backend terminal event behavior for better focus/restore behavior inside FlexLayout
- **Tasks page command palette flow** — palette switching behavior on the Tasks page is more reliable and consistent when moving between views

### Fixed

- **Task palette switching** — fixed incorrect command palette context switching on the Tasks page
- **Terminal lifecycle edge cases** — fixed several Web terminal lifecycle and hotkey edge cases across the frontend and terminal handler

## [0.7.10] - 2026-03-24

### Changed

- **Workspace redesign** — removed top toolbar and left sidebar activity bar; workspace now has a clean two-layer layout: breadcrumb bar + FlexLayout tabs
- **Workspace bar** — new breadcrumb bar with back button, project name, task name, branch info, and inline git action buttons (Commit/Merge/Sync + overflow menu)
- **Panel add menu** — moved to FlexLayout tab bar [+] hover dropdown; includes all panel types (Chat/Terminal/Review/Editor/Stats/Git/Notes/Comments)
- **Sidebar Search** — added Search button with ⌘K shortcut hint to app sidebar footer
- **Empty workspace state** — shows quick-add panel buttons and ⌘K hint when no panels are open
- **Default workspace** — new workspaces start empty; user chooses what to open (saved layouts still restore)

### Improved

- **Workspace padding** — reduced from 24px to 8px in workspace mode, maximizing content area
- **Workspace transition** — smooth scale + opacity animation when entering/exiting workspace
- **Tab numbering** — panel numbers now based on max existing number +1 instead of ever-incrementing counter; resets properly when all tabs close
- **Comments icon** — now uses MessageCircle to distinguish from Chat's MessageSquare
- **Maximize button** — shows Minimize2 icon when panel is maximized for clearer restore affordance
- **Code quality** — translated all Chinese comments to English, removed dead code, wrapped handlers in useCallback, fixed stale closure dependencies

## [0.7.9] - 2026-03-23

### Changed

- **Unified task display** — merged "Current Branch" and "Other Branch" tabs into a single "Active Tasks" tab; tasks from all branches are now shown together with target branch labels
- **Cross-branch merge** — merge now works regardless of which branch you're on; automatically checks out the target branch, merges, and returns to the original branch
- **Local Task Review** — Local Task now compares against the default branch (main/master) instead of HEAD, enabling meaningful code review diffs
- **Task type icons** — replaced status-based icons with type-based icons: Laptop (local), ⚡ (agent), Code (regular); consistent across TUI and Web
- **New Task dialog** — target branch is now selectable via dropdown with loading indicator and click-outside-to-close

### Improved

- **Performance: lazy file changes** — removed `file_changes` (additions/deletions) computation from task loading; data is now fetched on-demand via the diff API when viewing task details, dramatically improving load times for large projects
- **Performance: non-blocking API** — heavy git I/O handlers (`get_project`, `list_tasks`, `get_task`, `get_stats`) now run on tokio's blocking thread pool via `spawn_blocking`, preventing one slow project from blocking all other API requests
- **Performance: removed live_count computation** — project listing no longer checks session existence for every task, reducing unnecessary subprocess calls

### Fixed

- **Merge checkout warning** — if checkout back to the original branch fails after a successful merge, the warning is now displayed to the user instead of being silently ignored
- **DirtyBranchDialog** — improved error messages for main repository uncommitted changes vs worktree uncommitted changes

### Removed

- **"X live" display** — removed live task count from project selector and project cards (preparing for status model simplification)
- **File changes in task list** — removed +additions/-deletions display from task list items and TUI worktree table (data available on-demand in task detail view)

## [0.7.8] - 2026-03-19

### Added

- **Local Task** — lightweight non-worktree task per project for quick notes and planning without creating a git worktree
- **ACP: Cursor Agent and Junie support** — added new agent types with unified agent icon system
- **ACP: Plan file content embedding** — `PlanFileUpdate` events now embed the full plan file content; bottom panel UX improvements
- **Web: VSCode file icons in Review Panel** — All Files mode now displays VSCode-style file/folder icons instead of generic "M" status badges

### Fixed

- **Web: Tool section auto-expand logic** — improved auto-expand behavior and summary text for tool sections in chat
- **CI: Rust cache cross-tag sharing** — fixed cache key strategy and added full cache warm-up step

## [0.7.7] - 2026-03-03

### Added

- **Statistics page** (beta) — project-level productivity analytics with flexible time range picker; sections include AI Work Breakdown (tool calls/task, plans/task, spec-length vs interventions scatter), Review Intelligence (AI adoption rate, hit rate, rounds-per-fix), and Agent Leaderboard (canonical name aggregation, work + review panels); backed by a real `GET /api/v1/projects/{id}/statistics` API with lazy range aggregation and code snapshot on task archive

## [0.7.6] - 2026-03-02

### Added

- **GUI: macOS app bundle support** — detects `.app/Contents/MacOS/` launch path and forces GUI mode; expands `PATH` from login shell on startup so `tmux`, `claude`, and `fzf` are found correctly inside the bundle
- **GUI: In-app updates** — download progress bar and restart dialog for AppBundle installs; new `/api/v1/app-update/{start,progress,install}` endpoints; CI now produces a universal (arm64 + x86_64) DMG via `build-macos-dmg` job
- **Web: Branch drawer task actions** — all tasks in the branch drawer are now clickable and expand an action menu; active tasks support Go To Task (current branch only), Rebase (reuses `RebaseDialog` with branch picker), Archive, and Clean; archived tasks section (collapsed by default) supports Recover and Clean; dialogs open without closing the drawer

### Fixed

- **Web: Branch drawer shows archived tasks** — backend `get_project` now explicitly loads archived worktrees so they appear in the Active/Archived sections of the branch drawer
- **Web: Sidebar task counts update after mutations** — `refreshSelectedProject` now also refreshes the project list so the "x tasks • y live" counts in the project selector stay in sync after Archive, Clean, Recover, and New Task operations
- **Web: Diff review refresh reloads comments** — clicking the refresh button on the review page now reloads both the diff and the review comments simultaneously
- **Web: Branch drawer backdrop gap** — fixed a white strip at the bottom of the backdrop caused by Tailwind v4 `space-y-6` adding `margin-bottom` to the fixed overlay; resolved with `m-0`

## [0.7.5] - 2026-02-28

### Added

- **Web: Plan panel** — detect when an ACP agent writes a `.md` file via the Write tool in Plan Mode and render it in a collapsible panel with Markdown; auto-refreshes on subsequent Write or Edit operations to the same file
- **Web: Diff review refresh button** — added a refresh button to the diff review page header for manual reload
- **Web: Markdown preview** — added preview mode for `.md` files with hotkey toggle
- **Web: Full-window file drop zone** — drag-and-drop area now covers the entire Chat window instead of just the input area
- **MCP: ACP Chat management tools** — orchestrator agents can now create chats, send prompts, and read chat history via `grove_create_chat`, `grove_send_prompt`, `grove_list_chats`, `grove_read_chat_history` MCP tools
- **MCP: `grove_edit_note` tool** — orchestrator agents can programmatically edit task notes
- **MCP: Context-aware tool filtering** — tools are dynamically filtered by task context; orchestrator agents see management tools, worker agents see execution tools
- **MCP: Fuzzy search for query parameters** — `grove_list_projects`, `grove_list_tasks`, and `grove_list_chats` now support fuzzy matching (substring, word-prefix, and initials) instead of strict contains
- **MCP: `plan_file` in chat status** — `grove_chat_status` now returns the plan file path for orchestrator agents
- **Web: Read-only observation mode** — when a chat session is owned by another process (e.g., MCP agent), the Web UI enters read-only mode with 5s polling instead of showing an error
- **Web: Take Control button** — reclaim chat ownership from a remote agent directly in the Web UI
- **Web: Message sender labels** — messages sent by orchestrator agents display a sender badge (e.g., "Claude Code (Orchestrator)") to distinguish from user messages
- **`created_by` field for tasks** — tracks whether a task was created by an agent or a user
- **API: `/api/v1/read-file`** — new endpoint for reading `.md` files by absolute path (used by Plan panel)

### Fixed

- **Web: code block splitting in diff preview** — prevented code blocks from being split across chunks; unified line-level coloring
- **Web: auto-collapse panels on input expand** — Todo and Plan panels automatically collapse when the input area is expanded to keep bottom buttons visible
- **Web: chat deletion cleanup** — deleting a chat now removes the per-chat data directory and socket file, not just the `chats.toml` entry
- **Web: Blitz mode UX** — removed unnecessary polling, fixed mode switch issues, added dirty branch confirmation dialog
- **Web: auto-save notes on navigation** — notes are now saved automatically when navigating away during editing
- **Web: Blitz mode projectId passthrough** — GitTab, NotesTab, and CommentsTab now receive correct projectId in Blitz mode
- **MCP+ACP: chat message duplication** — fixed flaky MCP tests and ACP chat message duplication bug
- **MCP: planning vs execution tool clarity** — improved tool descriptions and categorization for task context filtering
- **ACP: mode tracking from SetMode commands** — `current_mode_id` is now updated from user SetMode commands (not just agent notifications) and emits `ModeChanged` events for frontend/history consistency
- **Code Review fixer** — fixed review comment resolution workflow

### Changed

- **Web: renamed Plan → Todo, Plan File → Plan** — the structured checklist from ACP Plan notifications is now called "Todo"; the new markdown plan file panel is called "Plan" with a `BookOpen` icon

## [0.7.4] - 2026-02-26

### Added

- **Web: @ file mention in Review comments** — type `@` to reference files in code review comments, with autocomplete dropdown
- **Web: Chat chip UX improvements** — better interaction for ACP Chat tool content chips

### Fixed

- **Web: Info Panel overflow** — long commit messages and branch names no longer stretch the panel beyond its container; added `min-w-0` to flex parent containers in Zen and Blitz modes
- **Web: Info Panel header simplified** — removed Chat/Terminal/Review/Editor buttons from header (both desktop and mobile); Workspace button is the entry point
- **Web: commit messages wrap** — Git tab commit messages now wrap instead of truncating, showing full content
- **Web: ACP Chat tool content rendering** — improved display of tool use results in Chat panel
- **Web: Code Review file ordering** — consistent file ordering and scroll position tracking when switching between files
- **Web: smooth crossfade on task switch** — Blitz/Zen mode now uses smooth crossfade animation when switching between tasks
- **Autolink symlinks** — excluded from git tracking, Editor file tree, and Code Review
- **Panic handling** — spawned threads (ACP session, merge, file watcher) wrapped with `catch_unwind` to log panics instead of silently crashing; bare `unwrap()` replaced with descriptive `expect()` messages; `RUST_BACKTRACE=1` enabled by default

## [0.7.3] - 2026-02-25

### Added

- **Remote access (`grove mobile`)** — access Grove from your phone, tablet, or any device on the network
  - HMAC-SHA256 request signing — secret key never travels over the wire, each request independently signed with timestamp + nonce
  - Nonce-based replay prevention with ±60s timestamp window
  - `--tls` flag for self-signed certificate HTTPS encryption
  - `--cert`/`--key` flags for user-provided CA-signed certificates
  - `--host` flag to bind to a specific address, `--public` to bind to all interfaces
  - QR code printed in terminal — scan to connect instantly with embedded secret key
  - AuthGate component for secret key extraction and HMAC verification
  - Pure JS SHA-256 fallback for HTTP non-localhost contexts where Web Crypto API is unavailable
- **Docs: "Access Remotely" section** — added to landing page and README with security mode explanations
- **`grove tui` subcommand** — explicit command to launch the TUI, same as previous `grove` (no args) behavior
- **Smart launch mode resume** — `grove` (no args) now replays the last used launch mode (`tui`/`web`/`gui`/`mobile`) with all its arguments; defaults to TUI on first run

## [0.7.2] - 2026-02-24

### Added

- **Web: Project selector improvements** — better UX for projects with long or similar names
  - Wider dropdown width (`w-72`/`max-w-sm`) to show more of long project names
  - Middle truncation for project names: splits at separator near midpoint so both start and end are visible (e.g. `open_solu...video_sync`)
  - Type-to-filter search input with auto-focus when dropdown opens
  - Tooltip (`title` attribute) on project items to show full name on hover
  - Applied to both expanded and collapsed sidebar states
- **Web: @ file mention enhancements** — folders, path fixes, Notes support, and Shift+Tab mode cycling
- **Native macOS notifications** — uses `UNUserNotificationCenter` with custom Grove icon, replacing deprecated `NSUserNotification`

### Fixed

- **ACP: Chat history real-time persistence** — write chat history to disk in real-time instead of buffering per turn
- **ACP: Cancel timeout and history compact** — fixed cancel timeout, file snapshot diff, history compaction, and stderr redirect
- **Web: Terminal resize when tab hidden** — skip terminal resize when FlexLayout tab is hidden, preventing layout issues
- **Web: Tool progress display** — fixed tool progress display, slash menu scroll, and agent filter
- **Web: Escape key in terminal** — prevent Escape key from losing focus in xterm terminal
- **Web: Auto-start sessions** — auto-start terminal and chat sessions, removing the manual start step
- **Web: Project dropdown in collapsed sidebar** — show project dropdown when sidebar is collapsed
- **Duplicate task ID rejection** — reject duplicate task IDs against both active and archived tasks
- **Empty repo error UX** — improved error message for empty repositories with no commits
- **Duplicate task error message** — clearer duplicate task error message, removed symlink logs
- **Squash merge detection** — detect squash merge via diff fallback and block re-merge

## [0.7.1] - 2026-02-22

### Added

- **Homebrew tap** — `brew tap GarrickZ2/grove && brew install grove` now supported
  - Homebrew formula for macOS (ARM/Intel) and Linux (x64/ARM)
  - Release CI auto-updates formula with correct sha256 on each release
- **New brandmark and logo** — redesigned Grove icon and wordmark with theme-aware gradients
  - `GroveIcon` component with layered SVG design (trunk, canopy, accent dot)
  - `GroveWordmark` vectorized "GROVE" text with themed gradient fill
  - Shimmer animation on sidebar logo
- **Skill dialog redesign** — per-agent install/uninstall buttons in Manage Skill dialog
  - Each agent shows individual install state and action button
  - Replaces previous bulk install/uninstall flow

### Fixed

- **YAML block scalars in SKILL.md** — frontmatter parser now handles `>` (folded) and `|` (literal) block scalar syntax correctly
- **Dark theme text in FlexLayout** — overrode CSS variable collision (`--color-text`) that caused invisible text in dark themes
- **Toolbar panel duplication** — toolbar buttons now replace the active tab instead of creating duplicate panels
- **Logo accent not following theme** — G and E detail pieces in the wordmark now use a lighter variant of the theme gradient instead of a fixed gray color

## [0.7.0] - 2026-02-19

### Added

- **Skills management system** — full-stack skill marketplace for AI agents
  - Backend: storage layer, operations module, and REST API handlers for agents, sources, and skill installation
  - Frontend: SkillsPage with Agents, Sources, and Explore tabs
  - Sidebar navigation entry for the Skills page
- **Middle-click to close tabs** — FlexLayout panel tabs can now be closed with a middle mouse click, matching browser tab behavior

### Fixed

- **Notes editor Enter key** — pressing Enter in the Notes textarea now correctly inserts a newline instead of triggering Workspace navigation
- **Notes content lost on refresh** — Notes editing state no longer resets when the project refreshes in the background
- **IME composition conflicts** — Chinese/Japanese input method Enter key no longer triggers hotkeys or sends chat messages prematurely; fixed across global hotkeys, Chat input, chat title rename, and pending message edit
- **Version bump script path** — `bump-version.sh` now correctly targets `tauri.conf.json` instead of the old `src-tauri/tauri.conf.json` path

### Removed

- **UPDATE_NOTIFICATION.md** — removed obsolete documentation file

## [0.6.2] - 2026-02-18

### Fixed

- **Tauri GUI drag-and-drop** — disabled native drag-drop handler on WebviewWindow so HTML5 DnD works correctly; fixes FlexLayout tab dragging and file/image drop into chat input
- **Settings not syncing globally** — config changes in Settings page now refresh the global ConfigContext cache so other pages see updates immediately

### Changed

- **Dead code cleanup** — removed 11 unused files, 2 unused npm dependencies (`@vscode/codicons`, `react-file-icon`), ~30 dead function/component exports, and cleaned up barrel re-exports across the web frontend
- **Version management** — added `scripts/bump-version.sh` to sync version across Cargo.toml, Tauri config, and docs from a single source

## [0.6.1] - 2026-02-18

### Added

- **IDE-level FlexLayout workspace** — multi-panel drag-and-drop layout for the Web UI
  - Integrated TaskInfoPanel tabs (Stats, Git, AI Summary, Notes, Review) into FlexLayout
  - Panel-level fullscreen support
- **Three-state Terminal/Chat UX** — Terminal and Chat panels with independent show/hide toggles and dropdown positioning fix
- **Multimedia content support (ACP)** — image, audio, and resource content blocks in agent chat
- **Agent content adapter** — per-agent tool call content rendering with system-reminder stripping for Claude
- **Agent picker for new chat** — "+" button now opens a dropdown to select which agent to use, with ACP availability detection; unavailable agents are hidden
- **Expandable chat input** — resizable text input area; tab double-click to rename chat

### Fixed

- **Chat connectivity and UI issues** — fixed WebSocket reconnection and various chat panel bugs
- **Terminal session type resolution** — resolve session type from task config instead of multiplexer field

## [0.6.0] - 2026-02-17

### Added

- **Agent Client Protocol (ACP)** — built-in chat interface for AI coding agents
  - Full ACP client implementation with JSON-RPC over stdio (`src/acp/mod.rs`)
  - Real-time streaming of agent messages, thoughts, tool calls, and plan updates
  - WebSocket bridge for live chat in the Web UI (`TaskChat.tsx`)
  - Permission request handling with approve/deny UI
  - `grove acp` CLI for headless agent sessions
- **Multi-chat support** — multiple chat sessions per task
  - Create, rename, delete, and switch between chat sessions
  - Each chat maintains independent conversation history with the agent
  - Chat list sidebar with active session indicator
- **Multi-agent support** — configure and switch between different AI agents
  - Built-in agents: Claude Code, Codex, Aider, Amp, OpenCode
  - Custom agent management: add local (command) or remote (URL) agents
  - Per-chat agent selection with model/mode configuration
  - `CustomAgentModal` for adding/editing/deleting custom agents
- **@ file mentions** — reference files directly in chat input
  - Type `@` to trigger file picker with fuzzy search
  - Selected files are injected as context into the agent prompt
- **Plan panel** — dedicated panel for viewing agent's implementation plan
  - Collapsible plan view alongside chat messages
  - Real-time plan updates during agent execution
- **Chat history persistence** — conversations saved to disk
  - JSONL format with turn-level compaction (merges chunk streams, tool call updates)
  - Automatic replay on WebSocket reconnection
  - Stored in `~/.grove/projects/{project}/tasks/{task_id}/chats/{chat_id}/history.jsonl`
- **Server-side message queue** — pending message queue with pause/resume
  - Messages queued during WebSocket disconnection, replayed on reconnect
  - Concurrent prompt cancellation support
- **Terminal protocol** — shell mode integration for ACP agents
  - Shell mode shortcut for quick terminal access within chat

### Changed

- **Storage layout migrated to task-centric structure** — `grove migrate` command
  - Per-task data consolidated into `tasks/<task-id>/` directories
  - Notes: `notes/<id>.md` → `tasks/<id>/notes.md`
  - Reviews: `review/<id>.json` → `tasks/<id>/review.json`
  - Activity: `activity/<id>.jsonl` → `tasks/<id>/activity.jsonl`
  - Automatic migration on first run, with `storage_version` tracking in config
- **Legacy backward-compat code removed** — cleaned up obsolete compatibility layers
  - Removed `chats_legacy` field and auto-migration from Task struct
  - Removed `location` string fallback from review comment API
  - Removed unused `migrateLayoutConfig` function
  - Removed legacy uppercase pane type colors, unified presets to lowercase

### Fixed

- **New Task dialog field colors** — swapped editable/readonly field colors for correct visual hierarchy

## [0.5.0] - 2026-02-14

### Added

- **AutoLink** — automatic symlink creation for worktrees
  - Symlinks node_modules, IDE configs (.vscode, .idea), and build artifacts (target, dist) from main repo to worktrees
  - Configurable glob patterns with gitignore checking for safety
  - TUI and Web UI configuration panels with preset patterns
  - Significantly reduces setup time for new tasks (no re-install, no re-build)
- **Second reminder for unsubmitted tasks** — additional notification when task remains unsubmitted after archiving
- **Remote branch lazy loading** — on-demand loading of remote branches in Web UI for better performance with large repositories
  - Collapsible remote sections (origin, upstream) with automatic folder expansion
  - Filters invalid remote branch names
  - Auto-updates task target branches when switching in main repo
- **Operation layer refactoring** — unified task operations (create/archive/recover/reset/merge/sync) eliminating TUI/Web duplication
  - New `src/operations/tasks.rs` module as single source of truth
  - 331 lines of duplicate code removed across TUI and Web API
  - Type-safe error handling with existing GroveError/Result

### Fixed

- **Editor file tree refresh** — files now appear/disappear immediately after create/delete operations
  - Includes untracked files (via `git ls-files --others`)
  - Filters out deleted files still in git index
- **Git push upstream** — auto-set upstream when pushing new branches (fixes "no upstream branch" error)
- **Terminal performance** — XTerminal component properly unmounts when hidden, avoiding layout resize overhead
- **Blitz keyboard shortcuts** — Command key state now handled via CSS to prevent text selection loss
- **Archive confirmation UX** — professional wording and improved error messages
  - "Worktree" → "Working tree", clearer warning symbols
  - Unified wording between TUI and Web interfaces
- **Dangerous hotkeys removed** — removed accidental Archive/Clean/Reset hotkeys in Blitz mode
  - 'a' (Archive), 'x' (Clean), 'r' (Reset) removed; require menu access with confirmation
  - Added proper 'r' (Review), 'e' (Editor), 't' (Terminal) shortcuts aligned with TasksPage
- **Context menu positioning** — fixed overflow issues near viewport edges in Editor

### Changed

- **Hooks refactored** — custom hooks architecture in Web frontend eliminates code duplication
  - `useTaskPageState` (~250 lines): page-level state management
  - `useTaskNavigation` (~70 lines): j/k navigation logic
  - `usePostMergeArchive` (~160 lines): post-merge archive workflow
  - `useTaskOperations` (~450 lines): all task Git operations
  - BlitzPage: 1100 → 675 lines (-39%), TasksPage: 1154 → 610 lines (-47%)
- **AutoLink config simplified** — always enabled, always checks gitignore
  - Moved to Development Tools section in Web UI
  - Removed redundant enable/check_gitignore toggles

### Performance

- **Get Project API optimized** — 70% faster with data reuse and parallelization
  - Get Project: 1600ms → 480ms (3.3x faster)
  - Convert to response: 1200ms → 80ms (15x faster)
  - FileChanges struct extended with `files_changed` field for zero-cost file counts
  - Parallel worktree processing using rayon

### Documentation

- **CLAUDE.md** — added Web frontend build requirement documentation
- **MCP config** — updated to `~/.claude.json` path, added CodeX example

### Removed

- **Dead code cleanup** — removed unused Dashboard and TaskDetail components from Web UI

## [0.4.13] - 2026-02-11

### Added

- **Web: Comment filtering in Comments tab** — Filter comments by status (All/Open/Resolved) with Outdated included under Open status
- **Web: File system operations in Editor** — Context menu support for file operations in the Editor mode
- **Web: Review/Editor keyboard shortcuts** — Removed dangerous action hotkeys and added mode-specific keyboard shortcuts

### Fixed

- **Review: Markdown rendering spacing issues** — Unified markdown rendering using MarkdownRenderer component for consistent spacing between Review comments and Notes
  - Removed `white-space: pre-wrap` inheritance from diff table that was preserving markdown source newlines
  - Added `[li>&]:mb-0` to remove margin from paragraphs inside list items
  - Fixed excessive spacing between list items in comments
- **Review: Auto-expand navigation improvements** — Enhanced comment navigation experience
  - Auto-expand collapsed code chunks when navigating to comments
  - Auto-expand collapsed files when navigating to comments
  - Auto-expand comment cards when clicking from Conversation panel
  - Use `end_line` instead of `start_line` for navigation (comments render at end_line)
  - Added retry mechanism for async gap expansion
- **Review: Comment line number clamping** — Comments with line numbers exceeding file length now render at the last line (frontend logic)
  - Properly handles both ADD and DELETE sides
  - Works for all comment statuses (resolved/open/outdated)
  - Pure view layer logic, doesn't modify backend data
- **Review: Outdated comment line number clamping** — Outdated comments now clamp to file's last line when anchor exceeds file length
- **Web: Panel switching optimization** — Improved animation performance and state management for panel transitions
- **Web: Viewed status tracking** — Fixed viewed status tracking for files in All Files mode
- **Review: CSS color variable fix** — Replaced undefined `--color-primary` with `--color-highlight`

### Documentation

- **CLAUDE.md: Web frontend build requirement** — Added documentation for web frontend build process

## [0.4.12] - 2026-02-11

### Added

- **Web: Version update notification** — Web and GUI now show a compact, auto-dismissing notification banner when a new version is available
  - New API endpoint `/api/v1/update-check` reuses TUI's update detection logic
  - 24-hour cache to avoid frequent GitHub API requests
  - Displays in top-center with version info and quick actions
  - Auto-dismisses after 10 seconds, persists dismissal per browser session
  - "View Release" button links to GitHub releases page
  - "Copy Command" button copies install script to clipboard
- **Review: Code search with Ctrl+F** — Full-text code search across diff view with match highlighting
  - Ctrl/Cmd+F opens floating search bar
  - Real-time match counting (e.g., "3/15")
  - Navigate between matches with Enter/Shift+Enter or arrow buttons
  - Works in both syntax-highlighted and plain text code
  - Case-sensitive search toggle
  - Current match highlighted with orange outline
  - Auto-scroll to matches with smooth animation
- **Blitz: Quick task navigation shortcuts** — Hold Command/Ctrl to see numbered badges (1-9,0) on first 10 tasks, press Command+number to instantly select that task
- **Blitz: Drag-to-reorder tasks** — Drag task cards to reorder them in the list
  - Visual feedback during drag (opacity change, border indicator)
  - Custom sort order persists in session state
  - Smooth animations and cursor changes

### Fixed

- **Worktree paths registered as separate projects** — Worktree directories are now properly excluded from project registration, preventing nested project clutter in the projects list
- **Review: Comment collapse button not working** — File-level comment collapse/expand functionality now works correctly with proper state management
- **Review: Outdated comments auto-collapsing** — Changed auto-collapse logic to only affect resolved comments, not outdated ones

## [0.4.11] - 2026-02-09

### Fixed

- **Unified diff multi-line comment button not appearing** — cross-side text selections in unified view now correctly show the comment button (side check restricted to split mode only)
- **Comment author showing "You" instead of git user name** — comment creation and replies now use `git user.name` from worktree config as default author, passed through frontend → API → backend
- **Comment placed at wrong line when anchor text has multiple matches** — `find_anchor()` now collects all matches and picks the one closest to the original line number, preventing relocation to earlier occurrences of common patterns like `if err != nil {`

## [0.4.10] - 2026-02-09

### Fixed

- **MCP review tools missing structured comment IDs** — `grove_read_review`, `grove_add_comment`, and `grove_reply_review` now return structured JSON responses with explicit `comment_id` fields, enabling AI agents to reliably extract IDs and reply to comments
- **Zellij sessions missing environment variables** — Zellij sessions now inject `GROVE_*` env vars via KDL layout `export` prefix in all pane commands
- **Review: Comment Detail Modal not refreshing after reply** — expanded comment now derives from latest comments array by ID, so replies appear immediately
- **Review: Esc key in Comment Detail Modal exiting Review mode** — Esc now uses layered capture-phase handling: closes reply form first, then modal, without propagating to parent

### Added

- **Project name tag** — task headers now display the project name as an inline tag badge next to the task name (TaskInfoPanel, TaskView header, and compact toolbar)

### Changed

- **Blitz mode: removed task float-to-top** — selecting a task no longer reorders the list; tasks stay in their natural sort order
- **Blitz mode: single-click enters terminal** — clicking a task now directly opens the terminal view (previously required double-click)
- **Blitz mode: periodic card sweep effect** — selected task card shows a subtle left-to-right highlight sweep that repeats every few seconds
- **Review: Conversation Sidebar filtered in Changes mode** — comments are now filtered to only show those belonging to files visible in the current diff
- **Review: Conversation Sidebar click behavior** — project comments expand on click; file comments navigate to file; inline comments scroll to the exact line
- **Review: Comment Detail Modal Reply button** — now uses theme highlight color instead of muted gray

## [0.4.8] - 2026-02-08

### Fixed

- **Icon loading race condition** — fixed race condition in app icon extraction caused by shared temp file names
  - Now uses unique temp files (target path + nanoseconds) to prevent conflicts
  - Improved cache naming: uses bundle_id instead of hash for better readability
  - Reduced browser cache from 24h to 5min, added ETag for validation
- **Git commit button** — fixed button that was only showing toast, now properly opens commit dialog
- **Git tab 404 errors** — fixed by checking archived tasks in addition to active tasks
- **Settings accordion behavior** — now properly closes other tabs when opening a new one

### Added

- **VSCode-style file icons** — file tree now uses vscode-icons-js library for proper file type icons
  - Replaced generic colored icons with specific file type icons

### Changed

- **TaskInfoPanel close button** — replaced confusing ArrowLeft icon with X icon for better UX
  - Clearer visual distinction between "close panel" and "collapse panel" actions

## [0.4.7] - 2026-02-08

### Changed

- **MCP `grove_reply_review`** — now only appends reply text, no longer changes comment status; added `author` field support
- **MCP `grove_add_comment`** — switched from `location` string to structured parameters (`file_path`, `start_line`, `end_line`, `content`, `author`)
- **MCP `grove_complete_task`** — description now emphasizes ONLY call when user explicitly requests; never automatically

### Added

- **`update_comment_status()` storage API** — dedicated function for changing comment open/resolved status, separated from reply logic
- **`PUT .../review/comments/{commentId}/status` REST endpoint** — Web UI now uses this dedicated endpoint for Resolve/Reopen actions
- **`updateCommentStatus()` frontend API** — new client function calling the status endpoint

## [0.4.5] - 2026-02-06

### Added

- **Blitz mode** — cross-project Active Tasks aggregation view
  - Aggregates active tasks from all registered projects into a single list
  - Card-style task items with project name badges and code change stats
  - Notification-aware sorting (critical > warn > notice), then by updatedAt
  - Selected task floats to top with smooth layout animation
  - Aurora background effect with slow rotating conic gradient
  - Staggered entrance animation with amber shimmer loading effect
  - Full keyboard shortcut support (j/k navigation, all task actions)
  - Reuses TaskInfoPanel, TaskView, and all dialog components from Zen mode
- **LogoBrand component** — artistic mode indicator replacing plain logo text
  - Zen: Leaf icon with emerald-to-violet gradient, vertical fade transition
  - Blitz: Zap icon with amber accent, horizontal slide, lightning badge on logo
  - Click to toggle between Zen and Blitz modes
- **Mode transition effects** — component-level slide animations between Zen and Blitz

### Fixed

- **Duplicate projects in list** — `load_projects()` now deduplicates by path, keeping the newest entry
- **Infinite API loop on Manage Projects** — prevented re-render cycle caused by `isLoading` state toggling on refresh

## [0.4.4] - 2026-02-06

### Added

- **Hook Inbox** — notification center accessible via Bell icon in web sidebar
  - Popover displays all hook notifications across projects with level icons, timestamps, and messages
  - Click a notification to navigate to the corresponding project + task and auto-dismiss
  - Dismiss button (×) on each notification for manual clearing
  - Red badge on Bell icon shows unread count (9+ cap)
  - 5-second polling via React context (`NotificationProvider`)
- **Hook message support** — `grove hooks <level> --message "text"` attaches a message to notifications
  - TUI hook config wizard updated with new "Message" input step (4-step flow)
  - Web settings hook config updated with message input field
- **Task notification indicators** — colored dots (red/yellow/blue) next to task names in web task list
  - Clicking a task with a notification auto-dismisses it
- **Hooks REST API** — `GET /api/v1/hooks` lists all notifications, `DELETE /api/v1/projects/{id}/hooks/{taskId}` dismisses one
- **Enhanced hooks storage** — `HookEntry` model with `level`, `timestamp`, and optional `message`
  - Backward-compatible deserialization: old format (`task = "notice"`) parsed alongside new table format

## [0.4.3] - 2026-02-05

### Added

- **Monaco Editor panel** — new "Editor" button in Task view opens an embedded code editor
  - File tree sidebar (250px) built from `git ls-files`, with expandable directories
  - Monaco Editor with syntax highlighting and auto language detection (30+ languages)
  - `Cmd/Ctrl+S` to save files directly to the worktree
  - File read/write API with path traversal protection (`GET/PUT /api/v1/.../file?path=...`)
- **Editor button in Info panel** — click "Editor" from task details to enter terminal mode with editor open

### Changed

- **Toolbar action reorder** — Git actions (Commit, Rebase, Sync, Merge) now appear first, panel actions (Review, Editor) follow, in both Info panel and Terminal toolbar
- **Editor/Review mutual exclusion** — opening one panel automatically closes the other; terminal collapses for both

## [0.4.2] - 2026-02-05

### Added

- **Zellij multiplexer support** — use Zellij as an alternative to tmux for terminal sessions
  - Global multiplexer config in `config.toml` (`multiplexer = "tmux"` or `"zellij"`)
  - Per-task multiplexer tracking — each task records which multiplexer created it
  - Session dispatcher (`src/session/mod.rs`) routes all operations to tmux or zellij
  - Zellij session lifecycle: create (via `-s -n` layout), attach, kill, exists check
  - KDL layout generation for all presets (single, agent, agent-shell, 3-pane, custom)
  - ANSI-stripping for `zellij list-sessions` output parsing
  - Cleanup of EXITED sessions via `delete-session` before re-creation
  - Monitor mode: Leave shows toast with `Ctrl+o → d` hint (no programmatic detach API)
  - Monitor mode: Exit properly kills zellij session via dispatcher
- **TUI multiplexer selector** — new Config Panel step for choosing tmux/Zellij
  - Shows install status for each option, prevents selecting uninstalled multiplexer
- **Web multiplexer selector** — integrated into Environment settings
  - Dependency list split into base deps and multiplexer section with divider
  - Click tmux/zellij row to switch, "Active" badge on current selection
- **Environment check updated** — requires at least one of tmux or zellij installed

## [0.4.1] - 2026-02-05

### Added

- **Grove GUI (macOS)** — native desktop application using Tauri 2 WebView
  - `grove gui` launches a native desktop window sharing the same frontend as `grove web`
  - Built as optional Cargo feature (`--features gui`), enabled by default in macOS releases
  - Auto port fallback: if default port is in use, automatically tries the next available port
- **Theme-aware project icons** — project icon colors now adapt to the active theme
  - Ported per-theme accent palettes (10 colors) from TUI to web interface
- **Dynamic version display** — Welcome page now shows version from `Cargo.toml` via `/api/v1/version` endpoint
- **Markdown rendering** — Notes tab now uses `react-markdown` + `remark-gfm` for full GFM support
  - Headings (h1-h6), tables, code blocks, blockquotes, task lists, and more
- **Auto port fallback** — `grove web` and `grove gui` automatically try next port if default is in use (up to 10 attempts)
- **Merge with Notes injection** — task notes are automatically injected into merge commit messages (squash & merge-commit), works across TUI, Web, and MCP
- **File Search Bar** — fuzzy file search in Task Terminal view (`Ctrl+F` to focus)
  - Searches all git-tracked files in the task worktree
  - `Tab` to multi-select files, `Enter` to copy paths to clipboard, `Esc` to close
  - Fuzzy matching with path-segment-aware scoring and match highlighting

### Fixed

- **Git operation buttons blocking UI** — removed full-screen overlay during Pull/Push/Fetch/Commit; buttons now disable individually
- **Notes textarea not expanding** — fixed CSS flex layout issue where edit mode textarea didn't fill available space
- **Projects page navigation lag** — double-clicking a project now navigates instantly (loads details in background)
- **Toast notification position** — moved from top-right (blocking New Task button) to top-center
- **Toolbar dropdown menu clipped** — removed `overflow-hidden` from header container so "..." actions menu renders correctly

### Changed

- **CI/CD: macOS releases now include GUI support** — GitHub Release binaries for macOS (arm64/x86_64) are built with `--features gui`, providing TUI + Web + GUI in a single binary
- **Increased minimum GUI window size** — from 1100x700 to 1280x720 to prevent content clipping
- **Removed Welcome page icon glow effect** — cleaner logo appearance

## [0.4.0] - 2026-02-05

### Added

- **Grove Web** — full-featured web interface for managing Grove projects and tasks
  - Built with React + TypeScript + Vite, embedded directly in the binary
  - Dashboard view with repository overview, branch list, commit history
  - Projects page for managing multiple git repositories
  - Tasks page with full task lifecycle management (create, archive, recover, delete)
  - Integrated web terminal via WebSocket (xterm.js)
  - Git operations UI: branches, checkout, pull, push, fetch, stash
  - Code review integration with difit status and comments display
  - Task stats visualization with activity timeline
  - Dark/light theme support with multiple color schemes
- **`grove web` CLI** — start the web server (`grove web` or `grove web --port 3001`)
  - Auto-builds frontend on first run if needed
  - Embeds static assets via `rust_embed` for single-binary deployment
- **Web API** — comprehensive REST API (Axum-based)
  - `/api/projects` — list, add, delete projects
  - `/api/projects/{id}/tasks` — full CRUD + archive/recover operations
  - `/api/projects/{id}/tasks/{id}/sync`, `/commit`, `/merge`, `/reset`, `/rebase-to`
  - `/api/projects/{id}/git/*` — branches, commits, checkout, pull, push, fetch, stash
  - `/api/projects/{id}/tasks/{id}/difit` — code review server integration
  - `/api/projects/{id}/tasks/{id}/stats` — task activity statistics
  - `/api/terminal` — WebSocket terminal for interactive shell access
  - `/api/config` — global configuration management
- **`grove fp` CLI** — interactive file picker using fzf
  - Tab to multi-select, Enter to copy path, Ctrl-O to open file
  - Requires fzf to be installed
- **FilePicker pane role** — available in Custom Layout builder for agent workflows
- **Rebase to target branch** — new action in Tasks page to rebase worktree onto target
- **Task count in Branch Drawer** — Dashboard shows number of tasks per branch

### Fixed

- **File watcher path mismatch** — fixed issue where file activity tracking could miss edits due to path normalization differences

## [0.3.1] - 2026-02-03

### Added

- **MCP Server** — Model Context Protocol server for AI agent integration (`grove mcp`)
  - `grove_status` — check if running inside a Grove task, get task context
  - `grove_read_notes` — read user-written task notes
  - `grove_read_review` — read code review comments with IDs and status
  - `grove_reply_review` — batch reply to review comments with resolved/not_resolved status
  - `grove_complete_task` — complete task in one operation (commit → rebase → merge)
- **Review Comments System** — enhanced code review workflow
  - Comments parsed from difit's `diff_comments.md` output
  - AI replies stored separately in `replies.json` (preserves original comments)
  - Status tracking: open, resolved, not_resolved
  - Location-based reply matching for comment persistence across re-reviews
- **difit Session Monitor PID** — tracks which Grove process is monitoring each difit session
  - Prevents duplicate monitoring threads on TUI refresh
  - Enables reliable session recovery after Grove restart

### Changed

- **Simplified difit monitoring** — refactored to share code between Project/Monitor modes
  - Extracted `spawn_difit_thread` for code reuse
  - `DifitSession` now has `is_difit_alive()`, `is_being_monitored()`, `needs_reattach()` helpers
- **Streamlined config panel** — removed redundant code paths
- **Streamlined preview panel** — simplified rendering logic

### Removed

- **`grove agent` CLI** — replaced by MCP server tools
  - `grove agent status/summary/todo/notes` removed
  - AI agents should use MCP tools instead
- **`grove init` worktree setup** — GROVE.md injection removed
  - AI integration now handled via MCP environment variables
- **AI data storage** — `ai_data.rs` (summary/TODO) removed, replaced by MCP workflow
- **Legacy diff_comments.rs** — merged into `comments.rs` with enhanced functionality

## [0.3.0] - 2026-02-03

### Added

- **Stats Tab** — 5th sub-tab in preview panel for task activity monitoring
  - File edit heatmap showing top 10 edited files with color gradient
  - Activity timeline with 1-minute granularity, color-coded by intensity
  - Summary section with total edits, files touched, last activity time
- **File Watcher** — background file system monitoring for worktree directories
  - Tracks only git-tracked files (via `git ls-files`) to filter noise
  - Captures direct edits, atomic writes (rename pattern), and AI tool modifications
  - Debounce logic (2 seconds) to deduplicate rapid events
  - Batch processing (100ms batches) for performance optimization
- **Activity Persistence** — edit history stored to disk
  - JSONL format at `~/.grove/projects/<hash>/activity/<task_id>/edits.jsonl`
  - Auto-flush every 30 seconds or every 10 events
  - Memory-limited to 1000 events (older events preserved on disk)
- **Monitor Stats Support** — Stats tab available in Monitor mode
  - Read-only mode loads history from disk without active file watching
  - Refreshable with `r` key to see latest activity

### Changed

- **Diff tab renamed to Review** — better reflects its code review purpose

## [0.2.3] - 2026-02-01

### Fixed

- **Kill tmux session on monitor exit** — tmux session is now properly terminated when exiting the monitor view
- **difit session persistence** — difit review sessions are persisted across monitor restarts

## [0.2.2] - 2026-01-30

### Added

- **Diff Tab** — 4th sub-tab in preview panel for code review comments
  - Displays parsed review comments from difit sessions
  - Scrollable content with file location highlighting
- **Background difit execution** — `d` key launches difit in background thread
  - TUI stays responsive during review (no suspend/resume)
  - Diff tab shows spinner banner ("Reviewing in difit...") while active
  - Auto-saves comments and switches to Diff tab on completion
  - Prevents duplicate launches with toast notification
- **Review action in Monitor sidebar** — GROVE ACTIONS → Edit group
- **Review action in Action Palette** — available via Space in Project mode
- **Action group colors** — Monitor sidebar actions color-coded by group
  - Git: green, Edit: blue, Task: yellow, Session: red
- **Action Palette grouping** — actions separated by group with empty lines
  - Group-specific highlight colors when selected
- **Dynamic Action Palette height** — adapts to action count and screen size
- **Scrollable Action Palette** — selection-following scroll on small screens
- **Scrollable Monitor sidebar** — virtual-row scroll for GROVE ACTIONS

### Fixed

- **Custom layout pane assignment bug** — nested splits assigned commands to wrong panes. `list_pane_ids().last()` assumed creation order, but tmux returns layout order. Fixed by diffing pane sets before/after split
- **difit output always empty** — `Stdio::null()` on stdin caused difit to exit immediately; removed stdin null to let difit run normally
- **Stale diff comments after re-review** — always overwrite saved comments file, even when review produces no comments

## [0.2.1] - 2026-01-30

### Added

- **Custom Layout Builder** — recursive wizard for building arbitrary tmux pane layouts
  - Binary tree model: Split (H/V) as internal nodes, Pane (Agent/Grove/Shell/Custom) as leaves
  - Up to 8 panes per layout, split options auto-disable at capacity
  - Esc to backtrack through the build path, auto-advance on leaf assignment
  - Custom command input for arbitrary pane commands
  - Persisted as JSON tree in `config.toml` under `[layout.custom]`

### Fixed

- **Selection index out-of-bounds after task clean** — after cleaning a task, all actions (archive, clean, sync, merge, etc.) would stop working until restart. Fixed by clamping the list selection index in `ensure_selection()`

## [0.2.0] - 2026-01-28

### Added

- **AI Agent Integration** — `grove agent` CLI subcommand for AI-managed task workflows
  - `grove agent status` — check if running inside a Grove-managed task
  - `grove agent summary` — read/write cumulative task summaries
  - `grove agent todo` — read/write TODO lists with done tracking
  - `grove agent notes` — read user-provided task notes
- **Grove Init for Worktrees** — automatic AI integration setup on task creation
  - Generates `GROVE.md` workflow guide in each worktree
  - Injects mandatory integration block into `CLAUDE.md` / `AGENTS.md`
  - Excludes `GROVE.md` from git tracking via `.git/info/exclude`
- **AI Data & Notes Storage** — persistent storage for agent summaries, TODOs, and notes
  - Stored under `~/.grove/projects/<hash>/ai/<task_id>/`
  - Notes stored under `~/.grove/projects/<hash>/notes/<task_id>.md`
- **Preview Panel** — side panel showing task details (Git info, AI summary, notes)
  - Scrollable content with `j/k` keys
  - Sub-tabs: Git, AI Summary, Notes
  - External notes editor support (`$EDITOR`)
  - Auto-refresh on periodic data reload
  - Now opens by default
- **Workspace Card Grid** — redesigned workspace project list
  - Card-style grid layout with gradient color blocks
  - Theme-aware accent color palette (10 colors per theme)
  - Smart path compression for long paths
  - Grid navigation with arrow keys, scrolling support
- **Terminal Tab Title** — sets terminal tab name based on context
  - Workspace mode: "Grove"
  - Project mode: "{project_name} (grove)"
  - Restores default on exit
- **Theme Color Palettes** — per-theme accent palettes for workspace cards
  - Each of the 8 themes defines a unique 10-color gradient palette
  - Card backgrounds palette added to ThemeColors

### Changed

- Stronger CLAUDE.md/AGENTS.md injection — mandatory first-step instruction replaces conditional check
- Preview panel opens by default when entering Project view
- Git helpers: added `recent_log`, `diff_stat`, `uncommitted_count`, `stash_count`
- Fixed merged status detection: use `commits_behind` instead of `commits_ahead`
- Improved AI tab message for legacy tasks without integration
- Footer shortcuts updated for panel navigation
- Theme-aware toast rendering (uses ThemeColors instead of hardcoded colors)
- Extracted shared `truncate()` helper to `components/mod.rs`

## [0.1.6] - 2025-01-27

### Changed

- Simplify hook notification cleanup: clear on tmux detach instead of checking client attachment
- Branch names now limited to 3 words with a 6-digit hash suffix to prevent collisions
- Reduce event poll interval from 100ms to 16ms for lower input latency

### Removed

- `has_client_attached` tmux check (replaced by detach-based cleanup)

## [0.1.5] - 2025-01-18

### Fixed

- New tasks incorrectly showing as "Merged" status when branch and target point to the same commit

## [0.1.3] - 2025-01-16

### Added

- Version display in help panel with update status indicator
- Update checking via GitHub API (24-hour cache)
- Installation method detection (Cargo/Homebrew/GitHub Release)
- Reset action for Current/Other tabs (rebuild branch & worktree from target)

### Changed

- Removed Merge action from Other tab (requires checkout to target first)
- Linux builds now use musl for better compatibility on older systems

### Fixed

- GLIBC compatibility issue on Debian/older Linux distributions

## [0.1.2] - 2025-01-16

### Added

- Startup environment check for git and tmux 3.0+
- Auto-refresh every 5 seconds + manual refresh with `r` key
- Diff colors in worktree list and workspace detail (+green/-red)
- Support for `terminal-notifier` for better notification experience

### Changed

- Simplified branch name generation: default `grove/` prefix, user-defined prefix with `/`
- Improved notification message format: `[project] task name`
- Hook CLI now requires all environment variables before triggering
- Wider task name column in workspace detail view

### Fixed

- Use FNV-1a hash algorithm for deterministic project keys
- Hooks storage now uses project_key consistently
- Removed unused `is_clean()` and `display()` methods

## [0.1.1] - 2025-01-15

### Fixed

- Tab filtering and UI improvements
- Correct rust-toolchain in release.yml
- Correct install.sh URL branch name (main -> master)
- Resolve clippy warnings
- Apply rustfmt formatting

## [0.1.0] - 2025-01-14

### Added

- Initial release
- TUI for managing Git worktrees + tmux sessions
- Workspace view (multi-project) and Project view (single repo)
- Task creation, archiving, and deletion
- tmux session management (create, attach, kill)
- 8 color themes
- Hook notification system (notice, warn, critical)
