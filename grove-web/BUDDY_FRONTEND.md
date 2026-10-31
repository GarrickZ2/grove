# Buddy 前端第一批实现记录

依据：当前 `docs/design/buddy-frontend.md` 全文、§13 第一批五步；接口核对参考 `docs/design/buddy-backend.md` §5、§8 与仓库现有实现。用户授权连续完成五步，并确认头像冲突处以 §4 为准。

## 已完成范围

1. **覆盖层与入口**：Buddy 不属于 `web.interface`。Workbench 普通 / 折叠侧栏与 Island、Orbit 侧栏与手机抽屉均提供 Buddies 入口。任一 Buddy 为 waiting 时显示主题警示色圆点；Orbit 同时显示等待数量。命令包含 Open Buddies、Leave Buddies、New Buddy 与按名称打开 Buddy。
2. **进入和退出**：App 持有打开状态，保存至 `grove-buddy-open`。覆盖层用 180ms 透明度动画；原页面保持挂载，通过 inert、InteractionContext、TasksPage / WorkPage 的 pageVisible 停用底层交互和命令上下文。返回按钮统一显示“‹ Grove”；退出恢复原页面与焦点；Esc 不退出 Buddy。内部 Grove Settings 关闭只返回对话，并与外壳共用真实全局 config。
3. **按数量适配**：零个 Buddy 显示引导页与四个模板；一个使用顶栏切换器；两个及以上使用 256px 侧栏。超过八个才提供搜索。保留选择、排序、归档和面板偏好。模板支持移除预设 Routine；创建 Routine 失败时保留已创建的 Buddy，并提示失败。
4. **头像**：mushroom / acorn / leaf / pot，六种 Grove 渐变，序列化为 `{kind,color}`；无有效头像时按 ID 稳定生成。§4 CSS 只添加 buddy- 类名 / 动画前缀，保留原形状与动画、reduced-motion 规则。
5. **独立对话**：BuddyConversation 使用 BuddyTimeline 和 BuddyComposer，不挂载 TaskChat。用户气泡、助手 Markdown、每回合合并活动行、停止、本 Buddy 的审批与提问、Routine 事件行均独立呈现。非空且非 connect 的 sender 用户消息不显示；保留内部边界，避免将后续回复合并到上一回合。
6. **现有会话协议**：复用当前 Segment 的 history、现有 WebSocket 路径和连接登记层，以及已有 ACP v1 / v2 内容 reducer。连接就绪发送 `set_queue_mode: compact`。发送等待 `input_accepted`，忙时显示普通已发送气泡，合并回合的回显不会重复显示；不打断当前回合。审批按 request ID / option ID 响应；ask_form 使用共享答案验证与 Markdown 序列化，elicitation 使用原结构化提交协议。历史加载期间缓冲事件并去除已包含的重叠文本；重连释放旧监听。
7. **Routines**：单 Buddy Project 内调用现有 Automation API。展示开关、名称、24 小时时间说明、下一次执行、描述、事件触发条件；支持运行、编辑、删除确认。系统整理 Routine 为只读行，链接 Memory 页签。复用 AutomationDialog，隐藏 Task / Session / Agent 目标选择，将目标固定为 Buddy 的 `_local` / `buddy_active`。
8. **Memory**：只显示 Memories / Logs 与数量，复用共享列表、搜索、详情、Score、tags、关联、删除确认及 Logs 多选删除。Open Memory page 退出覆盖层，定位 Buddy Project 的完整 Memory 页面。
9. **Settings 与新建**：复用现有安装 Agent 目录、ChatConfigMenus、PickerMenu；支持头像、名称、Role、Instructions、Agent 切换确认与忙时 409 提示、配置更新、固定 Buddy 目标的 IM Connect。不存在 Buddy 专属 Agent 能力接口或 mock 全局 config。
10. **手机和平板**：手机列表 / 对话两级导航、44px 触控按钮、返回手势、底部 sheet、安全区域与 Composer；零个和一个直接进入引导 / 对话。平板保留桌面布局。

## 删除、保留与共享代码

删除旧 InterfaceRouter 及测试、config.buddy.test、`buddy` interface 取值、withMockInterface、grove-buddy-interface 存储和界面选择中的 Buddy 选项。删除旧头像方案、BuddyList（改为 BuddySidebar）、TaskChat 挂载与隐藏其 Composer 的 CSS。

保留明确 mock 开关、现有单 Project 数据范围、侧边面板业务、专属 Composer。`TaskChat.tsx` 与 `chatRenderItems.ts` 均未修改。

共享代码来自现有页面和组件，而非复制：

- `Automation/automationFormat.ts`、`ToggleSwitch.tsx`：原 AutomationPage 的格式与开关；AutomationPage 与 BuddyRoutines 共用。
- `Memory/MemoryBrowser.tsx`、`MemoryPrimitives.tsx`、`memoryFormat.ts`、`memorySource.ts`：原 MemoryPage 的列表 / 详情 / 行组件与数据适配；LogsTab 保留在 MemoryPage 并导出复用，保持原有 ESLint 注释不变。
- `Tasks/TaskView/surveyAnswers.ts`：原 FormPill 的答案模型、校验和序列化；FormPill 与 Buddy QuestionCard 共用，未修改 TaskChat。
- `api/chatSockets.ts` 与已有 backgroundChatConnections：登记、获取会话连接和确认发送；Buddy 连接使用现有连接准备 / 超时监控工具。

## 真实接口与 mock

Agent 配置来源与菜单修正：`useBuddyAgents` 使用现有 `/api/v1/agents/installed`。后端从 SQLite 的 `installed_agents` 表读取安装记录及 `capability_snapshot_json`（最近一次真实 ACP 能力快照）；新建默认 Agent 取 Grove 全局配置的 `acp.agent_command`。Model / Effort 的 `Default` 表示不写入覆盖值，沿用 Agent 默认值。品牌图标复用统一的 `agentIconComponent` 注册表。

Buddy 的 Agent / Model / Effort 选择继续复用 PickerMenu / ChatConfigMenus，并启用可选的视口浮层：菜单脱离弹窗滚动裁切，按空间选择上 / 下方向、限制宽高，滚动 / 调整窗口时重新定位；换 Agent 确认区保持在同一菜单中。其他调用方保留原定位方式。

本轮检查：ESLint 通过，生产构建通过（41.71s）；新增三项菜单 / 图标测试通过。完整测试两次均在既有 `TaskChat.draft.test.tsx` 的 `retains timeline disclosures...` 测试超过 5 秒，最后一次为 883 通过 / 1 超时，未改其超时或测试配置；降低并发重跑等待用户确认。实际 Grove 页面中，Agent 菜单已位于 body 独立浮层，1280×720 窗口内边界为 y=231.625–525.125；切换 Codex 后模型菜单 y=60.21875–525，均完整位于窗口内。已确认 TraeX / Codex / Claude 等内置品牌图标资源加载，以及真实 Codex 模型 / Effort 选项显示；检查未提交新建表单。

唯一总开关：`src/api/buddies.mock.ts` 中 `BUDDIES_MOCK_ENABLED = import.meta.env.VITE_BUDDIES_MOCK === "true"`。**默认关闭**；显式设置 `VITE_BUDDIES_MOCK=true` 后启动或构建才启用。没有界面配置拦截。

正常模式使用仓库已有能力：

| 能力 | 接入 |
| --- | --- |
| Buddy CRUD / Agent 切换 / 排序 | `/api/v1/buddies`；数组响应；排序 `{ids}`；现有 POST agent |
| Agent 目录与配置 | 安装 Agent 目录和 capability snapshot，ChatConfigMenus / PickerMenu |
| 对话与附件 | 现有 Task / Chat history、WebSocket、上传 |
| Routine | 现有 Project Automation CRUD / trigger |
| Memory | 现有 Project Memory overview / entities / relations / logs |
| IM | 现有 Connect 平台、凭据验证、创建与列表；目标为 Buddy |
| 全局 Settings | 与底层外壳同一个 ConfigProvider |

本次只读核对现有后端发现的字段差异：

| 字段 | 真实模式 | mock |
| --- | --- | --- |
| `running_delegations` | 当前 Buddy 响应未直接提供，从已有委派列表统计 running | 明确提供数量 |
| `local_task_id` | 当前 Buddy 响应未直接提供，使用后端 Buddy 已有约定 `_local` | 明确提供 `_local` |
| nullable Role / Instructions / Agent config | 前端归一化为空文本或已有默认配置 | 提供完整示例值 |

mock 另外提供完整列表 / 详情字段、`{kind,color}` 头像或稳定默认、`segments[].session_id/seq/agent/started_at/ended_at`、委派元数据、Routine 时间 / 状态、Memory 文档 / Logs / 数量、IM 目标 / runtime、模拟用户和助手消息、工作中活动与本 Buddy 审批请求。委派仅为数据与统计，没有第二批卡片。Memory 关联接口沿用共享代码，mock 默认关联为空。

mock CRUD、对话、Routine、Memory 和 Connect 写入只保存在内存，刷新重置；打开状态、选择、面板宽度 / 开关、文字草稿保存在 localStorage。Agent 目录与全局设置仍使用真实 Grove 能力，不伪造这些接口。没有保存 IM 凭据到 mock 存储。

## 分步检查

每一步均在 grove-web 执行：

```sh
pnpm eslint src/ --max-warnings 0
pnpm test
pnpm run build
```

| 步骤 | ESLint | Vitest | Build |
| --- | --- | --- | --- |
| 1 入口与退出 | 通过 | 116 文件 / 859 测试 | 通过 |
| 2 外框与头像 | 通过 | 116 文件 / 861 测试 | 通过 |
| 3 BuddyTimeline | 通过 | 118 文件 / 868 测试 | 通过 |
| 4 侧边面板 | 通过 | 120 文件 / 872 测试 | 通过 |
| 5 手机与集成回归 | 通过 | 120 文件 / 876 测试 | 通过 |
| 最终收尾回归 | 通过 | 121 文件 / 878 测试 | 通过（33.92s） |
| 入口样式与 Grove 返回按钮修正 | 通过 | 121 文件 / 879 测试 | 通过（32.90s） |
| 完整 Agent 配置菜单 | 通过 | 122 文件 / 888 测试（`--maxWorkers=2 --minWorkers=1`） | 通过（38.90s） |
| Buddy 顶栏窗口拖动 | 通过 | 122 文件 / 891 测试（`--maxWorkers=2 --minWorkers=1`） | 通过 |
| 用户消息隐藏初始化上下文 | 通过 | 123 文件 / 896 测试（`--maxWorkers=2 --minWorkers=1`） | 通过（31.04s） |
| 单行输入框与固定发送按钮 | 通过 | 123 文件 / 900 测试（`--maxWorkers=2 --minWorkers=1`） | 通过（53.99s） |
| 工作中空输入显示停止 | 通过 | 124 文件 / 908 测试（`--maxWorkers=2 --minWorkers=1`） | 通过（32.44s） |
| 活动详情宽高与折叠 | 通过 | 126 文件 / 916 测试（`--maxWorkers=2 --minWorkers=1`） | 通过（36.83s） |

## 完整 Agent 配置菜单

新建 Buddy 和侧栏 Settings 共用 `BuddyAgentFields`，通过现有 `useBuddyAgents` / `listInstalledAgentConfigs` 读取 `/api/v1/agents/installed` 的完整 capability snapshot，mock 开启时也使用真实 Agent 目录。配置来自后端保存的 Agent 能力快照，并非前端内置的 Model / Effort 清单；未连接过、尚无快照的 Agent 不伪造选项。

- 与 TaskChat / Orbit 相同，按 category 提取 Model、Mode、Thinking 快捷项，名称、选项、描述、分组和当前值均由 Agent 配置提供。其余配置复用 `SessionSettingsMenu`，支持 select 和 boolean；只有 boolean 的 Agent 也可以配置。旧版 Agent 使用 snapshot 中的 available modes。
- 已保存的 Buddy overrides 优先于快照 currentValue；仅展示默认值不会写入覆盖配置，修改单项保留其他已保存值。新建和更新沿用原有 `agent_config` 载荷。
- Agent 菜单复用品牌图标，选择菜单使用 portal 避免被弹窗裁切；共享 SessionSettingsMenu 增加可选菜单 ref，确保菜单内部操作不会被 Buddy 的外部点击处理提前关闭。
- 按用户最新要求扩展设计中“Agent / Model / Effort”的固定描述为完整动态配置。未修改 TaskChat 或后端，未新增 mock 接口或字段。
- 回归覆盖 Agent 自定义名称、默认值与覆盖值、Mode、额外分组选择项、boolean 开关、旧版 modes 和 portal 内部点击。
- 实际 Grove 页面验证：Claude Agent 显示 Opus 5.5 / Bypass permissions / Medium，品牌图标成功加载；TraeX 显示自身的三项配置；Codex 额外显示 Collaboration mode 和 Fast mode。已在未提交的新建表单中选择 Plan、打开 Fast mode，再次打开菜单确认两项同时保留；额外菜单在 1280×720 窗口内完整显示。验证后关闭表单并返回原页面，没有创建 Buddy 或修改真实 Agent 会话配置。

最终补充了桌面 / 手机入口与等待徽标、退出焦点恢复、会话 hook 历史 / 响应 / 重连释放测试。三项检查全部通过，`git diff --check -- grove-web` 通过。

真实 Grove 浏览器检查已确认：Orbit 入口打开覆盖层，零 Buddy 引导，新建表单加载真实 Agent 配置，退出返回原 Memory 页面。额外 mock Vite 预览因现有 linguist-languages 的字符串导出与 dev optimizer target 不兼容退出；经用户明确确认，跳过该额外预览，未改依赖或构建配置。**未完成真机视觉检查及真实 Agent 的完整发送 / 审批 / 提问往返联调**，不能用测试通过替代这些验收。

生产构建有既有大 chunk 提示，成功退出。未新增依赖，未改 ESLint 配置或增删 eslint-disable 注释；未 commit / push。本次修改限于 grove-web，未修改 Rust；工作区其他任务的未提交改动保留。

## 与设计的差异和范围边界

- 活动详情按后续宽高反馈收紧：活动标题与每步摘要为单行省略，按步骤展开完整内容；列表最高 `min(280px,35dvh)`，单步全文最高 `min(160px,22dvh)`，分别纵向滚动。长命令与无空格参数按可用宽度换行，对话内容显式限制为容器宽度且最大 720px；手机步骤按钮至少 44px。全文保留，可收起；新增步骤不会关闭正在查看的详情。
  经用户确认，仅修复 `useBuddySession.ts` 的 memo 依赖声明及 `buddySegmentHistory.test.ts`、`useBuddySession.test.tsx` 的 ChatMessage 类型收窄，未改变历史会话逻辑。完整 ESLint、126 文件 / 916 项测试和生产构建全部通过。
  真实 Grove 会话验证：1280×720 窗口打开设置侧栏后，对话宽度 940px，内容限制为 720px；13 步列表高 252px，1688 字符命令详情上限 158.4px，全文完整且内部纵向滚动。对话区、活动列表及命令详情的 scrollWidth 均等于 clientWidth，没有横向溢出；底部输入框仍完整可见。未发送消息或执行命令。
- 后续界面反馈已落实：Settings 与 IM Connect 固定在同一行；Buddies 使用简洁的 Sprout 图标与导航箭头；返回文字改为“‹ Grove”。macOS 标题区按 54px 高度居中，返回按钮起始位置留至 96px，与 traffic light 拉开距离；普通浏览器不预留原生窗口按钮的空位。
- 输入框按用户最新要求改成单行布局：附件按钮、文字输入、发送 / 停止按钮位于同一行。移除 Buddy 的录音入口及录音 / 转写调用；空闲时显示发送，空内容禁用；Working / Waiting 且没有文字或附件时显示停止，有内容则继续发送到队列。停止复用当前会话 WebSocket 的 `cancel` 事件，连接不可用时提示错误，等待服务端状态更新，不提前把 Buddy 标为空闲。保留附件、草稿、输入法保护和 Shift+Enter 换行，多行文字在单行高度内滚动。
  真实 Grove 页面确认桌面输入框总高 52px，三个控件均在第一行垂直居中；空白时发送按钮置灰且没有录音按钮。验证未发送消息或改动草稿。
  后续停止入口已在真实 Working 会话中确认：空输入显示可点击的 `Stop response` 按钮。测试验证它向当前 Buddy 的 active session socket 发送一次 `cancel`，并覆盖文字 / 附件切换、断连和取消错误。浏览器验证未实际取消正在运行的用户会话，真实 Agent 停止往返仍待实际使用确认。
- Buddy 对话顶栏、零 Buddy 引导页顶栏和侧栏顶部均声明 `data-tauri-drag-region="deep"` 与 `data-window-drag-strip`，复用现有 Tauri 原生窗口拖动和 App 的拖动处理。顶栏按钮仍保留交互，不将聊天内容声明为拖动区域；测试覆盖 0 / 1 / 多 Buddy 布局的标记和返回、切换、设置按钮。实际原生窗口拖动仍需在桌面应用验收，浏览器测试不能验证 OS 窗口移动。
- Buddy 用户消息使用现有 `parseGroveMetaSegments` 解析器，在展示时隐藏 v1 `grove_session_init` 初始化元数据，与 TaskChat 的过滤规则一致。保留实际用户文字、换行缩进、附件和 IM 标记；元数据单独成条时不显示空气泡，格式错误的标签和其他类型不会被误删。历史、实时及 ACP v2 消息共用此显示路径，不修改持久化历史或发送给 Agent 的上下文。
  已在真实 Grove 会话历史中确认用户气泡仅显示 `hi`，不再展示初始化元数据；未发送测试消息。

- §8 的旧头像数量 / 尺寸与 §4 冲突，按用户确认采用 §4 的四形状、六渐变、76px 创建预览、30px 手机头部。
- 正常模式已尽量复用当前已有真实接口；mock 是显式预览选项，不因为文档把真实接口接入列在第二批就替换现有能力。
- 不包含第二批：委派 / 结果卡、subagent 审批或提问订阅、Delegations 页签、历史 Segment 拼接、通知和未读。

## 主要改动文件

- 覆盖层 / 入口：`App.tsx`、`BuddyOverlay.tsx`、`buddyLaunchContext.ts`、`buddyNavigation.ts`、`BuddyEntryIcon.tsx`、`useBuddyOpen.ts`、Sidebar / OrbitSidebar、useCommands、keyboard 的 InteractionContext 与命令注册 hook、DialogShell / dialogLayerContext。
- Buddy 内部：`BuddyApp.tsx`、`BuddyOnboarding.tsx`、`BuddySwitcher.tsx`、`BuddySidebar.tsx`、头像 / 样式 / 模板、新建、对话头部、Timeline 与三类卡片、Composer、SidePanel 下的 Routines / Memory / Settings / Connect。
- API / hooks：buddies / mock、buddyResources、buddySessionConnection、chatSockets、useBuddies、useBuddySession、useBuddyComposer、useBuddyAgents、useBuddyResource、useBuddyBackSwipe。
- 共享页面：SettingsPage、AutomationPage / AutomationDialog 及抽取文件、MemoryPage 及抽取文件、FormPill / surveyAnswers、backgroundChatConnections。
- 对应 Vitest 测试与本记录。
