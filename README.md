<div align="center">

# 🌲 Grove

**Parallel AI Coding, Finally Organized.**

[![Rust](https://img.shields.io/badge/rust-1.75+-orange.svg?style=flat-square)](https://www.rust-lang.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg?style=flat-square)](https://www.apple.com/macos/)

[Features](#-features) · [Installation](#-installation) · [Quick Start](#-quick-start) · [Themes](#-themes) · [Roadmap](#-roadmap)

</div>

---

<!-- TODO: Replace with actual demo GIF -->
<p align="center">
  <img src="./docs/images/demo.gif" alt="Grove Demo" width="700">
</p>

---

## The Problem

You're using **Claude Code**, **Cursor**, or **Aider** to work on multiple tasks. But Git wasn't designed for this:

```
😫 The Old Way

1. Working on feature-A...
2. "Hey, can you also fix bug-B?"
3. git stash
4. git checkout -b fix/bug-B
5. Work on bug-B...
6. "Actually, let's go back to feature-A"
7. git stash
8. git checkout feature-A
9. git stash pop
10. Wait, which stash was which? 🤯
```

**Grove fixes this.** Each task gets its own isolated workspace. Switch instantly. Never stash again.

---

## ✨ Features

### 🔀 Parallel Workspaces
Every task runs in its own **Git Worktree** — completely isolated branches that coexist simultaneously.

### 🖥️ Session Management
Each workspace has a dedicated **tmux session**. Jump in, work, jump out. Your terminal state is preserved.

### 👁️ Visual Overview
See all your tasks at a glance — which ones are active, which are idle, which are ready to merge.

### ⚡ One-Key Operations
- `n` → Create new task (worktree + branch + session)
- `Enter` → Jump into task
- `s` → Sync from main branch
- `m` → Merge back
- `a` → Archive when done

### 🎨 8 Themes
Auto-detect system theme, or choose from Dark, Light, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin.

---

## 📦 Installation

### From Source

```bash
git clone https://github.com/user/grove.git
cd grove
cargo install --path .
```

### Requirements

- **Git** 2.20+ (for worktree support)
- **tmux** 3.0+ (for session management)
- **macOS** 12+ (for system theme detection)

---

## 🚀 Quick Start

### 1. Navigate to your project

```bash
cd ~/code/my-project
grove
```

### 2. Create a new task

Press `n`, type your task name:

```
Task: Add OAuth login
  → feature/add-oauth-login from main
```

Grove automatically:
- Creates a new worktree
- Creates a branch with a smart name
- Starts a tmux session
- Drops you into the workspace

### 3. Work in parallel

```
┌─────────────────────────────────────────────────────────┐
│ ~/code/my-project                          3 worktrees  │
├─────────────────────────────────────────────────────────┤
│ [Current]  Other  Archived                              │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ❯ ●  Add OAuth login       feature/oauth      +52 -12  │  ← You are here
│    ○  Fix header bug        fix/header         +3  -1   │
│    ✓  Refactor auth         refactor/auth      merged   │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ [n]ew  [Enter]open  [s]ync  [m]erge  [a]rchive  [?]help │
└─────────────────────────────────────────────────────────┘

● = tmux session running    ○ = idle    ✓ = merged
```

### 4. Switch tasks instantly

Press `j`/`k` to navigate, `Enter` to jump in. **No stashing. No checkout. No context loss.**

---

## 🎨 Themes

Press `t` anywhere to switch themes.

| Theme | Style |
|-------|-------|
| **Auto** | Follows your system (macOS) |
| **Dark** | Default dark theme |
| **Light** | Clean light theme |
| **Dracula** | Purple-tinted dark |
| **Nord** | Cool, muted blues |
| **Gruvbox** | Warm, retro feel |
| **Tokyo Night** | Modern purple-blue |
| **Catppuccin** | Soft pastel colors |

<!-- TODO: Add theme screenshot grid -->

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down |
| `Enter` | Open task (attach tmux session) |
| `n` | New task |
| `s` | Sync from target branch |
| `m` | Merge to target branch |
| `a` | Archive task |
| `x` | Clean (delete) task |
| `r` | Rebase to different target |
| `t` | Change theme |
| `/` | Search |
| `?` | Help |
| `q` | Quit |
| `ESC` | Back / Exit |

---

## 🗺️ Roadmap

- [x] Multi-project workspace
- [x] Git worktree management
- [x] tmux session integration
- [x] Sync & Merge operations
- [x] 8 color themes
- [ ] Code diff viewer
- [ ] Homebrew formula
- [ ] Linux support

---

## 📄 License

MIT © 2025

---

<div align="center">

**Built for developers who let AI do the heavy lifting.**

🌲

</div>
