# Grove

**AI Development, Start to Ship.**

[![Website](https://img.shields.io/badge/website-grove-10b981?style=flat&logo=github)](https://garrickz2.github.io/grove/)
[![Crates.io](https://img.shields.io/crates/v/grove-rs.svg)](https://crates.io/crates/grove-rs)
[![Downloads](https://img.shields.io/crates/d/grove-rs.svg)](https://crates.io/crates/grove-rs)
[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey.svg)]()

![Grove](docs/images/hero.png)

Write a spec, let AI code it, review together, merge with confidence. Each task gets its own Git worktree and tmux/Zellij session — isolated, organized, always ready to resume.

**Works with:** Claude Code · CodeX · Gemini · Copilot · Trae · Kimi · Qwen · OpenCode · any agent via MCP

---

## Quick Start

**Install:**
```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
# or
brew tap GarrickZ2/grove && brew install grove
# or
cargo install grove-rs
```

**Run:**
```bash
cd your-project && grove          # TUI
cd your-project && grove web      # Web UI (http://localhost:3001)
cd your-project && grove gui      # Desktop GUI (macOS)
```

---

## Every AI Gets Its Own World

Each task lives in a fully isolated workspace — its own git branch, its own session, its own spec. Run multiple agents in parallel without conflicts.

<p align="center">
  <img src="docs/images/create.gif" alt="Create a task" width="720">
</p>

- **Own Branch** — Dedicated git worktree per task. Branches never collide.
- **Own Session** — Each task in its own tmux or Zellij session. Context stays intact.
- **Own Spec** — Write instructions before the agent starts. Clear intent, focused output.

---

## Work With AI, Your Way

Two modes, one workspace. Chat interactively or let agents run autonomously in the terminal.

| | |
|---|---|
| ![Chat Mode](docs/images/chat-mode.png) | ![CLI Mode](docs/images/cli-mode.png) |
| **Chat** — A familiar chat interface for every agent. Different agents, same experience. | **CLI** — The way coding agents were designed to run. Full terminal, native experience. |

---

## Review Together. Ship With Confidence.

Comment on any line, discuss in threads, approve or reject — every merge is a conscious decision. Then merge in one step: rebase, merge, and clean up with no manual git gymnastics.

![Code Review](docs/images/diff-review.png)

![Merge and Ship](docs/images/ship-merge.png)

---

## Skills

Browse a library of skills, install with one click, and every agent gets smarter automatically.

<p align="center">
  <img src="docs/images/skills-demo.gif" alt="Skills" width="720">
</p>

- Browse and install in one click
- Global or project-level scope
- Works with all agents via MCP

---

## Three Interfaces

### TUI — `grove`

Keyboard-first terminal interface. Create tasks, write specs, launch agents, and ship — all without leaving your terminal.

![Grove TUI](docs/images/tui-grove.png)

| Key | Action |
|-----|--------|
| `n` | New task |
| `Enter` | Open task in tmux/Zellij |
| `Space` | Action menu |
| `j/k` | Navigate |
| `Tab` | Switch tabs |
| `/` | Search |
| `p` | Toggle preview panel |
| `t` | Change theme |
| `?` | Help |
| `q` | Quit |

### Web UI — `grove web`

Full-featured web interface embedded in the binary — no separate frontend deployment. Two modes: **Zen** (single-project focus) and **Blitz** (cross-project task aggregation).

![Grove Web](docs/images/grove-web.png)

```bash
grove web                  # Start on port 3001
grove web --port 8080      # Custom port
grove web --host 0.0.0.0   # Expose to network
```

### GUI — `grove gui` (macOS)

Native desktop app powered by Tauri 2 WebView. Same frontend as Grove Web, runs in a native window.

![Grove GUI](docs/images/grove-gui.png)

Included by default in macOS release binaries. For `cargo install`, enable with `cargo install grove-rs --features gui`.

---

## And There's More

| Feature | |
|---------|---|
| **AutoLink** | Automatically symlink heavy dependencies across worktrees so every task is ready to run instantly. |
| **Flexible Layout** | Drag, split, and resize panels. Build the workspace that fits your flow. |
| **Blitz View** | All tasks, all projects, one view. Switch between agents instantly. |
| **Stay Notified** | Get alerts when agents finish, need review, or hit errors. |
| **Builtin Editor** | Edit files, browse the tree, and manage code — all inside Grove's web interface. |
| **Statistics** | Track tasks shipped, agent activity, and project health at a glance. |
| **11 Themes** | Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin, and more. Auto dark/light detection. |

---

## Agent Hooks

Get notified when AI agents finish, need attention, or hit errors.

```bash
grove hooks notice    # Task completed
grove hooks warn      # Needs attention
grove hooks critical  # Something's wrong
```

Press `h` in Grove to configure sound and notification settings.

---

## MCP Server

Built-in MCP server. AI agents read notes, reply to reviews, and complete tasks autonomously.

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

| Tool | Description |
|------|-------------|
| `grove_status` | Check if running inside a Grove task, get context |
| `grove_read_notes` | Read user-provided task notes |
| `grove_read_review` | Read code review comments with status |
| `grove_reply_review` | Reply to review comments (supports batch) |
| `grove_add_comment` | Create review comments on specific code locations |
| `grove_add_project_by_path` | Register a Git project by local path (idempotent) |
| `grove_list_projects` | List all registered projects |
| `grove_create_task` | Create a new task/worktree under a project |
| `grove_list_tasks` | List active tasks under a project |
| `grove_complete_task` | Complete task: commit → rebase → merge → archive |

---

## Install

Single binary with embedded web frontend. No runtime dependencies beyond Git and a terminal multiplexer.

**Shell** (auto-detect platform):
```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh

# Custom install path (default: /usr/local/bin)
INSTALL_DIR=~/.local/bin curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
```

**Homebrew**:
```bash
brew tap GarrickZ2/grove && brew install grove
```

**Cargo**:
```bash
cargo install grove-rs                   # TUI + Web UI
cargo install grove-rs --features gui    # + native macOS GUI
```

**From Source**:
```bash
git clone https://github.com/GarrickZ2/grove.git
cd grove && cargo build --release
cp target/release/grove /usr/local/bin/
```

---

## Requirements

- Git 2.20+
- tmux 3.0+ or Zellij
- macOS 12+ or Linux

## License

MIT
