# Grove

**Git Worktree + tmux Manager for Parallel Development**

[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](https://www.apple.com/macos/)

Grove is a TUI application that manages Git worktrees and tmux sessions, designed for developers who work on multiple tasks in parallel — especially useful when working with AI coding assistants.

## Why Grove?

When using AI assistants (Claude Code, Cursor, Aider, etc.) for coding, you often need to:
- Work on multiple features/bugs simultaneously
- Keep each task isolated in its own branch
- Switch between tasks without losing context

Traditional Git workflow requires constant `stash`, `checkout`, and context switching. Grove eliminates this by giving each task its own:
- **Git Worktree** — isolated working directory with its own branch
- **tmux Session** — preserved terminal state and environment

## Features

### Core Workflow
- **Parallel Workspaces**: Each task runs in its own Git worktree
- **Session Management**: Dedicated tmux session per task with preserved state
- **Visual Dashboard**: See all tasks at a glance with status indicators
- **One-Key Operations**: Create, switch, sync, merge, archive tasks

### Git Operations
- **Sync**: Rebase from target branch (typically main/master)
- **Merge**: Squash or merge commit back to target
- **Archive**: Keep completed tasks for reference
- **Clean**: Remove worktrees and branches

### Agent Integration (Hooks)
Grove can receive notifications from AI agents running in tmux sessions:

```bash
# Agent calls this to notify Grove
grove hooks notice              # Blue [i] marker
grove hooks warn                # Yellow [!] marker
grove hooks critical            # Red [!!] marker

# Options
--sound <none|Glass|Purr|Sosumi|Basso>
--banner / --no-banner          # macOS system notification
```

Press `h` in Grove to generate hook commands for your agent configuration.

### Themes
8 built-in themes with auto system detection:
- Auto (follows macOS appearance)
- Dark / Light
- Dracula / Nord / Gruvbox
- Tokyo Night / Catppuccin

## Installation

### Quick Install (Recommended)

```bash
# macOS / Linux
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/main/install.sh | sh
```

### From crates.io

```bash
cargo install grove-rs
```

### From Source

```bash
git clone https://github.com/GarrickZ2/grove.git
cd grove
cargo install --path .
```

### Requirements

- **Git** 2.20+ (worktree support)
- **tmux** 3.0+ (session management)
- **macOS** 12+ (system theme detection, notifications)
- **Linux** support available (notifications require desktop environment)

## Usage

### Start Grove

```bash
# In a git repository - opens Project view
cd ~/code/my-project
grove

# Outside git repository - opens Workspace view (multi-project)
grove
```

### Project View

```
┌─ ~/code/my-project ─────────────────── 3 tasks ─┐
│ main · 2 ahead · +15 -3 · 2 hours ago           │
├─────────────────────────────────────────────────┤
│ [Current]  Other  Archived                      │
├─────────────────────────────────────────────────┤
│  ❯ ● [!!] oauth-login       live    main  +52  │
│    ○ [i]  fix-header        idle    main  +3   │
│    ✓      refactor-auth     merged  main       │
├─────────────────────────────────────────────────┤
│ [n]ew [Space]actions [Enter]open [?]help       │
└─────────────────────────────────────────────────┘

● = tmux session running
○ = idle (session exists but detached)
✓ = merged
[!!] [!] [i] = agent notifications
```

### Workspace View

```
┌─────────────────────────────────────────────────┐
│              ─── Your Projects ───              │
│                                                 │
│  ❯ [!!] my-project          3 tasks   ●        │
│    [i]  another-project     1 task    ○        │
│         side-project        0 tasks            │
├─────────────────────────────────────────────────┤
│ [a]dd [x]remove [Enter]open [Tab]expand [?]help│
└─────────────────────────────────────────────────┘
```

## Keyboard Shortcuts

### Navigation
| Key | Action |
|-----|--------|
| `j` / `↓` | Move down |
| `k` / `↑` | Move up |
| `Tab` | Switch tabs / Expand details |
| `1` `2` `3` | Jump to tab |
| `/` | Search |
| `Esc` | Back / Cancel |
| `q` | Quit |

### Task Operations (Project View)
| Key | Action |
|-----|--------|
| `n` | New task |
| `Enter` | Open task (attach tmux) |
| `Space` | Action palette |
| `h` | Hook config panel |
| `t` | Theme selector |
| `?` | Help |

### Action Palette
| Action | Description |
|--------|-------------|
| Commit | Stage all and commit |
| Sync | Rebase from target branch |
| Merge | Merge to target branch |
| Archive | Mark as done (keep branch) |
| Clean | Delete worktree and branch |
| Rebase To | Change target branch |
| Checkout Target | Switch to target branch |

### Workspace Operations
| Key | Action |
|-----|--------|
| `a` | Add project |
| `x` | Remove project |
| `Enter` | Enter project |
| `Tab` | Toggle detail panel |

## Data Storage

Grove stores data in `~/.grove/`:

```
~/.grove/
├── config.toml              # Global settings (theme, etc.)
├── workspace.toml           # Registered projects
├── worktrees/               # Git worktrees location
│   └── {project-hash}/
│       └── {task-id}/
└── projects/
    └── {project-name}/
        ├── tasks.toml       # Active tasks
        ├── archived.toml    # Archived tasks
        └── hooks.toml       # Notification state
```

## Agent Hook Configuration

### Claude Code

Add to your Claude Code hooks configuration:

```json
{
  "hooks": {
    "post-tool-use": [
      {
        "matcher": "Task",
        "command": "grove hooks notice"
      }
    ]
  }
}
```

### Environment Variables

Grove sets these in tmux sessions for agent use:

| Variable | Description |
|----------|-------------|
| `GROVE_PROJECT` | Project path |
| `GROVE_PROJECT_NAME` | Project name |
| `GROVE_TASK_ID` | Task ID (slug) |
| `GROVE_TASK_NAME` | Task display name |
| `GROVE_BRANCH` | Task branch |
| `GROVE_TARGET` | Target branch |
| `GROVE_WORKTREE` | Worktree path |

## License

MIT
