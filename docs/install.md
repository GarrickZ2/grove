# Grove — Installation Guide

This guide is written so an LLM agent (Claude Code, Cursor, AmpCode, …) can install Grove end-to-end without a human in the loop. Humans can read it too.

Grove ships as a single binary with the Web IDE embedded. The only runtime requirements on Unix are **Git** and a **terminal multiplexer** (tmux or Zellij). Windows uses ConPTY directly.

---

## 1. Detect platform

| Platform | Detection | Recommended installer |
| --- | --- | --- |
| macOS (Apple Silicon / Intel) | `uname -s` → `Darwin` | Homebrew, then shell installer |
| Linux x86_64 / aarch64 | `uname -s` → `Linux` | shell installer (`install.sh`) |
| Windows 10/11 | `$env:OS` → `Windows_NT` | PowerShell installer (`install.ps1`) |
| WSL | inside Linux, but with `WSL_DISTRO_NAME` set | shell installer |

If unsure, prefer the shell installer — it auto-detects arch and falls back gracefully.

## 2. Install

### macOS / Linux / WSL — shell installer (default)

```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | sh
```

For the Linux **GUI** build (Tauri-based desktop window, x86_64 only):

```bash
curl -sSL https://raw.githubusercontent.com/GarrickZ2/grove/master/install.sh | GROVE_GUI=1 sh
```

### macOS — Homebrew

```bash
brew tap GarrickZ2/grove
brew install grove
```

### Windows — PowerShell

```powershell
irm https://raw.githubusercontent.com/GarrickZ2/grove/master/install.ps1 | iex
```

### Cargo (any platform with a Rust toolchain)

```bash
cargo install grove-rs                 # TUI + Web + MCP
cargo install grove-rs --features gui  # + native desktop GUI
```

### Prebuilt binaries

`.dmg`, `.exe`, `.tar.gz`, `.AppImage` are attached to every GitHub release: <https://github.com/GarrickZ2/grove/releases/latest>

> **macOS Gatekeeper tip** — if the `.dmg` won't open ("Grove is damaged / can't be verified"), Gatekeeper has quarantined an unsigned build. Clear it with:
>
> ```bash
> xattr -rd com.apple.quarantine /Applications/Grove.app
> ```

## 3. Verify the install

```bash
grove --version
```

Expected output: a semver line such as `grove 0.10.x`. If the command is not on PATH, ensure `~/.cargo/bin` (Cargo install) or `~/.local/bin` (shell installer) is in `PATH`.

## 4. First run

```bash
cd your-project          # any Git repo
grove                    # Smart start — picks the last mode you used
```

Or pick a mode explicitly:

```bash
grove web      # Browser IDE on http://localhost:3001
grove gui      # Native desktop window (Tauri)
grove remote   # LAN access for phone / tablet with HMAC auth
grove tui      # Terminal app: projects, tasks, sessions and chat
```

The first run registers the current directory as a project under `~/.grove/projects/<hash>/`. Tasks, AI summaries, and notes live there — **do not hand-edit those files**, use the UI or Grove's MCP server instead.

## 5. Configure agents (optional but recommended)

Grove can spawn ACP-compatible coding agents (Claude Code, Codex, Gemini, …) in isolated worktrees. Configure them once in `~/.grove/config.toml`. The first launch creates a sensible default; tweak with the **Settings → Agents** page in the Web UI rather than editing TOML by hand.

## 6. Uninstall

- Homebrew: `brew uninstall grove && brew untap GarrickZ2/grove`
- Shell installer: `rm "$(command -v grove)"`
- Cargo: `cargo uninstall grove-rs`
- Data: `rm -rf ~/.grove` (this wipes all project registrations, tasks, AI summaries, and notes — irreversible)

---

## Notes for LLM agents

- Run installer commands non-interactively; they are idempotent.
- After install, **always** run `grove --version` to confirm; do not assume success from exit codes alone — some shells suppress installer errors when piped.
- If `grove` is missing after install, check `~/.local/bin` and `~/.cargo/bin` and add whichever directory contains the binary to the user's shell `PATH`.
- Do not modify files under `~/.grove/` directly. Use Grove's CLI subcommands (`grove register`, `grove migrate`) or the built-in MCP server (`grove mcp`) instead.
- Telemetry: Grove does **not** ship telemetry. Nothing to opt out of.
