# Grove Board — Product Spec (v0.1)

状态：UI/UX 设计前置完成，前端 mock 已落地。后端 schema 与 sync 实现待启动。

---

## 1. 定位

Grove Board 是**规划层**功能。现有 Task 是执行层（worktree + tmux session），Board 是其之上的管理视角。两者通过 Session 关联。

- 入口：Root Sidebar 独立入口，与 Tasks / Skills / AI / Statistics 并列。
- 心智：Card 回答"要做什么、谁做"，Task 回答"用什么资源在跑"。

> 命名：Board / Card 是工作名。两者均偏看板通用语；后续若想换更 Grove 风格的词（如 Plan / Item / Sprout）再统一改。

---

## 2. 核心概念

| 概念 | 说明 |
|---|---|
| **Board** | 卡片容器，含成员、列定义、关联 Project 等元信息 |
| **Card** | 规划单元，一项任务/想法 |
| **Project** | 现有概念，git 仓库 |
| **Task** | 现有概念，执行单元。两种形态：普通 Task（有 worktree）/ `_local` Task（无 worktree） |
| **Session** | 现有概念，Agent 执行上下文，永远属于某个 Task |

### ER 关系

```
Board    ──< Card        1:n
Board    ──< Project     1:n   （reference）
Project  ──< Task        1:n
Task     ──< Session     1:n
Card     >──< Session    m:n   （可跨 Task 绑定）
```

Session 是两个维度的交汇点：它属于 Task（资源维度），同时被 Card 引用（管理维度）。

---

## 3. Board 创建

两种模式，**创建时确定，永久绑定，不支持互转**。

| | Offline (Local) | Online |
|---|---|---|
| 存储 | 本地 `~/.grove/` | git branch |
| Project identifier | local path | origin URL |
| 可关联 Project 范围 | 任意 project（含无 origin） | 仅有 origin 的 project |
| 协作 | 单人 | 多人 |
| Sync | 无 | 自动 debounced push |

**创建表单：**
- Board 名称
- 模式（Offline / Online）
- Online：Primary Project（必选） + Branch 名（默认 `grove/board/<slug>`）

**Branch 命名约定：**
- 前缀 `grove/board/` 固定不可改，便于客户端自动发现
- 用户只能编辑后半段 slug（自动 slugify）

---

## 4. Primary + Linked 模型

- **Primary Project**：唯一存放 Board 元信息和 Card 数据。Online Board 的 board branch 在此 repo
- **Linked Project**：被引用，自身不存 Board 数据，渲染时本地读取执行状态做聚合
- "Board 访问权 = Primary Project 的 git 访问权"
- Primary 在创建时确定，**MVP 不支持 transfer**
- Linked Project 后续随时加减（Manager 权限）
- 降级行为：Linked Project 本地不可达时，卡片继续展示规划信息，关联的执行状态标"不可用"

---

## 5. 权限模型

身份标识：**git user.email**

| 角色 | 数量 | 权限 |
|---|---|---|
| Manager | 唯一 | 全部元信息：成员、列定义、Linked Project、board 元信息 |
| Operator | 多个 | 仅 Card 操作：建卡、claim、推进状态、绑定 Session |
| Viewer | 多个 | 只读 |

**入退规则：**
- Manager 由创建者担任，**MVP 不支持 transfer**；Manager 失联 = Board 孤儿，MVP 不处理
- Operator / Viewer 由 Manager 邀请加入，可主动 quit

**AI Agent 不独立身份**，行为归属到启动它的人（commit author 用启动者 git email）。

**应用层 ACL（Online）：** 客户端校验每个 board 相关 commit 的 author email 是否在成员列表，不在列表的变更直接忽略。

---

## 6. 状态机

### Card 状态 = 所在列

**固定锚点（不可改）：**
- **Backlog**（anchor）：未认领，无 owner
- **Done**（anchor）：终态
- **Blocked**：横向状态，Owner 可在任意时刻进入 / 退出（待实现）

**中间状态：**
- Manager 自定义列（数量、顺序、名称）
- 不同团队可自配 workflow（In Progress / Review / Testing…）

### Ownership 规则（强约束）

- 新建卡 → **只能进 Backlog**，无 owner（**唯一**入口是顶栏 New card 按钮；列上不放 + icon）
- 卡被 claim 后，**仅 Owner 能推进状态**
- Owner 可主动 Release，卡自动回 Backlog（清 owner）
- **没有任何角色能强制干预他人持有的卡**（不存在 Take over / Force release）
- Owner 标记 Done（不依赖外部信号）

### 拖拽门控

- `card.ownerEmail === currentUser` → 可拖
- 其它情况 → `draggable=false`，悬浮提示"Claim this card to move it"或"Only the owner can move this card"

---

## 7. 同步模型（Online 专属）

**Local-first + Debounced Push：**
- 用户操作立即本地生效
- 操作进入 push 队列，debounce 窗口（约 2–5s）结束后批量 push

**权限探测：** 打开 Board 时探测 git push 权限；无权限 → Board 进入只读模式

**失败处理：**
- Push 失败**不 rollback** 本地操作
- 显示"未同步"状态，用户自行重试 / 处理
- Sync 状态四档：已同步 / 同步中 / 离线 / 失败

**冲突预防：**
- 一卡一文件存储，元信息变更受 Manager 唯一权限约束
- 真冲突场景弹 UI 由用户选保留哪个版本

---

## 8. 跨 Project 聚合

Board 渲染：
1. 从 Primary Project 读 Board 数据
2. 从本地各 Linked Project clone 读关联 Task / Session 执行状态
3. 聚合展示在 Card 上

Card 上展示的 Session 信息（参考 Tray 设计语言）：
- **Working** — highlight 色，AgentBadge + 一行 prompt 预览 + 进度条 + 已用时长
- **Resting** — accent 色，紧凑变体
- **Done** — muted 行，显示总时长
- **Failed** — error 色

---

## 9. UX 决策

### Board 列表（BoardsIndex）

- 视觉语言对齐 ProjectSelector：彩色圆角图标方格（`getProjectStyle(board.id)`）+ 列表行
- 顶部：Filter 输入框 + All / Online / Local segmented control
- 行右侧：card / session / member 计数 + sync 状态（Online）+ 最近活跃
- Offline Board：不显示 sync 状态行；mode 徽章用 accent 色（不是灰），避免"凉了"的视觉

### Card 视觉

- 标题 + 单 Assignee（boring-avatars beam）+ description 预览（2 行 line-clamp）
- 内嵌 Session 行（最多 3 个，超出 +N more），Tray 风格的状态展示
- Start → Due 日期行
- 未指派头像用虚线圆 + UserRound icon（不用"?"）

### Card 详情抽屉

- inline 编辑标题 / 描述
- Owner banner：未认领 → Claim 按钮；自己 owner → Release + Mark Done；他人 owner → 无操作
- Assignee + Dates 控件，Sessions 列表（绑/解绑）
- Bind Session 走两步 modal：选 Task → 选 Session 或新建

### Board Settings 抽屉

右侧抽屉，4 tabs：
- **General**：名称 / Mode / Sync branch / Danger zone
- **Columns**：anchor 列锁定；中间列 inline 编辑、上下排序、删除；底部 Add column
- **Members**：列表 + role dropdown + 邀请表单；Manager 不可改 / 不可删；自己不可删自己
- **Projects**：Primary 锁定；Linked 列表 + 链接选择器（从 registered projects）

### 通用：RichPicker

- 复用 ProjectSelector 视觉的下拉（icon 方格 + label + sublabel + filter + portal 渲染）
- 用于 Assignee 选择、Project 选择等所有富信息选择场景

---

## 10. 待决定事项

| 项目 | 状态 | 备注 |
|---|---|---|
| **Card 与 git 的关系** | 暂用"不绑定"实现 | 三方向：不绑定 / 松绑定（只读展示 branch · commits · PR · CI）/ 强绑定（Card = branch）。强绑定已基本排除 |
| Board 层面展示哪些聚合信息 | 取决于上一项 | — |
| Blocked 横向状态 | 未实现 | 设计已确定 |
| 命名（Board / Card） | 暂用 | 后续可换 Plan / Item / Sprout 等 |
| 后端 schema | 未启动 | SQLite + git branch sync |

---

## 11. 实现现状（前端 mock）

| 文件 | 作用 |
|---|---|
| `grove-web/src/components/Boards/BoardsPage.tsx` | 顶层路由：index ↔ detail |
| `grove-web/src/components/Boards/BoardsIndex.tsx` | 列表页（带 filter / segmented control） |
| `grove-web/src/components/Boards/BoardView.tsx` | Kanban 主视图 |
| `grove-web/src/components/Boards/BoardColumn.tsx` | Kanban 列 |
| `grove-web/src/components/Boards/BoardCard.tsx` | Kanban 卡 |
| `grove-web/src/components/Boards/CardDetailDrawer.tsx` | Card 详情右抽屉 |
| `grove-web/src/components/Boards/BoardSettingsDrawer.tsx` | Board 设置右抽屉（4 tabs） |
| `grove-web/src/components/Boards/CreateBoardDialog.tsx` | 创建 Modal |
| `grove-web/src/components/Boards/BindSessionDialog.tsx` | 绑 Session 两步 modal |
| `grove-web/src/components/Boards/SessionRow.tsx` | 单条 Session 渲染（Tray 风格） |
| `grove-web/src/components/Boards/Avatar.tsx` | 成员头像（boring-avatars） |
| `grove-web/src/components/Boards/RichPicker.tsx` | 通用富信息下拉 + ProjectIconSquare |
| `grove-web/src/components/Boards/types.ts` | 类型定义 |
| `grove-web/src/components/Boards/mockData.ts` | mock 数据 |
| `grove-web/src/components/Boards/utils.ts` | 工具（SYNC_META / MODE_BADGE / 时间格式化） |

Sidebar 入口注册：`grove-web/src/data/nav.ts` 加 `boards`，`Layout/Sidebar.tsx` 的 `ALL_NAV_ITEMS` 配置，`App.tsx` 路由分发。
