# Buddy 后端设计

Buddy 是全局常驻的 AI 队友：有名字、角色、独立 Memory，对用户只呈现一条对话。小事自己做，需要整段 Session 的工作委派给 subagent。能看到所有 Project / Task / Session，能建 Task、建 Session、给任意 Session 发消息，能给自己建 Routine，能被 IM Connect 直接绑定。

后端尽量复用现有模型：Buddy 本体是一个 `project_type = 'buddy'` 的 Project，Memory、Automation、chat history、ACP 生命周期都按 project 键自动隔离。

本计划按 2026-10-30 的 Rust 代码核对修订。仅实施后端，不修改前端或 `docs/design/buddy-frontend.md`。按用户最新授权，§10 各步连续完成实现、单测及指定检查，不再逐步暂停；不 commit、不 push。§11 的产品待确认项不因本次技术修订而被擅自定案。

## 1. 数据模型

### Project

- `ProjectType` 新增 `Buddy`，`as_str` → `"buddy"`，`FromStr` 识别 `"buddy"`。
- 目录 `~/.grove/buddies/<buddy_id>/`，无 git，形态同 Studio。
- 创建时复用 `tasks::ensure_local_task` 的 Local Task 构造逻辑，提供可加入创建事务的存储入口；所有 Buddy Segment 和轻委派 Session 都在这个 Task 下。
- `load_projects()`、`load_active_projects()`、`load_archived_projects()` 均排除 Buddy，保留各自原有的归档筛选语义。三者共享的查询实现负责过滤；TUI、Web 普通/归档项目列表、`grove mcp`、IM 普通项目选择因此均不展示 Buddy。
- 新增 `load_buddy_projects()` 用于 Buddy 发现，普通列表过滤不影响 `load_project_by_hash()` 和启动修复使用的 `load_project_hashes()`。
- 按 ID 访问与列表发现分开：`api/handlers/acp.rs::resolve_project_key()` 改为按 hash 查找，保证 Buddy 的历史、WebSocket、附件等接口仍可访问。逐个审查 `load_projects()` 的调用目的；用于项目发现的保留过滤，用于已知项目的运行时解析的改用按 ID 查询，不再承诺所有调用点不改。
- Buddy 目录使用真实绝对路径登记，并由 `project_directory()` 返回；不套用 Studio 的 `studio://` 虚拟路径及 `studios/<hash>/` 目录规则。注册时不进入 Repo worktree 或 Studio Local Task 的专用分支。

降级风险：旧版本二进制 `FromStr` 把未知值落到 `Repo`，降级后 Buddy 会以普通项目出现在列表里。数据不损坏，接受。

### 新表

```sql
CREATE TABLE IF NOT EXISTS buddies (
    id                TEXT PRIMARY KEY,
    project_hash      TEXT NOT NULL UNIQUE,   -- projects.hash
    custom_agent_id   TEXT NOT NULL,          -- custom_agent：duty / system_prompt / base_agent / agent_config / 兼容配置字段
    avatar            TEXT,
    description       TEXT NOT NULL DEFAULT '',
    active_session_id TEXT,                   -- 当前 Segment
    sort_position     INTEGER,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
);

-- 对话分段。一个 Segment = 一行 session，同一 Agent 下持续存活
CREATE TABLE IF NOT EXISTS buddy_segments (
    session_id  TEXT PRIMARY KEY REFERENCES session(session_id) ON DELETE CASCADE,
    buddy_id    TEXT NOT NULL REFERENCES buddies(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    agent       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    ended_at    TEXT,
    UNIQUE (buddy_id, seq)
);

-- 委派记录
CREATE TABLE IF NOT EXISTS buddy_delegations (
    id              TEXT PRIMARY KEY,
    buddy_id        TEXT NOT NULL REFERENCES buddies(id) ON DELETE CASCADE,
    from_session    TEXT NOT NULL,            -- 发起时的 Segment
    target_project  TEXT NOT NULL,
    target_task     TEXT NOT NULL,
    target_session  TEXT NOT NULL,
    title           TEXT NOT NULL,
    brief           TEXT NOT NULL,
    status          TEXT NOT NULL,            -- running | waiting | done | failed | cancelled
    last_result     TEXT,                     -- 最近一轮 assistant 文本，UTF-8 安全截断至 16KB
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    completed_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_buddy_delegations_buddy
    ON buddy_delegations(buddy_id, updated_at DESC);
```

### 现有表改动

| 表 | 改动 | 用途 |
|---|---|---|
| `automations` | `session_mode` 新增取值 `buddy_active` | Routine 投递到当前 Segment，换 Agent 不失效 |
| `connects` | 新增 `buddy_id TEXT` 可空 | IM 绑定 Buddy，投递时解析当前 Segment |
| `tasks` | 无 schema 改动，Buddy 建的 Task `created_by = 'buddy:<id>'` | 前端标记来源 |

Session 之间以 `buddy_segments` 区分：Buddy Local Task 下的 session，在 `buddy_segments` 里的是 Segment，不在的是轻委派 subagent。

迁移沿用 `database.rs` 的 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN` 模式。

### 原子创建与存储复用

当前 Project、Local Task、Custom Agent 的公共写函数分别获取全局 DB Mutex，部分函数自行提交事务或发布事件，不能在外层持锁后直接串联调用。为需要联合写入的操作抽出接收 `&Connection` / 事务的内部入口，原公共函数保留既有行为；不要复制一套校验和 SQL。

创建 Buddy 的同一数据库事务包含：Project、Local Task、必要的 Task Group 关联、Custom Agent、Buddy、首个 Session / Segment、Memory 整理 Automation、Memory 配置。`memory_project_configs.organization_automation_id` 是非空外键，整理 Automation 必须在创建阶段一起落库，不能留到 §10 第 5 步才插入。事务提交后再发布事件或启动 ACP；文件系统目录不属于 SQLite 事务，创建失败时只清理由本次操作新建且未被使用的目录，不碰已有目录。

## 2. Segment 生命周期

用户看到一条对话，底层是按时间排列的多个 Segment。

| 操作 | 行为 |
|---|---|
| 创建 Buddy | 建 Project + Local Task + 第一个 Segment（seq=1），`active_session_id` 指向它 |
| 换 model / mode / effort | 当前 Segment 内 ACP `set_mode` / configOptions 原地切，不开新 Segment |
| 换 Agent | 更新 `custom_agent.base_agent`；旧 Segment 写 `ended_at`、关闭 ACP handle；新建 session 行 + Segment（seq+1）；切 `active_session_id` |
| 上下文过长 | 依赖 Agent 自带 auto compact |

约束：

- 已结束的 Segment 只读，**不改 `acp_session_id`、不调 `clear_history`**。旧 Segment 的 `history.jsonl` 永久保留。
- 前端打开旧 Segment 不触发 ACP 连接；后端同样强制检查，不能仅依赖前端约定。只有 `active_session_id` 对应且未结束的 Segment 可以启动或 resume；轻委派 Session 不受这一 Segment 限制。
- 换 Agent 期间 Buddy 有进行中的 turn → 拒绝，返回 `buddy_busy`，前端提示先停止。

### 后端保护与换 Agent 编排

- 通用启动入口、WebSocket 启动、后台唤醒、消息投递和修改 Session 的入口都要识别 Segment 身份；结束 Segment 可读历史，但拒绝启动、发送及修改。存储层保护 `acp_session_id` 更新和 Session upsert，历史清理入口保护结束 Segment，防止绕过 Buddy REST 路由。
- 换 Agent 与新消息接纳需要按 Buddy 串行协调，不能只读取一次 `is_busy` 就开始切换。存在待发送队列、启动或未完成请求时，不能让旧 handle 在检查后再接收工作；无法安全切换时返回 `buddy_busy`。
- 停止旧 handle 并等待生命周期清理完成后，再以事务结束旧 Segment、更新 Buddy 专属 persona、新建 Session / Segment、切换 active 指针及同步 Memory 配置。切换过程不清历史、不重置旧 `acp_session_id`。失败不得留下半套数据库状态；旧 handle 已停止而事务失败时，旧 Segment 仍是可恢复的 active Segment。
- 旧 Segment 的 Agent 来源从 `buddy_segments.agent` 快照读取，不能随着可变 persona 的 `base_agent` 改写。普通 Custom Agent API 目前禁止修改仍被 Session 引用的 persona 的 base Agent；Buddy 使用专用编排，不移除普通 persona 的保护。
- 测试必须在调用换 Agent 前后分别读取旧 `history.jsonl`，断言字节数、完整字节内容及旧 `acp_session_id` 均不变；另测通用入口不能重新启动或改写结束 Segment。

### 交接

新 Segment 首条 bootstrap 里带前任信息，由新 Agent 自己按需读：

```
你接手了这个 Buddy 的对话。之前的 Segment：
- seq 1, agent claude-code, 2026-10-01 ~ 2026-10-28, session <id>
- seq 2, agent codex, 2026-10-28 ~ 2026-10-30, session <id>
用 buddy_read_session 读取前任聊天记录。最近 20 条消息如下：……
```

最近 N 条从上一个 Segment 的 `history.jsonl` 尾部取，只取 user / assistant 文本，跳过工具事件。N 默认 20。

## 3. Session 启动

ACP 启动链路复用现有 `AcpStartConfig`，Buddy Segment 有三处差异。

### MCP

`McpServerPolicy` 新增 `Buddy`：

| 注入项 | WorkingSession | Buddy |
|---|---|---|
| `grove`（stdio `grove mcp`） | 有 | 无 |
| `grove_agent`（loopback HTTP） | 有 | 无 |
| `grove_buddy`（loopback HTTP，新） | 无 | 有 |
| 插件 MCP、standalone MCP（用户自装，如邮箱、日历） | 有 | 有 |

Buddy 只挂自己的 server，避免和 `grove mcp` 的同名能力（建 Task、发消息）冲突。不支持 HTTP 的 Agent 走现有 `mcp-bridge --route buddy-mcp` stdio 桥。

当前 MCP 注入和插件注入都受 `WorkingSession` 分支控制，实施时分开这两类条件，让 Buddy 保留用户安装的 MCP。`run_acp_session()` 当前只要有 `chat_id` 就注册 Agent Graph token，也须改为按实际策略注册和注销：Segment 只注册 Buddy token，轻委派仍注册 working-session token。bridge 已接受通用 route，无需为 `buddy-mcp` 添加另一套桥接。

统一构造 Segment 的启动配置，WebSocket 和 `agent_graph::tools::ensure_target_handle()` 等后台唤醒路径均调用它；Routine、IM 经过这些入口时不能退回 `WorkingSession`。身份判断以 `buddy_segments` 成员关系为准，不能把 Buddy Project 下所有 Session 都当成 Segment。

### Instruction

`session_bootstrap_instruction` 新增 Buddy 分支，用 `BUDDY_INSTRUCTION` 替代 `WORKING_GROVE_INSTRUCTION`。要点：

- 你是用户的长期队友，Grove 里所有 Project / Task / Session 对你可见。
- 一两步能完成的事自己做（查邮件、看状态、回消息）；需要一整段 Session 的工作（大量读代码、长篇总结、改代码）用 `buddy_delegate` 委派，自己负责整合结果。
- 改代码必须委派到目标 Project 的 Task，不在 Buddy 目录下改别的仓库。
- 跨对话要记住的东西写进 Memory；重复性工作用 Routine。
- 有前任 Segment 时附交接段。

Persona（`custom_agent.system_prompt`）沿用现有 `PersonaInjection` 追加在后面。

### Agent 配置

Segment 用 Buddy 专属 `custom_agent`，权限沿用 Agent 自己的配置，不另设计。

- 对外 `role` 映射现有 `custom_agent.duty`，不新增重复的 role 存储列。
- REST 支持现有 `AgentConfigSelection` 结构的 `agent_config`；沿用已有优先级：`ConfigOptions` / `Modes` 为实际配置来源，`model / mode / effort` 仅是 `Default` 分支下的兼容字段，不承诺二者叠加。结构化配置启用时，不能把单独修改兼容字段报告成已改变运行时配置，应返回明确的输入错误并要求使用 `agent_config`。
- model / mode / effort 及结构化选项的有效修改应用到当前 Segment，不创建新 Segment；只使用 Agent 宣告的能力。持久化配置、当前运行时应用结果及 Memory 整理配置保持一致，不把失败的运行时修改报告为成功。
- 改 persona 文本的即时注入不在现有 `PersonaInjection` 能力内：它只在 fresh-create bootstrap 生效，resume 跳过。PATCH 保存文本，按现有生命周期在下一次 fresh-create 注入；若需要立即更新当前对话，须另行确认，不额外发送隐式用户消息。

## 4. `grove_buddy` MCP Server

新文件 `src/api/handlers/buddy_mcp.rs`，结构照抄 `memory_mcp.rs`：共享 loopback listener，路由 `/buddy-mcp/{token}`，独立 token map（token → `{buddy_id, session_id}`）、`ServerHandler`、tool router。Segment 启动时注册 token，结束时注销。

实际挂载位置是 `agent_graph_mcp.rs::build_router()`，同时挂尾斜杠变体；不得挂到 `api/mod.rs` 的公共 API router。工具调用除了校验 token，还要验证绑定 Session 仍是本 Buddy 的未结束 active Segment。

工具实现复用现有函数，不复制逻辑。

| 工具 | 说明 | 复用 |
|---|---|---|
| `buddy_list_projects` | 所有已注册 Project（不含 Buddy） | `workspace::load_projects` |
| `buddy_list_tasks` | 某 Project 下 active Task | `tasks::load_tasks` |
| `buddy_list_sessions` | 某 Task 下 Session，含状态（idle / running / waiting） | `tasks::load_chat_sessions` + ACP handle 状态 |
| `buddy_read_session` | 返回 session 元信息、`history.jsonl` 绝对路径、总行数；可选 `tail` 返回最近 N 条文本 | 参照 `memory_get_recent_chats` 的返回形态 |
| `buddy_create_task` | 在目标 Project 建 Task，`created_by = buddy:<id>`，可写 notes | Repo 用 `operations::tasks::create_task`，Studio 用 `create_studio_task`，notes 用现有存储接口 |
| `buddy_delegate` | 见 §5 | |
| `buddy_send` | 给可写 Session 发一条消息，sender 标为 Buddy；目标忙则排队；结束 Segment 拒绝写入 | 从 `agent_graph::tools::deliver_to_session` 抽出的共用投递与排队逻辑 |
| `buddy_delegations` | 列出本 Buddy 的委派及状态 | |
| `buddy_routine_create / list / update / delete / run` | 管理本 Buddy 的 Automation，`task_mode=existing`、`session_mode=buddy_active` | `storage::automations` |
| `memory_recall / read / append_log / get_related / get_recent_logs` | 作用域为 Buddy 的 project | `agent_graph_mcp.rs` 现有实现，按 caller project 解析 |
| `ask_form`、`speak` | 同 working session | `agent_graph_mcp.rs` |
| `browser_*` | 同 working session | `agent_graph_mcp.rs` |
| `set_title` | 不提供；Buddy 名字由用户定 | |

`agent_graph_mcp.rs` 里 memory / ask_form / speak / browser 工具的实现抽成以可信 `{project, task, chat}` 为上下文的自由函数，两个 server 各自解析身份后包装。browser 原有全局开关、Memory 的 project 开关及作用域校验保持不变；不要让共用函数依赖 `/mcp/{token}` URL。

当前 `deliver_to_session` 是私有函数，内置 Agent Graph envelope 和 `agent:<chat_id>` sender。把投递、busy 原子接纳、队列、ActivityGuard 和配置应用抽为共用能力，由各调用方提供可信 sender / envelope；Graph 的上层同 project / task、edge、pending-message 校验及返回契约保持原样。Buddy 不创建 Graph edge 或 pending ticket，不新增或修改 `grove_complete_task`。

## 5. 委派

`buddy_delegate` 入参：

```jsonc
{
  "title": "Summarize auth module",
  "brief": "……",
  "target": { "kind": "self" }                                   // 轻委派
         | { "kind": "task", "project": "<hash>", "task": "<id>" } // 已有 Task
         | { "kind": "new_task", "project": "<hash>", "name": "…", "notes": "…" } // 新建 Task
}
```

| 类型 | Session 位置 | 用途 |
|---|---|---|
| `self` | Buddy Local Task 下新 session（不进 `buddy_segments`）；需要读某项目时通过 `task_linked_projects` 挂目录 | 调研、读代码、总结 |
| `task` / `new_task` | 目标 Project 的 Task 下新 session | 改代码、需要 worktree 的工作 |

Subagent 配置：复用 Buddy 的 base_agent 和按 §3 优先级解析的运行时配置，**不注入 Buddy 的 persona system_prompt**，subagent 是普通 working session（挂 `grove` + `grove_agent`），只接收委派 brief 和所需工作上下文。不通过直接引用 Buddy persona 来继承配置，以免带入 persona 文本或随之后换 Agent 改写已有 subagent 的来源。

`task_linked_projects` 是 Task 级关联，不是 Session 级沙箱：轻委派与 Segment 共用 Local Task 时，新增关联也会影响该 Task 下其他 Session 后续的启动。沿用这个现有作用域，不把它描述为轻委派的独占挂载或权限边界。

### 结果回传

不改 Agent Graph 的同 task 校验。改为 Buddy 侧监听：

1. 先建立 Session 和委派记录，准备目标 handle，**在发送 brief 前订阅** `AcpUpdate` 并建立 watcher。不能按“先发消息再订阅”实现；这是现有 executor 避免漏掉快速完成事件的顺序。准备或投递失败时将委派置 failed，不能留下虚假的 running 记录。
2. watcher 通过投递消息身份识别自己跟踪的 turn，不能把之前的 turn、启动事件或其他排队消息的完成当成当前委派结果。参照 executor 累积当前 turn 的 `MessageChunk`，使用现有 UTF-8 安全的 16KB 截断函数；不直接访问私有 `last_assistant_text`。
3. 状态规则：
   - 已开始的 turn 在无错误、无未解决用户输入等待时收到 `Complete` → 写 `last_result`，status=done，并投递结果。
   - 权限、elicitation、`ask_form` 或认证等待 → status=waiting，投递等待通知。`ask_form` 会立即返回并让 turn 正常结束，所以 **`AskForm → Complete` 仍保持 waiting**，不得误报 done。
   - 收到对应响应或后续用户输入后恢复 running；新一轮清空文本累积。错误 / 断开置 failed，取消置 cancelled；晚到的 Complete 不覆盖失败或取消。
4. 投递内容带 `<grove-meta>`（delegation_id、target_session、status），供前端消费，本任务不实现前端卡片。每次投递重新解析 Buddy 当前 Segment，并与换 Agent 的接纳锁协调；Buddy 忙时走共用队列。
   - 等待中的审批 / 提问由前端订阅目标 session（现有 history 与 WebSocket 会回放当前待处理请求）后在 Buddy 对话里渲染与响应，后端不附带请求快照、不新增接口。
5. Buddy 后续 `buddy_send` 给同一 subagent 追加指令时，在投递前准备该轮监听和状态转换，成功接纳后跟踪新一轮结果；失败不能把旧 done 记录永久改成 running。去重、取消和通知使用条件更新，避免重复 Complete 重复回传。

### 重启恢复边界

watcher 在内存，委派状态在数据库。按用户确认，沿用 Agent Graph 的简化边界：重启不扫描恢复 watcher，不自动标 failed、不恢复 Agent、不重发 brief，也不新增等待原因持久化。保留最后一次观测的状态，由用户或 Buddy 查看目标 Session 后显式继续或取消；该状态不表示重启后 Agent 仍在运行。后续显式 `buddy_send` 会为新一轮重新订阅。

和上一版讨论的差异：之前计划放开 Agent Graph 跨 task 限制让 subagent 主动 `graph_reply`。改为 watcher 后不碰 Agent Graph 现有校验，subagent 也不需要配合协议，按 turn 完成自动回传。

## 6. Routine 与 Memory 整理

- Routine = `automations` 行，`project = buddy project`，`task_mode=existing`（Local Task），`session_mode=buddy_active`。`executor::resolve_chat` 新增分支：查 `buddies.active_session_id`。Routine 触发等于"Buddy 给自己发一条消息"。
- `TargetMode` 枚举新增 `BuddyActive`，显式序列化 `buddy_active`（当前 `rename_all = "lowercase"` 不会自动生成下划线）。同步修改存储解析、executor 及 HTTP API 的转换/校验；它仅用于 `session_mode`，`task_mode=buddy_active` 应拒绝。
- 创建 Buddy 时写 `memory_project_configs` 开启 Memory，整理用的 Automation `agent_config` 取 Buddy 的配置。
- Buddy 修改 Agent 配置时同步更新整理 Automation 的 `agent_config`。
- Memory 配置和整理 Automation 在第 2 步原子创建；第 5 步完成 Routine 工具、动态 active Segment 解析、配置同步及端到端整理验证。普通 Automation API 仍不允许用户直接修改 system-managed 的 Memory 整理 Automation。

## 7. IM Connect

- `connects.buddy_id` 非空时，统一解析 Buddy 目标，投递前动态取得 `active_session_id`；`project_id` / `task_id` 填 Buddy 的值以兼容现有校验。`create_session()` 当前会重新读取持久化 Connect，不能只修改入参副本，否则仍会取回旧 Segment。
- IM 里的"新会话"命令（`start_new_session`）对 Buddy 绑定返回提示"Buddy 只有一条对话"，不建 session。
- 创建 Connect 的 API 接受 `target: { kind: "buddy", buddy_id }`，保留现有扁平 project/task/session 输入的兼容路径。目标归一化需进入 `connect/service.rs` 校验流程，并同步 handler、注册完成流程中的 `ConnectInput` 构造。
- 检查 `storage/connects.rs` 的 stale-session 读时修复，Buddy 绑定不能降级为 Auto New。ensure、权限/表单响应、配置和取消等使用目标 Session 的路径同样要检查；已有请求按原始消息绑定处理，不能把旧请求错误转发给新 Segment。

## 8. HTTP API

新文件 `src/api/handlers/buddies.rs`，挂在 `/api/v1/buddies`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/buddies` | 列表：id、name、avatar、description、agent、status（working / waiting / idle）、last_message_preview、last_activity_at、active_session_id |
| POST | `/buddies` | 创建：name、avatar、description、role、system_prompt、agent、agent_config、兼容 model/mode/effort。按 §1 原子完成创建 |
| GET | `/buddies/{id}` | 详情 + segments 列表 |
| PATCH | `/buddies/{id}` | 改名字、头像、描述、role、system_prompt、agent_config、兼容 model/mode/effort；按 §3 配置优先级，不换 Agent |
| POST | `/buddies/{id}/agent` | 换 Agent，开新 Segment；忙时 409 `buddy_busy` |
| DELETE | `/buddies/{id}` | 仅归档：`projects.archived = 1`，保留数据，不提供硬删 |
| GET | `/buddies/{id}/delegations` | 委派列表 || POST | `/buddies/{id}/delegations/{did}/cancel` | 取消委派，对目标 session 发 cancel |
| PATCH | `/buddies/order` | 列表排序 |

对话消息、流式更新、历史加载、附件、权限响应复用现有 session 级 API 与 WebSocket，但必须完成 §1 的按 ID 项目解析和 §2 的 Segment 保护，不能原样接入。Routine 复用 `/api/v1/projects/{id}/automations`（手动执行为 `/{aid}/trigger`），扩展其模式校验；Memory 复用现有 project-scoped `/memory` API。前端逐段加载方式由前端任务实施。

`last_message_preview` 和 `status` 由 `active_session_id` 的 ACP handle 状态与 history 尾部计算，结果缓存，ACP 事件到达时失效。

## 9. 改动文件

下表包含已核对的主要改动范围。模块声明、枚举穷尽匹配及测试夹具的必要配套修改并入对应步骤；遇到新的行为差异仍先汇报，不据此扩大产品设计。

| 文件 | 改动 |
|---|---|
| `src/storage/workspace.rs` | `ProjectType::Buddy`；三个普通项目列表入口过滤；Buddy 列表、目录解析、参与事务的 Project 写入 |
| `src/storage/database.rs` | 新表、`connects.buddy_id` 迁移 |
| `src/storage/buddies.rs`（新） | buddies / segments / delegations CRUD、身份查询、条件状态更新及归档 |
| `src/storage/tasks.rs` | 复用 Local Task / Session 写入逻辑的事务入口；结束 Segment 的 ID 和 Session 修改保护 |
| `src/storage/chat_history.rs` | 结束 Segment 的历史清理/改写保护；复用历史读取；不改变普通 Session 行为 |
| `src/storage/custom_agent.rs` | 可参与 Buddy 事务的 persona 写入；保持普通 API 规则 |
| `src/storage/memory.rs` | Memory 配置和整理 Automation 联合写入的事务复用 |
| `src/storage/automations.rs` | `TargetMode::BuddyActive` 序列化/存储解析；复用已有事务写入与文本截断 |
| `src/automation/executor.rs` | `resolve_chat` 的 BuddyActive 分支及与切换协调的投递；禁止无效 task_mode |
| `src/api/handlers/automations.rs` | DTO、模式解析、目标校验和 Routine API 复用 |
| `src/acp/mod.rs` | `McpServerPolicy::Buddy`；bootstrap/交接；按策略注册 token；公共启动保护和 handle 清理协调 |
| `src/api/handlers/acp.rs` | 按 ID 解析项目；WebSocket 启动使用 Buddy 配置；结束 Segment 的写操作限制 |
| `src/agent_graph/tools.rs` | 抽取可参数化的投递能力、后台唤醒的 Buddy 配置；不改 Graph 同 task 校验 |
| `src/api/handlers/buddy_mcp.rs`（新） | `grove_buddy` MCP server、身份/token 绑定、工具包装 |
| `src/api/handlers/agent_graph_mcp.rs` | loopback router 挂载 Buddy MCP；memory / ask_form / speak / browser 共用实现 |
| `src/api/handlers/buddies.rs`（新） | REST API |
| `src/api/mod.rs` | `/api/v1/buddies` REST 路由；不挂 loopback MCP 路由 |
| `src/buddy/`（新） | 创建 / 换 Agent / Segment 编排、统一启动配置、委派 watcher |
| `src/connect/grove.rs`、`src/storage/connects.rs` | 动态 Buddy 目标、stale-session 修复、禁止 Auto New |
| `src/connect/service.rs`、`src/api/handlers/connects.rs` | Buddy target 输入归一化、校验及 ConnectInput 构造适配 |
| `src/main.rs`、`src/storage/mod.rs`、`src/api/handlers/mod.rs` | 对应新增模块声明 |

额外只读参考：`src/operations/tasks.rs`（Repo/Studio 两种建 Task）、`src/grove.rs`（IM 的 Session 边界）、`src/cli/mcp_bridge.rs`（通用 route）、`src/api/handlers/custom_agent.rs`（persona 使用中保护）、`src/api/handlers/memory_mcp.rs`（server 与 schema 测试）。如复用要求改动这些文件，列入该步汇报，不改 `grove_complete_task`。

## 10. 实现顺序

保持原七步顺序。每步可独立编译和单测，但不把尚未完成的后续功能报告成已可用。

### 第 1 步：存储和项目发现

- 新增 ProjectType、三张表、Connect 列迁移、`storage/buddies.rs`；实现 Buddy / Segment / delegation 的基本存取及仅归档操作。
- 普通项目三个列表入口均过滤 Buddy；Buddy 专用列表与按 ID 查询分开；维护 hash、真实目录、归档状态的对应关系。同步必要的 Rust 枚举匹配。
- 将已确认依赖列表发现的聊天项目解析改为按 ID 查询，使第一步过滤本身不破坏后续复用；其他调用点按发现/身份解析用途逐项判断。
- 测试：新库建表、旧库升级和重复迁移；唯一键/外键；CRUD 和排序；Repo/Studio 列表行为保持；普通/归档列表均无 Buddy；按 ID 可读 Buddy；归档不删除 Session、历史及关联记录。

### 第 2 步：原子创建与 Segment 生命周期

- 抽出必要的事务写入入口，原子创建完整 Buddy，包括 Memory 配置和其外键引用的整理 Automation；失败回滚及事件发布顺序可测。
- 实现忙时拒绝、换 Agent、结束 Segment 的存储/运行时保护、统一启动配置、bootstrap 与交接。保持普通 persona API 的限制。
- 实现 `McpServerPolicy::Buddy` 与 token 生命周期。为本步可编译和可测，先建立 Buddy MCP transport / 身份校验骨架及 loopback 挂载；第 3 步再填工具。骨架不是已完成的 Buddy MCP 能力，不向 Agent 暴露未实现工具。
- 测试：首个 Segment 和 active 指针；切换后 seq 递增；旧 history **文件字节数、内容和 acp_session_id 不变**；旧 Segment 无法通过通用启动/写入入口复活；busy/队列与切换竞态；失败不产生半套记录；WebSocket/后台配置一致；轻委派仍用 WorkingSession；MCP 集合、token 注销和交接文本正确。

### 第 3 步：Buddy MCP 基础工具

- 顺序为只读工具 → 建 Task / 发送工具 → memory / ask_form / speak / browser 共用实现。Repo/Studio 分别调用现有建 Task 路径。
- 抽取底层投递，维持 Graph 上层原有同 task、edge、pending-message 语义；补跨 Task Buddy 投递及忙时排队测试。
- `buddy_delegate` / 委派管理和 Routine 工具分别在第 4、5 步接入，不在本步发布会返回“未实现”的工具。
- 测试参照 `agent_graph/tools.rs` 的隔离 DB 与 mock handle、`memory_mcp.rs` 的 schema/身份测试：非法或过期 token、已结束 caller、跨项目只读、history tail/行数、工具作用域、sender 与元数据、无 persona 泄漏、原 Graph 跨 task 请求仍被拒绝。
- §11 第 2、3 项在对应工具处保留 TODO，不实现前端展示或额外访问限制。

### 第 4 步：委派与 watcher

- 重启按 §5 已确认的简化机制：保留记录，等待显式继续或取消，不自动恢复或改状态。
- 接入三类 target、无 Buddy persona 的 subagent 配置、先持久化/订阅再发送、按 turn 关联、结果回传、后续轮次、取消与恢复。
- 用模拟 `AcpUpdate` 流覆盖 running → done / waiting / failed / cancelled；特别覆盖快速 Complete、AskForm → Complete 保持 waiting、后续响应恢复、重复/晚到事件、投递失败、Buddy 换 Agent 后回传到新 Segment、16KB 多字节截断以及已确认的恢复策略。

### 第 5 步：Routine 与 Memory 整理

- 完成 `BuddyActive` 的存储/JSON/HTTP/executor 全链路；仅允许本 Buddy Project 的 Local Task，投递时解析当前 Segment，并与切换协调。
- 接入 Routine MCP CRUD/run；复用现有调度和用户管理 Automation 规则，不能借 Routine API 操作其他 Buddy 或 Memory 系统任务。
- 在第 2 步创建基础上完成配置修改同步及 Memory 整理集成；结构化配置优先级与 Segment 相同。
- 测试：新 Agent 后 Routine 仍命中新 Segment；并发切换不投旧 Segment；无效 task_mode/跨 Buddy 目标拒绝；Memory 始终按 project 隔离；配置同步和失败处理。

### 第 6 步：IM Connect

- 接入 target 解析和兼容输入，校验/注册完成/存储读取/实际投递均使用同一绑定语义；保留 `grove.rs` 集成边界。
- Buddy 绑定禁止新会话与 Auto New；检查权限、表单、配置及取消路径的目标，避免仅修复普通文本投递。
- 测试：创建/更新/重读绑定；换 Agent 后新消息投新 Segment；旧请求不会误投；stale-session 修复不新建 Buddy Session；普通 Connect 行为保持。

### 第 7 步：REST

- 接入 Buddy REST、仅归档 DELETE、列表排序、状态/预览缓存及事件失效；HTTP 层调用前面已测的编排，不重复业务逻辑。
- Buddy 不是 `web.interface` 的取值，入口由前端在 Workbench / Orbit 内提供；`web.interface` 只接受 `workbench` / `orbit`。不修改前端。复核复用的历史、消息、附件、权限与 Routine/Memory HTTP 路由。
- 测试：API 输入及错误码、busy 409、配置优先级、归档保留数据、排序、缓存失效、历史读取不启动旧 Segment、普通项目/Session 接口回归。

### 第 8 步：Compact 队列按 sender 分组

Buddy 前端把当前 Segment 设为 `QueueMode::Compact`，忙时用户消息排队后合并发送；同时前端按 `sender` 隐藏非用户 prompt（Routine、委派通知、其他 agent）。现有 Compact 把整个队列合成一条并取第一条的 sender，用户消息与 Routine prompt 混合时会被错误隐藏或错误归属。

- `pop_queue_for_auto_send` 的 Compact 分支只合并队首起连续、`sender` 相同的消息，其余留在队列等下一次出队。
- 对所有使用 Compact 的 session 生效（TaskChat 同样受益），Separate 模式不变。
- 测试：同 sender 连续消息合并为一条；用户消息与 `automation:*` / `buddy:*` 消息交错时按 sender 分批出队且各自保留 sender；单条消息行为不变。

### 每步检查与汇报

单测使用既有隔离数据库和 mock handle，避免修改用户真实 `~/.grove` 数据或启动真实外部 Agent；涉及数据库全局状态的测试遵守现有 `test_lock()` 约定。新增 shell 调用一律通过 `src/git`、`src/tmux` 的封装。

每步完成实现和测试后运行：

```sh
cargo fmt --all -- --check
cargo clippy -- -D warnings
cargo test
```

格式或实现检查失败须修复后重新验证，不能以部分测试替代指定全量检查。缺工具、环境导致命令无法运行时停下来询问，不自找替代方案；文件路径不存在可自行搜索定位。

汇报改动文件、测试结果、与本计划的偏差及构建状态，按最新授权继续下一步。Rust 变更注明后端需重建；前端未改时注明前端构建未运行/无需因该步重建。不自动 commit 或 push。

## 11. 待确认

1. **删除 Buddy**：本次用户已明确只实现归档（`projects.archived = 1`，数据保留）。硬删不实施。现有 Project 归档只更新项目行，不自动暂停 Automation 或 Connect；不得自行将“归档”扩展成停止/解绑全部资源，若产品需要该行为再确认。
2. **轻委派的 subagent session 在哪展示**：侧边面板还是同时在对话流展示仍待确认，不在本后端任务中决定。原文没有指定新的过滤默认值；本次保留 §4 的按 Task 列出 Session 语义，不额外引入轻委派过滤，并在 `buddy_list_sessions` 留 TODO。这个兼容行为不代表前端展示方案已定案。
3. **`buddy_read_session` 读私有内容**：保持 MVP 可读取任意 Session 完整记录的默认行为，包括用户与其他 Agent 的对话；不新增 Project 授权限制，在工具入口留 TODO，后续再决定权限模型。

§5 的重启边界已按用户最新回复确认采用简化机制，不新增自动恢复或失败标记。
