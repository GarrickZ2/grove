# Buddy 前端设计

Buddy 是一个全屏模式，从 Workbench 或 Orbit 进入，退出后回到进入前的页面。外框沿用 Orbit 的视觉语言；对话以聊天为主：消息、审批、问答、结果呈现。工具调用、文件读取、diff 等工作细节不进对话，留在会话里，一键可达。

后端接口见 `buddy-backend.md` §5、§8。视觉稿在 Design 画布 "Grove Buddy UI"，本文档的数值以画布为准，实现时以本文档为唯一依据。

## 1. 进入与退出

Buddy 不是 `web.interface` 的取值，不出现在界面选择里。Workbench / Orbit 保留各自外壳，Buddy 作为全窗口覆盖层叠在上面。

```
<Providers>
  现有 Workbench / Orbit 渲染            // 保持挂载，不卸载
  {buddyOpen && <BuddyApp onExit={…} />}  // 全窗口覆盖层
</Providers>
```

- `App.tsx` 持有 `buddyOpen`，存 localStorage；重启恢复。
- 底层外壳保持挂载，退出后页面、Task、Session、滚动位置不变。覆盖层打开期间底层快捷键与命令面板上下文停用（参照 `TasksPage` 的 `pageVisible` 约定）。
- 进入、退出 180ms 淡入淡出，无位移。

### 入口（画板 Entry）

| 位置 | 形式 |
|---|---|
| Orbit `orbit-footer` | Settings 行上方新增一行 "Buddies"（lucide `Bot`，16px，1.6 描边），样式同 `orbit-row orbit-nav-row` |
| Orbit 手机抽屉 | 同一行 |
| Workbench 侧栏底部 | IM Connect 上方新增 `NavButton` "Buddies"；折叠态只显示图标；Island 导航同样加一项 |
| 命令面板 | "Open Buddies"（id `nav-buddies`，关键词 buddy / bot / teammate）；搜索时同时列出各 Buddy 名称与状态、"New Buddy" |
| 徽标 | 任一 Buddy 为 waiting：图标右上 7px 琥珀点；Orbit 行尾另显示等待数量（琥珀浅底小徽标） |

### 退出

| 位置 | 形式 |
|---|---|
| 桌面 | 窗口左上，traffic light 右侧 "‹ Orbit" / "‹ Workbench" 文字按钮（高 30px，13px 次要色），按当前 `web.interface` 显示 |
| 手机 | Buddy 列表页左上 "‹ Orbit" |
| 命令面板 | Buddy 内提供 "Leave Buddies" |

`Esc` 不用于退出。从 Buddy 跳到某个 Session（"Open in Orbit / Workbench"）时，关闭覆盖层并调用底层外壳的 `onNavigate`。

Grove 没有用户账户，Buddy 内不显示用户信息。

## 2. 视觉

外框与 Orbit 一致，颜色取主题变量：

| 用途 | 变量 / 取值（light 主题参考值） |
|---|---|
| 页面底色 | `var(--color-bg)`（#fafafa） |
| 侧栏底色 | Orbit `--orbit-surface`：`color-mix(in oklab, var(--color-bg) 94.5%, var(--color-text) 5.5%)`（≈#f0f0f1） |
| 分隔线 | `color-mix(in oklab, var(--color-border) 70%, transparent)`（≈#e4e4e7） |
| 行 hover / 选中 | `color-mix(in oklab, var(--color-text) 9%/10%, transparent)`，同 `.orbit-row` |
| 次要文字 | `var(--color-text-muted)` |
| 用户消息气泡 | `color-mix(in oklab, var(--color-text) 7%, var(--color-bg))`（≈#ececee），圆角 18px |
| 助手消息 | 纯文本，无气泡 |
| 卡片 | 白底 `var(--color-bg)` 提亮一档，1px 分隔线色边框，圆角 12px |
| 审批卡 | 边框 `color-mix(var(--color-warning) 45%, var(--color-border))`，底 `color-mix(var(--color-warning) 4%, var(--color-bg))` |
| working / waiting | `var(--color-success)` / `var(--color-warning)`；waiting 文字用深一档（light 下 #b45309）保证 4.5:1 |

图标用 lucide-react，按钮 32px 透明底、圆角 6px（同 `.orbit-icon-button`），不用 emoji。

## 3. 按 Buddy 数量适配

| 数量 | 布局 | 画板 |
|---|---|---|
| 0 | 引导页，无侧栏 | Zero |
| 1 | 无侧栏，顶栏 Buddy 切换器 | Single |
| ≥2 | Orbit 风格左侧栏列表 | Main |

切换在数据变化时实时发生（新建第二个 Buddy 后侧栏出现，归档到只剩一个后侧栏收起），过渡 180ms。

### 0 个：引导页

- 顶栏 52px：traffic light、"‹ Orbit"，右侧全局设置按钮。
- 内容居中（同 `.orbit-new` 的居中方式），最大宽度 760px：
  - 三个头像一组（40 / 56 / 40px，中间 working，两侧 idle）
  - 标题 "Start with a Buddy"（26px / 500，同 `.orbit-new__title`）
  - 说明 14.5px 次要色："A Buddy is a teammate that stays on. It remembers how you work, runs routines, and hands bigger jobs to other agents."
  - 2×2 模板卡片：44px 头像 + 名称（14.5 / 600）+ 职责（13px）+ 附带说明（12px 次要色）。点击打开新建对话框并预填。
  - 主按钮 "Start from scratch"，下方 12px 说明 "Buddies run on your installed agents. Nothing runs until you send the first message."
- 模板为前端常量：Release Captain（附 9:00 Routine）、Code Scout、Morning Brief（附 8:30 Routine）、Inbox（提示配合 IM Connect）。模板只预填表单，Routine 在 Buddy 创建成功后通过 Routine 接口创建，失败不影响 Buddy 本身并提示。

### 1 个：切换器

- 顶栏 52px：traffic light、"‹ Orbit"、竖分隔线、切换器按钮（24px 头像 + 名称 14 / 600 + 状态 12.5px + 下拉箭头），右侧 Buddy 设置、面板开关。
- 切换器菜单 300px：当前 Buddy（28px 头像、名称、Role，打勾）；分隔线；"New Buddy"（虚线圆框 +）；"Browse templates"（回到引导页模板，作为对话框打开）。
- 对话区同 ≥2 时，居中最大宽度 720–760px。

### ≥2 个：侧栏

宽 256px，侧栏底色，右侧 1px 分隔线：

- 顶部 52px：traffic light、"‹ Orbit"。
- 分组标题行 34px："Buddies"（12.5px / 500 次要色）+ 右侧 28px "+"（新建）。
- 列表行：最小高 48px，padding 7px 8px，圆角 8px，间距 2px；30px 头像 + 名称（14px / 500，waiting 为 600）+ 时间（11.5px）+ 预览（12.5px 单行，waiting 时为 "Needs your approval" 琥珀色）。
- 底部 `orbit-footer` 样式：Settings 行，在 Buddy 内以覆盖层打开全局 `SettingsPage`（使用真实全局 config），关闭回到对话。
- 超过 8 个时标题行出现搜索按钮，展开为搜索框；拖拽排序 → `PATCH /buddies/order`；右键菜单：设置、归档。

## 4. 头像

简单的色块小角色：带形状的纯色块 + 一双白色竖条眼睛，动作表示状态。实现以 `components/Buddy/BuddyAvatar.tsx` 与 `buddy-avatar.css` 为准，效果见 `docs/design/buddy-avatars.png`。

### 数据

后端 `avatar` 为 TEXT，前端存 JSON：`{"shape":"blob","color":"#f59e0b"}`。空值或解析失败时按 Buddy id 哈希确定，保证稳定。过渡版本存下的 `{"kind","color"}`（如 `{"kind":"acorn","color":"sun"}`）读取时映射到对应形状与色值，不需要迁移。

| shape | border-radius |
|---|---|
| circle | `50%` |
| blob | `58% 42% 52% 48% / 48% 56% 44% 52%` |
| squircle | `32%` |
| drop | `50% 50% 50% 14%` |

颜色：`#10b981` `#14b8a6` `#3b82f6` `#6366f1` `#8b5cf6` `#f59e0b` `#ef4444`。

### 组件

`<BuddyAvatar id avatar size state label? />`，宽高与 `font-size` 都设为 `size`，眼睛和动画用 em 随尺寸缩放。尺寸：侧栏 30，头部 26，切换器 26 / 30，模板卡 44，新建预览 72，手机列表 44，手机头部 30，活动行 22。

| state | 动作 |
|---|---|
| idle | 每 4.6s 眨眼 |
| working | 上下轻晃，眼睛左右看 |
| waiting | 周期性压缩后跳起，眼睛变大 |

`prefers-reduced-motion` 下全部静止。列表行保留 12px 状态点，动作关闭时状态仍可辨认。新建对话框：4 个形状按钮 + 7 个色点。

## 5. 头部

高 52px，左 padding 20px：24px 头像（跟随状态）、名称 14px / 600、状态 12.5px（Working 绿 / Waiting for you 琥珀 / Idle 次要色）。右侧两个 32px 图标按钮：Buddy 设置（滑块图标，打开面板 Settings 页签）、面板开关（展开时有底色）。头部不放 Agent / Model 选择器。

## 6. 对话区

### 渲染方式

Buddy 不复用 `TaskChat` 的消息渲染。新增 `BuddyTimeline`，消费当前 Segment 的同一份 session 事件流（复用现有 history API 与 WebSocket 连接层），按下表把事件映射为 Buddy 元素。`TaskChat.tsx`、`chatRenderItems.ts` 不改动。

内容区最大宽度 720px 居中，元素间距 14px，正文 14.5px / 1.6。新消息自底部出现（贴底滚动）。

| 事件 | 渲染 |
|---|---|
| 用户消息 | 右侧灰色气泡；附件显示为文件小卡 |
| 助手文本 | 纯文本 markdown，不加气泡、不加头像 |
| 一个 turn 内的工具调用、思考、计划 | 合并为一行活动（见下） |
| 本 Buddy 的权限请求 | 审批卡 |
| `ask_form` / elicitation | 问题卡 |
| `buddy_delegate` 工具调用 | 运行中委派卡（结果到达后被结果卡替代） |
| `buddy_routine_*` 工具调用 | 居中事件行 "Created routine · {name}" 等 |
| 委派状态投递（带 delegation meta）、Routine 触发的 prompt、其他 Buddy / Session / Automation 发来的 prompt | **不显示**。判定：`UserMessage.sender` 非空且不是 `connect`（`buddy:*`、`agent:*`、`automation:*` 等）。Buddy 照常收到并处理，只显示它的回复；回复前不加来源标签 |
| 委派处于 waiting（来自委派列表状态，不依赖投递消息） | 订阅该委派的 `target_session`，按其待处理请求渲染审批卡 / 问题卡，标注来源 subagent |
| IM 消息（sender `connect`） | 用户气泡 + 平台小图标 |
| Segment 分隔（第二批） | 居中 12px 次要色 "Switched to Claude Code · Today" |

### 活动行

- 进行中：20px working 头像 + 一行 13px 当前步骤（取最近一个工具调用的标题，如 "Reading the CI workflow…"），文字带左右扫过的明暗动画（reduced-motion 下静止）。
- 结束：收起为一行 12.5px 次要色 "Worked for 1m 12s · 4 steps" + 展开箭头。
- 展开：左侧 2px 竖线，步骤标题列表（12.5px），最后一行 "Open session in Orbit"（覆盖层关闭并导航到该 Session）。
- 不显示工具参数、输出、diff、终端内容。

### 审批卡

宽 480px，琥珀边框与浅底，圆角 12px，padding 12px 14px：

- 顶行 8px 琥珀点 + "Needs your approval"（12px / 600）
- 标题：权限请求的 `title`（14px / 600）
- 来源：本 Buddy 时省略；subagent 时 "{委派标题} · subagent in {project} / {task}"（12.5px 次要色）
- 预览：有 `detail` 时显示，diff 只显示前 6 行（红 / 绿底等宽 12px），其余收进 "Show more"
- 按钮：按 `options` 渲染，`allow_once` 为主按钮，`reject_*` 在左
- 处理后收起为一行："✓ Allowed once · {title}" 或 "✕ Rejected · {title}"（12.5px 次要色，图标绿 / 红）

本 Buddy 的请求走当前 Segment 的权限响应。subagent 的请求：委派列表（Buddy 会话有事件时刷新 `GET /buddies/{id}/delegations`）显示某委派处于 waiting 时，前端对其 `target_session` 建立只读订阅（复用现有 history 加载与 WebSocket 连接层，连接时会回放当前待处理的权限 / ask_form / elicitation），据此渲染卡片，并通过该连接发送响应；委派离开 waiting 后关闭订阅。卡片状态以订阅到的实时状态为准，请求已不在则显示收起态。

### 问题卡

宽 480px，普通卡片样式：问题标题 14px / 600；选项为 30px 胶囊按钮（选中为实心黑）；文本题为 32px 输入框；底部 Skip（可选）/ Send。提交后卡片消失，回答显示为一条用户气泡。表单定义复用现有 ask_form / elicitation 的数据结构与提交接口。

### 委派卡与呈现

- 委派卡：由 Buddy 的 `buddy_delegate` 工具调用生成。一行卡片，8px 状态点 + 标题 + 状态文字（Running 带扫光动画 "Subagent working · 2m"；Done 显示 "Done"，点击打开 Delegations 页签对应项；Failed / Cancelled 为红 / 灰）。状态取委派列表，不依赖投递消息。
- 结果呈现：委派结果本身不进对话，由 Buddy 在回复里整理呈现。助手 markdown 的列表、表格、勾选清单、附件按卡片化样式渲染（白底圆角 12px 容器包裹表格与清单，附件为文件小卡）。

### Composer

Orbit 风格：宽同内容区，圆角 22px，1px 边框，轻阴影；多行输入（14.5px），底行左侧 32px 附件按钮、右侧 32px 黑色语音 / 发送按钮。placeholder "Message {name}"。

### 忙碌时发消息

不打断当前回合，沿用现有排队，但不暴露队列：

- 连接 Buddy 当前 Segment 时发送现有 `SetQueueMode { mode: compact }`；当前回合结束后，后端把队列里的消息合并成一条交给 Buddy。
- 排队中的用户消息直接显示为普通已发送气泡，不显示 "Queued"、不提供编辑 / 撤回。
- Buddy 忙时发送按钮保持为发送；停止当前回合放在活动行右侧的小 "Stop" 按钮。
- Buddy 卡在审批卡时，新消息同样排队，审批处理后一并交给 Buddy。
- 刷新后历史里合并后的消息可能显示为一条气泡，可以接受。

## 7. 侧边面板（画板 Panel、SwitchAgent）

默认收起，宽 340px，可拖拽（最小 320px），展开状态存 localStorage。顶部 52px 页签条，页签为 28px 文字按钮，选中有底色并加粗。

| Tab | 内容 |
|---|---|
| Delegations | 按 Needs you / Running / Done 分组。Needs you 项展开为卡片：标题、状态徽标、目标与 Agent、brief、内嵌待处理请求（同审批卡的紧凑版）、"Open in Orbit"、Cancel。其余为两行列表项，点击展开 |
| Routines | 复用 Automation 的数据与组件逻辑，见下 |
| Memory | 复用 Memory 的数据与组件逻辑，见下 |
| Settings | Name、Role、Instructions、Agent（Agent / Model / Effort 三选择器 + 说明 "Model and effort apply now. A new Agent starts a new context."）、头像、IM、Archive Buddy |

### Routines 页签

只回答"有哪些、什么时候、做什么"，不展示运行状态与历史。

数据：`listAutomations(buddy.project_hash)`、`triggerAutomation`、`updateAutomation`、`deleteAutomation`（`api/automations.ts`）。cronstrue 描述与 `formatRelative` 从 `AutomationPage` 抽成共享函数，不复制。

- 用户 Routine 卡片（白底圆角 10px）：
  - 首行：启用开关（`ToggleSwitch` → `updateAutomation` 的 enabled）、名称
  - 第二行：日历图标 + cronstrue 描述（24 小时制）· next {相对时间}；停用时为 "paused"；有 `event_triggers` 时追加 "On event: …"
  - 描述：`prompt` 全文，最多 3 行，超出展开
  - 不显示 last_run_status、错误、task / session 目标、运行历史
  - 操作（hover 显示）：Run now、Edit、Delete（确认对话框）
- 系统 Routine：Memory organization 显示为灰底只读一行（锁图标、频率、Enabled / Paused），右侧 "Memory tab" 跳转到 Memory 页签。
- 新建 / 编辑：复用 `AutomationDialog`，传入 Buddy 目标并隐藏 Task / Session 目标选择与 Agent 选择（Routine 由 Buddy 自己执行）。保留名称、prompt、schedule（cron 预设与自定义）、event triggers。
- 底部："+ New routine" 按钮 + "or ask in chat"。

### Memory 页签

只看 Memories 和 Logs，不展示整理状态与 Runs。

数据：`getMemoryOverview`（只取 entity_count、log_count）、`listMemoryEntities`、`getMemoryEntity`、`deleteMemoryEntity`、`listMemoryLogs`、`deleteMemoryLogs`、`listMemoryRelations`（`api/memory.ts`），project 为 `buddy.project_hash`。

- 分段切换：Memories · {entity_count} / Logs · {log_count}。
- Memories：搜索框（placeholder 同 MemoryPage："Search memories, descriptions, or tags"）；行：标题、Score 徽标、单行描述、tag 小标签（`key · value`）。点击在面板内打开文档视图：返回、删除（确认文案同 MemoryPage）、标题、Updated 日期、Score、tags、正文 markdown、Related（`listMemoryRelations`）。
- Logs：行格式同 MemoryPage 的 log 行（标题、日期、单行描述、#tag、来源 Task 与 agent），支持多选批量删除。
- 底部 "Open Memory page for this Buddy"：关闭覆盖层，进入 Memory 页面并定位到 Buddy 的 project（整理状态、Runs、图谱、配置都在那里，面板内不重复）。

### Settings 页签与换 Agent

换 Agent：在 Agent 下拉菜单底部展开确认区（浅灰底），文案 "Switch to **{agent}**? This starts a new context. {agent} reads the earlier chat when it needs to. Memory, routines and IM stay as they are." + Cancel / "Switch to {agent}" → `POST /buddies/{id}/agent`。忙时禁用并提示 "Stop the current turn to switch Agent"；409 `buddy_busy` 同样提示。

Archive：确认对话框说明数据保留，Routine 与 IM 不会自动停止。

## 8. 新建 Buddy（画板 CreateBuddy）

对话框 540px，圆角 14px，页面底色：头部 48px 标题 + 关闭；72px 头像预览 + 4 个形状按钮 + 7 个色点；Name、Role、Instructions（可选）；Agent / Model / Effort；来自模板时显示一条 "From template: adds the routine {name} · {time}" 与 Remove；底部 Cancel / Create Buddy。提交 → `POST /buddies` → 选中新 Buddy。

## 9. 通知与未读

- Buddy 变为 waiting 或委派完成：走现有通知系统（`NotificationPopover`、系统通知、tray），点击打开覆盖层并选中该 Buddy。
- 未读：非当前 Buddy 有新的助手消息 → 名称加粗、行尾未读点；按 `last_activity_at` 与本地最后查看时间比较。

## 10. 移动端（画板 Mobile）

- 入口：Orbit 手机抽屉底部 Buddies 行。
- 列表页：侧栏底色；左上 "‹ Orbit"、右上 44px "+"；大标题 "Buddies"（28px / 700）；行最小高 60px，44px 头像。0 个和 1 个时直接显示引导页 / 对话。
- 对话页：顶部 44px 返回、28px 头像、名称与状态、44px Buddy 设置按钮；元素同桌面，审批按钮高 40px 并排；面板改为底部 sheet；Composer 圆角 25px、带阴影。
- 返回手势复用 `useOrbitDrawerSwipe` 的实现思路。平板沿用桌面布局。

## 11. 接口字段

| 接口 | 字段 |
|---|---|
| `GET /buddies` | id、name、avatar、description、agent、status、last_message_preview、last_activity_at、active_session_id、running_delegations |
| `GET /buddies/{id}` | 上述 + project_hash、local_task_id、role、system_prompt、agent_config、segments[] |
| `GET /buddies/{id}/delegations` | id、title、status、target_project、target_task、target_session、last_result、updated_at |
| 委派投递 meta | delegation_id、target_session、status |

后端缺失的字段在 mock 中补齐并在汇报中列出。

## 12. 文件

| 文件 | 内容 |
|---|---|
| `api/buddies.ts`、`api/buddies.mock.ts` | REST 客户端、类型、mock |
| `components/Buddy/BuddyApp.tsx` | 覆盖层根、按数量切换布局、选中状态 |
| `components/Buddy/BuddyOnboarding.tsx`（新） | 0 个引导页与模板 |
| `components/Buddy/BuddySwitcher.tsx`（新） | 1 个时的顶栏切换器 |
| `components/Buddy/BuddySidebar.tsx`（由 BuddyList 调整） | ≥2 时侧栏 |
| `components/Buddy/BuddyAvatar.tsx`、`buddy-avatar.css` | 头像 |
| `components/Buddy/BuddyConversationHeader.tsx` | 头部 |
| `components/Buddy/timeline/*`（新） | `BuddyTimeline`、事件映射、ActivityLine、ApprovalCard、QuestionCard、ResultCard、DelegationRunningCard、EventLine |
| `components/Buddy/BuddyComposer.tsx` | Orbit 风格 composer |
| `components/Buddy/BuddySidePanel/*` | 页签 |
| `components/Buddy/CreateBuddyDialog.tsx` | 新建 |
| `hooks/useBuddies.ts` | 列表、状态订阅、未读 |
| `App.tsx` | `buddyOpen`、覆盖层、底层停用 |
| `components/Layout/OrbitSidebar.tsx`、`components/Layout/Sidebar.tsx` | 入口与徽标 |
| `hooks/useCommands.ts` | 命令 |
| `components/Memory/MemoryPage.tsx`、`components/Automation/AutomationPage.tsx` | 当前 Buddy 的单 Project 范围（已实现，保留） |

## 13. 分批

### 第一批（不依赖委派消息格式）

1. 进入与退出：`App.tsx` 覆盖层、三处入口与徽标、命令、返回按钮（§1）。
2. 外框 Orbit 化与按数量适配：引导页、切换器、侧栏（§2、§3、§5）。
3. `BuddyTimeline` 基础：用户消息、助手文本、活动行、本 Buddy 的审批卡与问题卡、事件行、Compact 排队（§6），替换现有 TaskChat 挂载。
4. 侧边面板：Routines、Memory、Settings（含换 Agent）（§7）；新建对话框更新（§8）。
5. 移动端（§10）。

### 第二批（后端委派与 REST 完成后）

1. 去掉 mock，接真实接口。
2. 委派卡、结果卡、subagent 来源的审批卡 / 问题卡。
3. Delegations 页签。
4. Segment 历史拼接。
5. 通知与未读。

## 14. 待确认

1. 轻委派的 subagent session 只在 Delegations 页签与对话卡片中出现，不在任何列表里列出 session 本身。后端 `buddy_list_sessions` 暂不过滤。
