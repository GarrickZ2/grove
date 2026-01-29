# Grove - Project Guide

## Overview

Grove is a Rust TUI application for managing Git Worktrees + tmux sessions, designed for parallel AI coding agent workflows.

## Tech Stack

- **Language**: Rust 2021 Edition
- **TUI Framework**: ratatui 0.29
- **Terminal Backend**: crossterm 0.28
- **Config**: toml + serde
- **Time**: chrono

## Project Structure

```
src/
├── main.rs              # Entry point, terminal initialization
├── app.rs               # App state management, core logic
├── event.rs             # Keyboard event handling
├── cli/
│   ├── mod.rs           # CLI subcommand definitions
│   ├── agent.rs         # `grove agent` commands (status/summary/todo/notes)
│   ├── hooks.rs         # `grove hooks` notification commands
│   └── init.rs          # Worktree AI integration setup (GROVE.md injection)
├── git/
│   └── mod.rs           # Git command wrappers
├── tmux/
│   └── mod.rs           # tmux session management
├── storage/
│   ├── mod.rs
│   ├── config.rs        # Global config read/write
│   ├── tasks.rs         # Task data persistence
│   ├── workspace.rs     # Project registration
│   ├── ai_data.rs       # AI summary & TODO persistence
│   └── notes.rs         # Task notes persistence
├── model/
│   ├── mod.rs
│   ├── worktree.rs      # Worktree/Task data structures
│   ├── workspace.rs     # Workspace state (grid navigation, filtering)
│   └── loader.rs        # Data loading logic
├── theme/
│   ├── mod.rs           # Theme enum, ThemeColors struct
│   ├── colors.rs        # 8 theme color definitions (including accent palettes)
│   └── detect.rs        # System dark/light mode detection
└── ui/
    ├── mod.rs
    ├── workspace.rs     # Workspace view
    ├── project.rs       # Project view
    └── components/      # Reusable UI components
        ├── workspace_list.rs  # Card grid with gradient color blocks
        ├── worktree_list.rs
        ├── preview_panel.rs   # Side panel (Git/AI/Notes tabs)
        ├── header.rs
        ├── footer.rs
        ├── tabs.rs
        ├── toast.rs
        ├── theme_selector.rs
        ├── help_panel.rs
        ├── new_task_dialog.rs
        ├── add_project_dialog.rs
        ├── delete_project_dialog.rs
        ├── confirm_dialog.rs
        ├── input_confirm_dialog.rs
        ├── branch_selector.rs
        ├── merge_dialog.rs
        └── ...
```

## Core Concepts

### Hierarchy

```
Workspace (multiple projects)
└── Project (single git repo)
    └── Task (worktree + tmux session)
```

### Entry Logic

- Run `grove` outside git repo → Workspace view
- Run `grove` inside git repo → Project view

### Task States

- `Live (●)` — tmux session running
- `Idle (○)` — no active session
- `Merged (✓)` — merged to target branch

## Commands

```bash
cargo build            # Build
cargo run              # Run
cargo check            # Check
cargo build --release  # Release build
```

## Data Storage

All data stored in `~/.grove/`:

```
~/.grove/
├── config.toml           # Theme config
└── projects/
    └── <path-hash>/      # Hash of project path
        ├── project.toml  # Project metadata
        ├── tasks.toml    # Active tasks
        ├── archived.toml # Archived tasks
        ├── ai/
        │   └── <task-id>/
        │       ├── summary.md   # AI agent summary
        │       └── todo.json    # AI agent TODO list
        └── notes/
            └── <task-id>.md     # User-provided task notes
```

## Development Guidelines

### UI Component Pattern

All UI components follow the same pattern:

```rust
pub fn render(frame: &mut Frame, area: Rect, data: &Data, colors: &ThemeColors) {
    // Render using ratatui widgets
}
```

### Event Handling

Events are handled in `event.rs`, dispatched by priority:
1. Popup events (help, dialogs, etc.)
2. Mode events (Workspace / Project)

### Color Usage

Always use `ThemeColors` struct fields, never hardcode colors:

```rust
// Good
Style::default().fg(colors.highlight)

// Bad
Style::default().fg(Color::Yellow)
```

Each theme defines an `accent_palette: [Color; 10]` for workspace card gradient blocks. Use `colors.accent_palette` instead of hardcoded color arrays.

### Pre-commit Checks

A pre-commit hook is provided in `.githooks/pre-commit`. It runs the following checks before each commit:

1. **`cargo fmt --all -- --check`** — code must be formatted
2. **`cargo clippy -- -D warnings`** — no clippy warnings allowed
3. **`cargo test`** — all tests must pass
4. **Version bump** — `Cargo.toml` version must differ from `master` (skipped when committing on master itself)

Activate the hook with:

```bash
git config core.hooksPath .githooks
```

### Git Operations

All git operations are wrapped in `src/git/mod.rs`, using `std::process::Command` to call git CLI.

### tmux Operations

All tmux operations are wrapped in `src/tmux/mod.rs`.

## CLI Subcommands

Grove has two CLI subcommand groups (defined in `src/cli/`):

- `grove hooks <level>` — send notification hooks (notice/warn/critical)
- `grove agent <command>` — AI agent workflow commands (status/summary/todo/notes)

### AI Integration Flow

When a task is created (`create_new_task` in `app.rs`):
1. Git worktree is created
2. `cli::init::setup_worktree()` generates `GROVE.md` and injects into `CLAUDE.md`/`AGENTS.md`
3. tmux session is created with `GROVE_*` environment variables
4. Agent reads `GROVE.md` instructions and uses `grove agent` CLI to track progress

## TODO

- [ ] Diff view (Code Review)
- [ ] Ctrl-C exit support
- [ ] Homebrew formula
