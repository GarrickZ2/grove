# Grove

> **AI Coding Agent 的 Git Worktree 管理器**

Grove 是一个 TUI 工具，专为使用 AI Coding Agent（Claude Code、Cursor、Aider 等）进行**并发任务开发**的开发者设计。

<!-- TODO: 添加主界面截图 -->
![Grove Demo](./docs/images/demo.gif)

---

## 为什么需要 Grove？

当你使用 AI Agent 同时处理多个任务时：

- **代码隔离** — 每个任务在独立的 Git Worktree 中运行
- **会话管理** — 自动创建和管理 tmux session
- **快速切换** — 在多个任务间一键切换
- **清晰视图** — 可视化所有任务状态和代码变更

```
传统工作流:                    使用 Grove:

┌─────────────────┐           ┌─────────────────┐
│  Task A (WIP)   │           │ ● Task A (live) │ ← tmux session
├─────────────────┤           │ ○ Task B (idle) │
│  git stash      │           │ ○ Task C (idle) │
│  checkout B     │           │ ✓ Task D (done) │
│  work...        │           └─────────────────┘
│  git stash      │                   ↓
│  checkout A     │           Enter 进入任意任务
│  git stash pop  │           ESC 返回列表
└─────────────────┘           无需 stash，无需切换
```

---

## 功能特性

### Workspace 管理

跨项目管理你的所有 Grove 任务：

<!-- TODO: 添加 Workspace 截图 -->
![Workspace View](./docs/images/workspace.png)

- 自动发现和注册项目
- 查看每个项目的任务数量
- 展开查看项目详情和任务列表

### Project 视图

单个项目内的 Worktree 管理：

<!-- TODO: 添加 Project 截图 -->
![Project View](./docs/images/project.png)

- **Current** — 基于当前分支的任务
- **Other** — 基于其他分支的任务
- **Archived** — 已归档的任务

### 任务状态

| 图标 | 状态 | 说明 |
|:----:|------|------|
| `●` | Live | tmux session 运行中 |
| `○` | Idle | 无活跃 session |
| `✓` | Merged | 已合并，等待清理 |

### Git 操作

- **Sync** — 从 target 分支同步（merge/rebase）
- **Merge** — 合并到 target 分支
- **Archive** — 归档任务（保留分支）
- **Clean** — 清理任务（可选删除分支）

---

## 安装

### 从源码构建

```bash
git clone https://github.com/user/grove.git
cd grove
cargo build --release
cp target/release/grove /usr/local/bin/
```

### 依赖

- Git 2.20+
- tmux 3.0+
- macOS 12+（用于系统主题检测）

---

## 快速开始

### 1. 在项目中启动

```bash
cd ~/code/my-project
grove
```

### 2. 创建新任务

按 `n` 创建新任务，输入任务名：

<!-- TODO: 添加 New Task 弹窗截图 -->
![New Task](./docs/images/new-task.png)

Grove 会自动：
- 创建 Git Worktree
- 生成分支名（如 `feature/add-oauth-login`）
- 启动 tmux session
- 进入工作环境

### 3. 切换任务

- `j/k` 或 `↑/↓` 选择任务
- `Enter` 进入任务（attach tmux session）
- `ESC` 返回列表（detach session）

### 4. 完成任务

- `m` — Merge 到 target 分支
- `a` — Archive（保留分支，删除 worktree）
- `x` — Clean（彻底删除）

---

## 键盘快捷键

### Workspace 层级

| 按键 | 操作 |
|------|------|
| `j/k` | 上下移动 |
| `Enter` | 进入项目 |
| `Tab` | 展开/折叠详情 |
| `a` | 添加项目 |
| `x` | 删除项目 |
| `/` | 搜索 |
| `t` | 切换主题 |
| `?` | 帮助 |
| `q` | 退出 |

### Project 层级

| 按键 | 操作 |
|------|------|
| `j/k` | 上下移动 |
| `Tab` | 切换 Tab |
| `n` | 新建任务 |
| `Enter` | 进入任务 |
| `s` | Sync |
| `m` | Merge |
| `a` | Archive |
| `x` | Clean |
| `r` | Rebase to（切换 target） |
| `ESC` | 返回 Workspace |

---

## 主题

Grove 支持多种主题，按 `t` 打开主题选择器：

<!-- TODO: 添加主题截图（可选） -->

| 主题 | 说明 |
|------|------|
| Auto | 跟随系统（macOS） |
| Dark | 默认深色 |
| Light | 浅色 |
| Dracula | 紫色调 |
| Nord | 冷色调 |
| Gruvbox | 暖色调 |
| Tokyo Night | 蓝紫色调 |
| Catppuccin | 柔和色调 |

---

## 数据存储

Grove 的数据存储在 `~/.grove/` 目录：

```
~/.grove/
├── config.toml           # 全局配置（主题等）
└── projects/
    └── <hash>/           # 每个项目
        ├── project.toml  # 项目元数据
        ├── tasks.toml    # 活跃任务
        └── archived.toml # 归档任务
```

---

## 路线图

- [x] Workspace 层级
- [x] Project 层级
- [x] tmux session 管理
- [x] Git 操作（Sync/Merge）
- [x] 多主题支持
- [ ] Diff 视图（Code Review）
- [ ] Homebrew 安装

---

## License

MIT

---

## 致谢

- [ratatui](https://github.com/ratatui-org/ratatui) — TUI 框架
- [crossterm](https://github.com/crossterm-rs/crossterm) — 终端后端
