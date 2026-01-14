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

### Mock 数据 (待接入真实数据)

| 数据 | 来源 | 说明 |
|------|------|------|
| 项目路径 | Mock | 硬编码 `~/code/my-app` |
| Worktree 列表 | Mock | `src/model/mock.rs` 生成的测试数据 |
| 状态检测 | Mock | Live/Idle 状态未接入 tmux 检测 |
| Commits behind | Mock | 未接入 git 计算 |
| 文件变更统计 | Mock | 未接入 git diff |

### 待开发功能 (显示 Toast 占位)

| 按键 | 功能 | 状态 |
|------|------|------|
| `n` | New Task - 创建新 worktree | ⏳ 待开发 |
| `Enter` | 进入 Worktree / Recover | ⏳ 待开发 |
| `a` | Archive worktree | ⏳ 待开发 |
| `x` | Clean worktree | ⏳ 待开发 |
| `r` | Rebase to (修改 target branch) | ⏳ 待开发 |
| `T` | Theme 主题选择 | ⏳ 待开发 |
| `Esc` | 返回 Workspace 层级 | ⏳ 待开发 |

### 文件结构

```
src/
├── main.rs                    # 应用入口
├── app.rs                     # 应用状态管理
├── event.rs                   # 键盘事件处理
├── model/
│   ├── mod.rs
│   ├── worktree.rs            # Worktree, WorktreeStatus, ProjectTab
│   └── mock.rs                # Mock 数据生成
├── theme/
│   └── mod.rs                 # 颜色常量定义
└── ui/
    ├── mod.rs
    ├── project.rs             # Project 页面主渲染
    └── components/
        ├── mod.rs
        ├── header.rs          # 顶部: 项目路径 + worktree 数量
        ├── tabs.rs            # Tab 栏
        ├── worktree_list.rs   # Worktree 表格列表
        ├── empty_state.rs     # 空状态 (ASCII Logo)
        ├── footer.rs          # 底部快捷键提示
        └── toast.rs           # Toast 弹窗
```

---

## 下一步计划

### Phase 1 续 - 真实数据接入
- [ ] 读取当前目录的 git 信息
- [ ] 列出真实的 git worktree
- [ ] 检测 tmux session 状态 (Live/Idle)

### Phase 2 - Git 操作
- [ ] New Task 创建 worktree
- [ ] Worktree 详情页面
- [ ] Diff 视图
- [ ] Commit / Sync / Merge 操作

### Phase 3 - 完善
- [ ] Workspace 层级
- [ ] 主题系统
- [ ] 配置文件 (~/.grove/)
