# Grove - Claude Code 项目指南

## 项目概述

Grove 是一个 Rust TUI 应用，用于管理 Git Worktree + tmux session，专为 AI Coding Agent 并发任务场景设计。

## 技术栈

- **语言**: Rust 2021 Edition
- **TUI 框架**: ratatui 0.29
- **终端后端**: crossterm 0.28
- **配置**: toml + serde
- **时间**: chrono

## 项目结构

```
src/
├── main.rs              # 入口，终端初始化
├── app.rs               # App 状态管理，核心逻辑
├── event.rs             # 键盘事件处理
├── git/
│   └── mod.rs           # Git 命令封装
├── tmux/
│   └── mod.rs           # tmux session 管理
├── storage/
│   ├── mod.rs
│   ├── config.rs        # 全局配置读写
│   ├── tasks.rs         # 任务数据持久化
│   └── workspace.rs     # 项目注册管理
├── model/
│   ├── mod.rs
│   ├── worktree.rs      # Worktree/Task 数据结构
│   ├── workspace.rs     # Workspace 状态
│   └── loader.rs        # 数据加载逻辑
├── theme/
│   └── mod.rs           # 8 种主题定义
└── ui/
    ├── mod.rs
    ├── workspace.rs     # Workspace 视图
    ├── project.rs       # Project 视图
    └── components/      # 可复用 UI 组件
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

## 核心概念

### 层级结构

```
Workspace (多项目)
└── Project (单个 git repo)
    └── Task (worktree + tmux session)
```

### 入口逻辑

- 非 git 目录运行 `grove` → Workspace 视图
- git 目录运行 `grove` → Project 视图

### 任务状态

- `Live (●)` — tmux session 运行中
- `Idle (○)` — 无活跃 session
- `Merged (✓)` — 已合并到 target

## 常用命令

```bash
# 构建
cargo build

# 运行
cargo run

# 检查
cargo check

# Release 构建
cargo build --release
```

## 数据存储

所有数据存储在 `~/.grove/`：

```
~/.grove/
├── config.toml           # 主题配置
└── projects/
    └── <path-hash>/      # 项目路径的 hash
        ├── project.toml  # 项目元数据
        ├── tasks.toml    # 活跃任务
        └── archived.toml # 归档任务
```

## 开发注意事项

### UI 组件模式

所有 UI 组件遵循相同模式：

```rust
pub fn render(frame: &mut Frame, area: Rect, data: &Data, colors: &ThemeColors) {
    // 使用 ratatui widgets 渲染
}
```

### 事件处理

事件处理在 `event.rs`，按优先级分发：
1. 弹窗事件（help、dialog 等）
2. 模式事件（Workspace / Project）

### 颜色使用

始终使用 `ThemeColors` 结构体的字段，不要硬编码颜色：

```rust
// Good
Style::default().fg(colors.highlight)

// Bad
Style::default().fg(Color::Yellow)
```

### Git 操作

所有 git 操作通过 `src/git/mod.rs` 封装，使用 `std::process::Command` 调用 git CLI。

### tmux 操作

所有 tmux 操作通过 `src/tmux/mod.rs` 封装。

## 待实现功能

- [ ] Diff 视图 (Code Review)
- [ ] Ctrl-C 退出支持
- [ ] Homebrew formula
