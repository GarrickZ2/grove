# Grove 开发进度

## 当前版本: v0.1.0 - Project Level UI

### 已完成功能

| 功能 | 状态 | 说明 |
|------|------|------|
| Project 页面布局 | ✅ 完成 | Header + Tabs + List + Footer |
| Tab 切换 | ✅ 完成 | Current / Other / Archived 三个 Tab |
| Worktree 列表显示 | ✅ 完成 | 显示任务名、分支、状态图标、commits behind、文件变更 |
| 列表导航 | ✅ 完成 | j/k 或方向键上下移动 |
| 空状态显示 | ✅ 完成 | ASCII Art Logo + 提示文字 |
| Toast 提示 | ✅ 完成 | 2 秒自动消失 |
| 退出程序 | ✅ 完成 | 按 q 退出 |
| **主题系统** | ✅ 完成 | 8 个预设主题 + Auto 模式 |
| **New Task** | ✅ 完成 | 创建 worktree + tmux session |
| **真实数据接入** | ✅ 完成 | 从 Task 元数据加载，替换 Mock 数据 |

### 主题系统详情

| 主题 | 说明 |
|------|------|
| Auto | 跟随 macOS 系统 dark/light 设置，实时响应变化 |
| Dark | 深色主题（亮绿色调） |
| Light | 浅色主题 |
| Dracula | 紫/粉色调深色 |
| Nord | 冷蓝色调 |
| Gruvbox | 暖黄色调 |
| Tokyo Night | 蓝紫色调深色 |
| Catppuccin | 柔和粉色调 |

**功能特点:**
- 按 `t` 打开主题选择器弹窗
- j/k 上下导航，实时预览效果
- Enter 确认，Esc 取消
- Auto 模式每 100ms 检测系统主题变化

### New Task 功能详情

**功能特点:**
- 按 `n` 打开 New Task 弹窗
- 输入任务名称，实时预览生成的 branch 名
- Enter 确认创建，Esc 取消

**Branch 命名规则:**
| 输入格式 | 生成的 branch |
|----------|---------------|
| `fix: header bug` | `fix/header-bug` |
| `feat: oauth` / `feature: oauth` | `feature/oauth` |
| `dev: experiment` | `dev/experiment` |
| `#123 bug fix` | `issue-123/bug-fix` |
| `issue #456 payment` | `issue-456/payment` |
| `Add new feature` | `grove/add-new-feature` (默认) |

**存储结构:**
```
~/.grove/
├── projects/
│   └── {project}/
│       └── tasks.toml      # 任务元数据
└── worktrees/
    └── {project}/
        └── {task-slug}/    # git worktree 目录
```

**创建流程:**
1. 创建 git worktree (`git worktree add -b {branch} {path} {base}`)
2. 保存任务元数据到 `tasks.toml`
3. 创建 tmux session
4. Grove 退出后自动 attach 到 session

### 真实数据接入

**数据源**: Task 元数据为主 (`~/.grove/projects/{project}/tasks.toml`)

| 数据 | 来源 | 说明 |
|------|------|------|
| 项目路径 | git | `git rev-parse --show-toplevel` |
| Worktree 列表 | Task | 从 `tasks.toml` 加载 |
| 状态检测 | tmux | `tmux has-session` 检测 Live/Idle |
| Broken 状态 | 文件系统 | worktree 目录不存在时显示 |
| Commits behind | git | `git rev-list --count` |
| 文件变更统计 | git | `git diff --numstat` |

**状态说明:**
- `Live` (●): tmux session 运行中
- `Idle` (○): worktree 存在，无 tmux session
- `Broken` (✗): Task 存在但 worktree 被删除

### 待开发功能 (显示 Toast 占位)

| 按键 | 功能 | 状态 |
|------|------|------|
| `n` | New Task - 创建新 worktree | ✅ 完成 |
| `Enter` | 进入 Worktree / Recover | ⏳ 待开发 |
| `a` | Archive worktree | ⏳ 待开发 |
| `x` | Clean worktree | ⏳ 待开发 |
| `r` | Rebase to (修改 target branch) | ⏳ 待开发 |
| `Esc` | 返回 Workspace 层级 | ⏳ 待开发 |

### 文件结构

```
src/
├── main.rs                    # 应用入口
├── app.rs                     # 应用状态管理
├── event.rs                   # 键盘事件处理
├── git/
│   └── mod.rs                 # Git worktree 操作 (Shell)
├── storage/
│   ├── mod.rs                 # 目录管理 (~/.grove/)
│   └── tasks.rs               # Task TOML 读写 + branch 命名
├── tmux/
│   └── mod.rs                 # tmux session 管理
├── model/
│   ├── mod.rs
│   ├── worktree.rs            # Worktree, WorktreeStatus, ProjectTab
│   ├── loader.rs              # 从 Task 加载真实数据
│   └── mock.rs                # Mock 数据生成 (已弃用)
├── theme/
│   ├── mod.rs                 # Theme 枚举 + ThemeColors 结构
│   ├── colors.rs              # 各主题颜色定义
│   └── detect.rs              # macOS 系统主题检测
└── ui/
    ├── mod.rs
    ├── project.rs             # Project 页面主渲染
    └── components/
        ├── mod.rs
        ├── header.rs          # 顶部: Logo + 项目路径 + worktree 数量
        ├── logo.rs            # ASCII Art GROVE Logo
        ├── tabs.rs            # Tab 栏（高亮背景块样式）
        ├── worktree_list.rs   # Worktree 表格列表
        ├── empty_state.rs     # 空状态提示
        ├── footer.rs          # 底部快捷键提示
        ├── toast.rs           # Toast 弹窗
        ├── theme_selector.rs  # 主题选择器弹窗
        └── new_task_dialog.rs # New Task 弹窗
```

---

## 下一步计划

### Phase 1 续 - 真实数据接入
- [ ] 读取当前目录的 git 信息
- [ ] 列出真实的 git worktree
- [ ] 检测 tmux session 状态 (Live/Idle)

### Phase 2 - Git 操作
- [x] New Task 创建 worktree
- [ ] Enter 进入 worktree (attach tmux session)
- [ ] Worktree 详情页面
- [ ] Diff 视图
- [ ] Commit / Sync / Merge 操作

### Phase 3 - 完善
- [ ] Workspace 层级
- [ ] 配置文件持久化
