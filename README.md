# Grove

**Kanban-style TUI for Parallel AI Coding**

[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()

Manage multiple AI coding tasks in parallel. Each task gets its own Git worktree and tmux session — isolated, organized, and always ready to resume.

## The Problem

You're using Claude Code, Cursor, or Gemini CLI. You start on feature A, then need to fix bug B, then review PR C. Traditional Git means constant stashing, branch switching, and lost context.

**Grove fixes this.** Every task runs in complete isolation. Switch instantly. Never lose your place.

## Features

- **Task Dashboard** — See all your tasks at a glance with live status
- **Isolated Workspaces** — Each task has its own branch and working directory
- **Session Persistence** — Terminal state preserved across switches
- **One-Key Actions** — Create, switch, sync, merge, archive with single keystrokes
- **Agent Hooks** — Get notified when your AI agents need attention
- **8 Themes** — Auto system detection, Dark, Light, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin

## Installation

### Quick Install

```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
```

### From crates.io

```bash
cargo install grove-rs
```

### Requirements

- Git 2.20+
- tmux 3.0+
- macOS 12+ or Linux

## Usage

```bash
# Start Grove in your project
cd ~/your-project
grove

# Or manage multiple projects
grove  # (run outside any git repo)
```

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New task |
| `Enter` | Open task |
| `Space` | Action menu |
| `j/k` | Navigate |
| `Tab` | Switch tabs |
| `/` | Search |
| `h` | Hook config |
| `t` | Theme |
| `?` | Help |
| `q` | Quit |

## Agent Hooks

Grove can receive notifications from AI agents running in your tasks:

```bash
grove hooks notice     # Info notification
grove hooks warn       # Warning notification
grove hooks critical   # Critical alert
```

Press `h` in Grove to generate hook commands with custom sound and notification settings.

## License

MIT
