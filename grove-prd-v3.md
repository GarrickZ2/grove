# Grove - AI Coding Agent Worktree Manager

## Product Requirement Document v3

---

## 1. Overview

Grove 是一个 TUI 工具，用于管理 Git Worktree + tmux session，专为 AI Coding Agent 并发任务场景设计。

### 1.1 核心价值

- 可视化管理多个 worktree 及其 tmux session 状态
- 快速创建 worktree 并启动独立工作环境
- 简化 worktree 的同步、合并和清理流程
- 提供 diff 预览，辅助 code review

### 1.2 目标用户

使用 AI Coding Agent（如 Claude Code、Cursor、Aider）进行并发任务开发的 macOS 开发者。

### 1.3 产品定位

**Worktree 生命周期 + tmux session 生命周期的统一管理器**

---

## 2. Tech Stack

| 组件 | 选择 | 版本 | 说明 |
|------|------|------|------|
| 语言 | Rust | 1.75+ | 单二进制分发 |
| TUI 框架 | ratatui | 0.25+ | 成熟活跃 |
| 终端后端 | crossterm | 0.27+ | 跨平台 |
| 异步运行时 | tokio | 1.0+ | 异步 IO |
| Git 操作 | git2 | 0.18+ | libgit2 绑定 |
| 配置解析 | toml | 0.8+ | TOML 支持 |
| 输入组件 | tui-input | 0.8+ | 文本输入框 |
| 语法高亮 | syntect | 5.0+ | Diff 高亮 |

### 2.1 Cargo.toml

```toml
[package]
name = "grove"
version = "0.1.0"
edition = "2021"

[dependencies]
ratatui = "0.25"
crossterm = "0.27"
tokio = { version = "1", features = ["full"] }
git2 = "0.18"
toml = "0.8"
serde = { version = "1", features = ["derive"] }
tui-input = "0.8"
syntect = "5"
dirs = "5"              # 获取 home 目录
chrono = "0.4"          # 时间处理
```

### 2.2 系统依赖

- Git 2.20+（worktree 功能）
- tmux 3.0+（session 管理）
- macOS 12+（系统主题检测）

---

## 3. 信息架构

### 3.1 层级结构

```
Workspace (多项目管理)
└── Project (单个 git repo)
    └── Worktree (单个 worktree + tmux session)
```

### 3.2 入口逻辑

| 当前目录 | 入口层级 | 行为 |
|----------|----------|------|
| 非 git 目录 | Workspace | 显示已注册项目列表 |
| git repo 目录 | Project | 自动 init，显示 worktree 列表 |

### 3.3 Worktree 状态

| 图标 | 状态 | 说明 |
|------|------|------|
| `○` | idle | worktree 存在，无 tmux session |
| `●` | live | worktree 存在，tmux session 运行中 |
| `✓` | merged | 已合并到 target branch，等待清理 |
| `⚠` | conflict | 存在合并冲突 |
| `✗` | error | 异常状态（目录丢失等） |

### 3.4 状态机

```
┌────────┐     ┌────────┐     ┌────────┐
│  idle  │ ◀─▶ │  live  │ ──▶ │ merged │
└────────┘     └────────┘     └────────┘
     │              │              │
     ▼              ▼              ├─▶ archive (无弹窗)
┌────────┐    ┌──────────┐        └─▶ clean (弱弹窗)
│conflict│    │  error   │
└────────┘    └──────────┘
     │              │
     ▼              ▼
  (解决后)      (仅 clean)
   idle

┌────────┐
│archived│ ─▶ recover → idle
└────────┘ ─▶ clean (弱弹窗)
```

**状态转换规则：**

| 从 | 到 | 触发 |
|----|-----|------|
| (new) | idle | 创建 worktree |
| idle | live | Enter（创建 tmux session） |
| live | idle | ESC（detach）或用户关闭 session |
| idle/live | merged | merge 成功 |
| idle/live | conflict | sync/merge 遇到冲突 |
| conflict | idle/live | 用户解决冲突后自动检测 |
| idle/live | archived | archive 操作 |
| merged | archived | archive 操作 |
| merged | (deleted) | clean 操作 |
| archived | idle | recover 操作 |
| archived | (deleted) | clean 操作 |
| error | (deleted) | clean 操作 |

---

## 4. 用户界面设计

### 4.1 Workspace 层级

**入口：** 非 git 目录运行 `grove`

```
┌─ Grove ─────────────────────────────────────────────────────────┐
│ Workspace                                          3 projects   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   PROJECT              PATH                        WORKTREES    │
│ ❯ my-app               ~/code/my-app                      4     │
│   backend-api          ~/code/backend-api                 2     │
│   shared-lib           ~/code/shared-lib                  0     │
│                                                                 │
│                                                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ [Enter] open  [a]dd  [x] delete  [T]heme  [?]help  [q]uit      │
└─────────────────────────────────────────────────────────────────┘
```

**交互：**

| 按键 | 操作 | 说明 |
|------|------|------|
| `j` / `↓` | 下移 | |
| `k` / `↑` | 上移 | |
| `Enter` | 进入 | 进入 Project 层级 |
| `a` | 添加 | 输入 path，检查 git，注册项目 |
| `x` | 删除 | double confirm，清理所有数据 |
| `T` | 主题 | 打开主题选择器 |
| `?` | 帮助 | 显示帮助 |
| `q` | 退出 | |

---

### 4.2 Project 层级

**入口：** git 目录运行 `grove`，或从 Workspace 进入

```
┌─ Grove ──────────────────────────────────────────────────────────┐
│ ~/code/my-app                                        4 worktrees │
├──────────────────────────────────────────────────────────────────┤
│ [Current]  Other  Archived                                       │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│       TASK                      BRANCH                 ↓   FILES │
│ ❯ ●  Add OAuth login           feature/oauth          2   +5 -2  │
│   ○  Fix header bug            fix/header             —   +1 -0  │
│   ✓  Refactor auth             refactor/auth          —   clean  │
│                                                                  │
│                                                                  │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ [n]ew  [a]rchive  [x]clean  [r]ebase to  [Tab]switch  [ESC]back │
└──────────────────────────────────────────────────────────────────┘
```

**Tab 说明：**

| Tab | 内容 |
|-----|------|
| Current | 基于当前 HEAD 所在 branch 的 worktree |
| Other | 基于其他 branch 的 worktree |
| Archived | 已归档的 worktree（仅保留 branch） |

**交互：**

| 按键 | 操作 | 说明 |
|------|------|------|
| `j` / `↓` | 下移 | |
| `k` / `↑` | 上移 | |
| `Tab` | 切换 Tab | Current → Other → Archived → Current |
| `n` | New Task | 创建 worktree + session，进入 Worktree 层级 |
| `Enter` | 进入 | idle: 创建 session；live: attach；均进入 Worktree 层级 |
| `a` | Archive | merged 无弹窗，其他弱弹窗 |
| `x` | Clean | merged 弱弹窗，其他强弹窗 |
| `r` | Rebase to | 变更 target branch（弹窗选择） |
| `T` | 主题 | 打开主题选择器 |
| `ESC` | 返回 | 返回 Workspace 层级 |

**Archived Tab 交互：**

| 按键 | 操作 | 说明 |
|------|------|------|
| `Enter` | Recover | 重建 worktree，状态变为 idle |
| `x` | Clean | 弱弹窗，彻底删除 |

---

### 4.3 Worktree 层级

**入口：** 从 Project 层级 `Enter` 或 `n` 进入（attach 到 tmux session）

```
┌─ Grove ─────────────────────────────────────────────────────────┐
│ Add OAuth login                            feature/oauth-login  │
│ [t] terminal  [d] diff  [c] commit  [s] sync  [m] merge  [?]    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ TARGET   main (2 commits behind)                                │
│ STATUS   dirty (3 files changed)                                │
│                                                                 │
│ FILES                                                           │
│  M src/auth/oauth.py                                    +42  -8 │
│  A src/auth/providers.py                                +85  -0 │
│  M tests/test_auth.py                                   +12  -3 │
│                                                                 │
│ COMMITS (2)                                                     │
│  abc1234  Add OAuth client wrapper                              │
│  def5678  Setup provider configs                                │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ ~/code/my-app/.worktrees/oauth-login                            │
└─────────────────────────────────────────────────────────────────┘
```

**交互：**

| 按键 | 操作 | 说明 |
|------|------|------|
| `t` | Terminal | 进入 shell，退出后返回此界面 |
| `d` | Diff | 进入 Diff 视图 |
| `c` | Commit | 快速 commit（弹窗输入 message） |
| `s` | Sync | 从 target branch 同步（选择 merge/rebase） |
| `m` | Merge | 合并到 target，成功后询问 archive/clean/later |
| `T` | 主题 | 打开主题选择器 |
| `?` | 帮助 | 显示帮助 |
| `ESC` / `b` | 返回 | detach session，返回 Project 层级 |

---

### 4.4 Diff 视图

**入口：** Worktree 层级按 `d`

```
┌─ Diff: feature/oauth-login ─────────────────────── ESC to back ─┐
│                                                                 │
│ src/auth/oauth.py                                               │
│                                                                 │
│  15   │ def get_client():                                       │
│  16 + │     config = load_config()                              │
│  17 + │     return OAuth2Client(                                │
│  18 + │         client_id=config.client_id,                     │
│  19 + │     )                                                   │
│  20 - │     return None                                         │
│                                                                 │
│ src/auth/providers.py (new file)                                │
│                                                                 │
│   1 + │ from dataclasses import dataclass                       │
│   2 + │                                                         │
│   3 + │ @dataclass                                              │
│   4 + │ class Provider:                                         │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ [j/k] scroll  [n/p] next/prev file  [ESC] back                  │
└─────────────────────────────────────────────────────────────────┘
```

**交互：**

| 按键 | 操作 |
|------|------|
| `j` / `↓` | 向下滚动 |
| `k` / `↑` | 向上滚动 |
| `n` | 下一个文件 |
| `p` | 上一个文件 |
| `ESC` / `q` | 返回 Worktree 层级 |

---

### 4.5 New Task 弹窗

**入口：** Project 层级按 `n`

```
┌─ New Task ──────────────────────────────────────────────────────┐
│                                                                 │
│  Task: Add OAuth login█                                         │
│                                                                 │
│  → feature/add-oauth-login from main                            │
│                                                                 │
│                                    [Enter] Create  [ESC] Cancel │
└─────────────────────────────────────────────────────────────────┘
```

**Branch 命名规则：**

```
Task: "Add OAuth login"     → feature/add-oauth-login
Task: "Fix: header bug"     → fix/header-bug  
Task: "#123 payment crash"  → issue-123/payment-crash
```

**创建流程：**

1. 用户输入 Task name
2. 自动生成 branch name（基于当前 HEAD 所在 branch）
3. Enter 确认
4. 执行 `git worktree add`
5. 创建 tmux session
6. 进入 Worktree 层级

---

### 4.6 Rebase to 弹窗

**入口：** Project 层级按 `r`

```
┌─ Change Target Branch ──────────────────────────────────────────┐
│                                                                 │
│  Current: main                                                  │
│                                                                 │
│  Select new target:                                             │
│    ● main                                                       │
│      develop                                                    │
│      release/v2                                                 │
│      feature/other                                              │
│                                                                 │
│                                    [Enter] Apply  [ESC] Cancel  │
└─────────────────────────────────────────────────────────────────┘
```

**说明：** 仅修改 worktree 关联的 target branch 元数据，不执行实际的 git rebase。

---

### 4.7 Sync 弹窗

**入口：** Worktree 层级按 `s`

```
┌─ Sync from main ────────────────────────────────────────────────┐
│                                                                 │
│  Choose sync method:                                            │
│                                                                 │
│    ● Rebase (recommended)                                       │
│      Merge                                                      │
│                                                                 │
│                                    [Enter] Sync  [ESC] Cancel   │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.8 Merge 结果弹窗

**入口：** Worktree 层级按 `m`，merge 成功后

```
┌─ Merge Successful ──────────────────────────────────────────────┐
│                                                                 │
│  ✓ feature/oauth-login merged into main                         │
│                                                                 │
│  What would you like to do?                                     │
│                                                                 │
│    [A] Archive - remove worktree, keep branch                   │
│    [X] Clean   - remove worktree and branch                     │
│    [L] Later   - decide later                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

### 4.9 Theme 选择器

**入口：** 任意层级按 `T`

```
┌─ Theme ─────────────────────────────────────────────────────────┐
│                                                                 │
│  ● auto (follow system)                                         │
│    dark                                                         │
│    light                                                        │
│    dracula                                                      │
│    nord                                                         │
│    gruvbox                                                      │
│    tokyo-night                                                  │
│    catppuccin                                                   │
│                                                                 │
│                                    [Enter] Apply  [ESC] Cancel  │
└─────────────────────────────────────────────────────────────────┘
```

**主题列表：**

| 主题 | 说明 |
|------|------|
| auto | 跟随系统（macOS） |
| dark | 默认深色 |
| light | 浅色 |
| dracula | 流行深色 |
| nord | 冷色调 |
| gruvbox | 暖色调 |
| tokyo-night | 流行深色 |
| catppuccin | 柔和色调 |

---

### 4.10 弹窗确认强度

| 类型 | 样式 | 使用场景 |
|------|------|----------|
| 无弹窗 | 直接执行 | merged → archive |
| 弱弹窗 | `Confirm? [y/N]` | merged → clean, 非 merged → archive, archived → clean |
| 强弹窗 | `Type "delete" to confirm:` | 非 merged → clean, workspace 删除项目 |

---

## 5. tmux 集成

### 5.1 Session 命名规则

每个 worktree 对应一个独立的 tmux session：

```
grove-{project_name}-{task_slug}

示例：
grove-my-app-oauth-login
grove-my-app-fix-header
grove-backend-api-new-feature
```

### 5.2 Session 管理命令

| 操作 | 命令 |
|------|------|
| 创建 session | `tmux new-session -d -s "{session_name}" -c "{worktree_path}"` |
| Attach session | `tmux attach-session -t "{session_name}"` |
| 检查存在 | `tmux has-session -t "{session_name}"` |
| 列出所有 | `tmux list-sessions -F "#{session_name}"` |
| Kill session | `tmux kill-session -t "{session_name}"` |
| Detach | 用户在 session 内执行 `Ctrl-b d` 或 Grove 发送 detach |

### 5.3 工作流程

**创建 worktree 并进入：**
```
1. git worktree add .worktrees/{slug} -b {branch}
2. tmux new-session -d -s "grove-{project}-{slug}" -c "{worktree_path}"
3. tmux attach-session -t "grove-{project}-{slug}"
4. (用户在 session 内工作)
5. 用户 detach 或退出 → 返回 Grove
```

**从 Project 列表进入已有 worktree：**
```
1. 检查 session 是否存在
2. 存在 → attach
3. 不存在 → 创建 session → attach
```

### 5.4 Live 状态检测

通过检查 tmux session 是否存在判断 worktree 状态：

```rust
fn is_live(project: &str, task_slug: &str) -> bool {
    let session_name = format!("grove-{}-{}", project, task_slug);
    Command::new("tmux")
        .args(["has-session", "-t", &session_name])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
```

---

## 6. 数据存储

### 6.1 目录结构

所有数据存储在全局目录 `~/.grove/`：

```
~/.grove/
├── config.toml           # 全局配置
├── workspace.toml        # 已注册项目列表
└── projects/
    ├── my-app/
    │   └── tasks.toml    # 该项目的 task 元数据
    ├── backend-api/
    │   └── tasks.toml
    └── ...
```

### 6.2 config.toml

```toml
# ~/.grove/config.toml

[ui]
theme = "auto"  # auto, dark, light, dracula, nord, gruvbox, tokyo-night, catppuccin

[worktree]
directory = ".worktrees"  # worktree 存放目录（相对于项目根目录）

[branch]
default_prefix = "feature"  # 默认 branch 前缀
```

### 6.3 workspace.toml

```toml
# ~/.grove/workspace.toml

[[projects]]
name = "my-app"
path = "/Users/garrick/code/my-app"
added_at = "2025-01-13T10:00:00Z"

[[projects]]
name = "backend-api"
path = "/Users/garrick/code/backend-api"
added_at = "2025-01-12T08:00:00Z"
```

### 6.4 tasks.toml

```toml
# ~/.grove/projects/my-app/tasks.toml

[[tasks]]
id = "oauth-login"
name = "Add OAuth login"
branch = "feature/oauth-login"
target = "main"
worktree_path = "/Users/garrick/code/my-app/.worktrees/oauth-login"
created_at = "2025-01-13T10:00:00Z"
status = "active"  # active, archived

[[tasks]]
id = "fix-header"
name = "Fix header bug"
branch = "fix/header-bug"
target = "main"
worktree_path = "/Users/garrick/code/my-app/.worktrees/fix-header"
created_at = "2025-01-13T09:00:00Z"
status = "archived"
```

---

## 7. 配置

### 7.1 默认配置

首次运行时自动创建 `~/.grove/config.toml`：

```toml
[ui]
theme = "auto"

[worktree]
directory = ".worktrees"

[branch]
default_prefix = "feature"
```

### 7.2 主题配置

| 主题 | 说明 |
|------|------|
| auto | 跟随 macOS 系统设置 |
| dark | 默认深色 |
| light | 浅色 |
| dracula | 紫色调深色 |
| nord | 冷色调 |
| gruvbox | 暖色调 |
| tokyo-night | 蓝紫色调深色 |
| catppuccin | 柔和色调 |

### 7.3 系统主题检测（macOS）

```rust
fn get_system_theme() -> Theme {
    let output = Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output();
    
    match output {
        Ok(o) if o.status.success() => Theme::Dark,
        _ => Theme::Light,
    }
}
```

---

## 8. 安装与分发

### 8.1 安装方式

**Homebrew（推荐）：**
```bash
brew install grove
```

**Cargo：**
```bash
cargo install grove
```

**下载二进制：**
```bash
# macOS (Apple Silicon)
curl -L https://github.com/xxx/grove/releases/latest/download/grove-aarch64-apple-darwin -o grove
chmod +x grove
mv grove /usr/local/bin/
```

### 8.2 使用

```bash
# 在 git 项目目录中
cd ~/code/my-app
grove

# 在非 git 目录中（进入 workspace）
cd ~
grove
```

### 8.3 依赖检查

首次运行时检查：
- Git 版本 ≥ 2.20
- tmux 已安装且版本 ≥ 3.0

缺失则提示安装命令。

---

## 9. MVP Scope

### Phase 1 - Core

- [ ] 项目结构搭建（Rust + ratatui）
- [ ] 全局存储系统（~/.grove/）
- [ ] Workspace 层级：项目列表、添加、删除
- [ ] Project 层级：worktree 列表、Tab 切换、状态显示
- [ ] New Task：创建 worktree + tmux session
- [ ] Enter：进入 worktree（创建/attach session）
- [ ] ESC：返回上层（detach session）
- [ ] Archive / Clean 操作

### Phase 2 - Git Operations

- [ ] Worktree 层级详情界面
- [ ] Diff 视图（syntect 高亮）
- [ ] Commit 操作
- [ ] Sync 操作（merge/rebase）
- [ ] Merge 操作
- [ ] Change target branch

### Phase 3 - Polish

- [ ] 主题系统（8 主题 + auto）
- [ ] 帮助界面
- [ ] 错误状态处理
- [ ] 冲突状态处理
- [ ] Homebrew formula
- [ ] CI/CD（GitHub Actions）

---

## 10. 项目结构

```
grove/
├── Cargo.toml
├── src/
│   ├── main.rs
│   ├── app.rs              # 应用状态管理
│   ├── ui/
│   │   ├── mod.rs
│   │   ├── workspace.rs    # Workspace 层级 UI
│   │   ├── project.rs      # Project 层级 UI
│   │   ├── worktree.rs     # Worktree 层级 UI
│   │   ├── diff.rs         # Diff 视图
│   │   └── components/     # 可复用组件（弹窗、列表等）
│   ├── git/
│   │   ├── mod.rs
│   │   ├── worktree.rs     # Worktree 操作
│   │   ├── diff.rs         # Diff 解析
│   │   └── branch.rs       # Branch 操作
│   ├── tmux/
│   │   └── mod.rs          # tmux session 管理
│   ├── storage/
│   │   ├── mod.rs
│   │   ├── config.rs       # 配置读写
│   │   ├── workspace.rs    # Workspace 数据
│   │   └── tasks.rs        # Task 数据
│   └── theme/
│       └── mod.rs          # 主题定义
└── tests/
```

---

## 11. Open Questions

1. **worktree 目录位置** — 固定 `.worktrees/` 还是可配置？（当前：可配置）
2. **branch 前缀** — 是否需要根据 task 内容自动选择前缀（feature/fix/等）？
3. **多 session 并行** — 是否需要同时 attach 多个 session 的能力？（tmux 本身支持，Grove 不额外处理）
