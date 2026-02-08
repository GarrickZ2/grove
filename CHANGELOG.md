# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
