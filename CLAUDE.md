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
├── git/
│   └── mod.rs           # Git command wrappers
├── tmux/
│   └── mod.rs           # tmux session management
├── storage/
│   ├── mod.rs
│   ├── config.rs        # Global config read/write
│   ├── tasks.rs         # Task data persistence
│   └── workspace.rs     # Project registration
├── model/
│   ├── mod.rs
│   ├── worktree.rs      # Worktree/Task data structures
│   ├── workspace.rs     # Workspace state
│   └── loader.rs        # Data loading logic
├── theme/
│   └── mod.rs           # 8 theme definitions
└── ui/
    ├── mod.rs
    ├── workspace.rs     # Workspace view
    ├── project.rs       # Project view
    └── components/      # Reusable UI components
        ├── worktree_list.rs
        ├── workspace_list.rs
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
        └── archived.toml # Archived tasks
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

### Git Operations

All git operations are wrapped in `src/git/mod.rs`, using `std::process::Command` to call git CLI.

### tmux Operations

All tmux operations are wrapped in `src/tmux/mod.rs`.

## TODO

- [ ] Diff view (Code Review)
- [ ] Ctrl-C exit support
- [ ] Homebrew formula
