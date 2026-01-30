# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
