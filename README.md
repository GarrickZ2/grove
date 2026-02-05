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

**Two Interfaces** — TUI for keyboard warriors, Web UI for visual workflows

**Task Dashboard** — See all tasks at a glance with live status

**True Isolation** — Each task = own branch + worktree + terminal

**Session Persistence** — Close Grove, reopen tomorrow, everything's still there

**One-Key Actions** — Create, switch, sync, merge, archive with single keystrokes

**Agent Hooks** — Get notified when AI finishes (sound + system notification)

**MCP Server** — Model Context Protocol integration for AI agents (Claude Code, etc.)

**Preview Panel** — Side panel with Git info, code review, and notes per task

**8 Themes** — Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin, and more

---

## Quick Start

**Install:**
```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
# or
cargo install grove-rs
```

**Run TUI:**
```bash
cd your-project && grove
```

**Run Web UI:**
```bash
grove web              # Open http://localhost:3001
grove web --port 8080  # Custom port
```

**Create your first task:** Press `n` in TUI, or click "New Task" in Web UI.

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

---

## Grove Web

A full-featured web interface for managing Grove projects and tasks.

**Dashboard** — Repository overview with branch list, commit history, and quick stats

**Projects** — Manage multiple git repositories from one place

**Tasks** — Create, archive, recover, and delete tasks with visual workflows

**Integrated Terminal** — Full terminal access via WebSocket (xterm.js)

**Git Operations** — Branches, checkout, pull, push, fetch, stash — all from the browser

**Code Review** — View difit review status and comments inline

**Activity Stats** — Task activity timeline and file edit heatmap

```bash
grove web                  # Start server on port 3001
grove web --port 8080      # Custom port
grove web --host 0.0.0.0   # Expose to network
```

The web UI is embedded directly in the binary — no separate frontend deployment needed.

---

## Agent Hooks

Let Grove watch your AI agents so you don't have to.

When Claude/Cursor/Copilot finishes a task, trigger notifications:

```bash
grove hooks notice    # Task completed
grove hooks warn      # Needs attention
grove hooks critical  # Something's wrong
```

Press `h` in Grove to configure sound and notification settings.

## MCP Server

Grove provides a Model Context Protocol (MCP) server for AI agent integration.

Add to your Claude Code MCP config (`~/.claude/config.json`):

```json
{
  "mcpServers": {
    "grove": {
      "command": "grove",
      "args": ["mcp"]
    }
  }
}
```

**Available Tools:**

| Tool | Description |
|------|-------------|
| `grove_status` | Check if running inside a Grove task, get context |
| `grove_read_notes` | Read user-provided task notes |
| `grove_read_review` | Read code review comments with status |
| `grove_reply_review` | Batch reply to review comments |
| `grove_complete_task` | Complete task: commit → rebase → merge → archive |

When inside a Grove task, the agent can read notes, respond to code review feedback, and complete the task with a single tool call.

## Preview Panel

Press `p` to toggle the side panel showing details for the selected task:

- **Git** — recent commits, diff stats, uncommitted changes
- **Review** — code review comments from difit
- **Notes** — user-provided context and requirements (editable with `e`)
- **Stats** — file edit heatmap and activity timeline

Use `j/k` to scroll panel content, `Left/Right` to switch sub-tabs.

---

## Requirements

- Git 2.20+
- tmux 3.0+
- macOS 12+ or Linux

## License

MIT
