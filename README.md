# Grove

**Run 10 AI agents. Zero context switching.**

[![Crates.io](https://img.shields.io/crates/v/grove-rs.svg)](https://crates.io/crates/grove-rs)
[![Downloads](https://img.shields.io/crates/d/grove-rs.svg)](https://crates.io/crates/grove-rs)
[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()

![Grove Screenshot](docs/images/screenshot-hero.png)

Manage multiple AI coding tasks in parallel. Each task gets its own Git worktree and tmux session—isolated, organized, always ready to resume.

---

## The Problem

You're juggling Claude Code on feature A, Cursor fixing bug B, and reviewing PR C.

With traditional Git, this means:
- Constant `git stash` / `git stash pop` gymnastics
- Branch switching that kills your terminal state
- "Wait, what was I working on?" moments
- AI agents losing context mid-task

**Your workflow shouldn't fight your tools.**

## The Solution

Grove gives each task its own **isolated universe**:

![Task Isolation](docs/images/screenshot-solution.png)

- Switch between tasks **instantly** — no stashing, no rebuilding
- Resume exactly where you left off — terminal state preserved
- Let AI agents run in parallel without stepping on each other

---

## Features

**Task Dashboard** — See all tasks at a glance with live status

**True Isolation** — Each task = own branch + worktree + terminal

**Session Persistence** — Close Grove, reopen tomorrow, everything's still there

**One-Key Actions** — Create, switch, sync, merge, archive with single keystrokes

**Agent Hooks** — Get notified when AI finishes (sound + system notification)

**AI Agent Integration** — Built-in workflow for AI coding agents (Claude Code, Cursor, etc.)

**Preview Panel** — Side panel with Git info, AI summaries, and notes per task

**8 Themes** — Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin, and more

---

## Quick Start

**Install:**
```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
# or
cargo install grove-rs
```

**Run:**
```bash
cd your-project && grove
```

**Create your first task:** Press `n`, name it, start coding.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New task |
| `Enter` | Open task in tmux |
| `Space` | Action menu |
| `j/k` | Navigate |
| `Tab` | Switch tabs |
| `/` | Search |
| `t` | Change theme |
| `?` | Help |
| `q` | Quit |

## Agent Hooks

Let Grove watch your AI agents so you don't have to.

When Claude/Cursor/Copilot finishes a task, trigger notifications:

```bash
grove hooks notice    # Task completed
grove hooks warn      # Needs attention
grove hooks critical  # Something's wrong
```

Press `h` in Grove to configure sound and notification settings.

## AI Agent Integration

Grove automatically sets up each task for AI coding agents. When a task is created:

1. **GROVE.md** is generated in the worktree with workflow instructions
2. **CLAUDE.md / AGENTS.md** are injected with a mandatory integration block
3. Environment variables (`GROVE_TASK_ID`, `GROVE_PROJECT`, etc.) are set in the tmux session

Agents can use the CLI to track progress:

```bash
grove agent status                              # Check task context
grove agent notes                               # Read user-provided notes
grove agent summary                             # Read current summary
grove agent summary "Implemented feature X..."  # Update summary
grove agent todo                                # Read TODO list
grove agent todo --todo "task A" --done "task B" # Update TODOs
```

## Preview Panel

Press `Tab` to toggle the side panel showing details for the selected task:

- **Git** — recent commits, diff stats, uncommitted changes
- **AI Summary** — cumulative work summary written by agents
- **Notes** — user-provided context and requirements (editable with `e`)

Use `j/k` to scroll panel content, `Left/Right` to switch sub-tabs.

---

## Requirements

- Git 2.20+
- tmux 3.0+
- macOS 12+ or Linux

## License

MIT
