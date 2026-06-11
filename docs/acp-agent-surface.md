# ACP Agent 接入面梳理

> 审计文档，不动代码。改任何 agent 相关的逻辑前先看。
>
> 范围：Grove 里所有描述 ACP 编程 agent 的位置——身份、安装状态、可用性探测、启动命令、marketplace 列表、选择器 UI、new/resume/fork/delete 生命周期、状态广播、终端模式变体。
>
> **新设计见 §8**——统一 catalog + 唯一 API。§0–§7 列出的是当前仓库里散落各处的"事实状态"，§8 给出收敛方案。

---

## 0. 现状速览（drift 警告）

**当前实现下，agent 身份至少被 6 份独立数据源维护**，互相漂移：

| 源 | 文件 | 作用 |
|---|---|---|
| 后端静态 catalog | `src/storage/agent_supplement.rs::BUILTIN_SUPPLEMENTS` | 13 条；补 registry 没覆盖的字段 |
| 后端 dynamic catalog | `src/acp/mod.rs::BUILTIN_ACP_AGENTS` | 11 条硬编码 id，跟 supplement 数量不一致 |
| 后端 if-else 表 | `src/acp/mod.rs::builtin_acp_unavailable_reason` + `resolve_agent` | 11 个手写分支 |
| 后端 priority list | `src/acp/mod.rs::TERMINAL_AGENT_PRIORITY` | 终端模式遍历顺序 |
| 前端静态 catalog | `grove-web/src/data/agents.ts::agentOptions` | 13 条；浏览器里所有探测的门控源 |
| 前端 if-else 规则 | `grove-web/src/data/agents.ts::applyAcpAvailability` | traecli 这类特例字段填充 |

**结果：** traecli 同时是 builtin agent、supplement 项、前端 catalog 项、`ACP_AGENT_COMMANDS` 白名单项、4 个手写 if-else 分支的对象。改一处会漏改其他 5 处。详见 §5。

**§8 给出统一方案**——把这 6 份收成 1 份 schema + 1 个 API。

**后端运行时数据（不动）：**

| 存储 | 文件 | 内容 |
|---|---|---|
| `installed_agents` 表 | `src/storage/installed_agents.rs` (SQLite) | 每个 agent 的安装记录：`id, version, install_method, install_path, status, failure_reason, args_override, env_override, launch_mode, hidden, …` |
| `custom_agent` 表 (Persona) | `src/storage/custom_agent.rs` | 用户自定义 agent 角色——`id, name, base_agent, model, mode, effort, system_prompt` |
| `chat_session` 表 | `src/storage/tasks.rs` | `id, title, agent (legacy id), acp_session_id, …` |
| `Config.acp.custom_agents` | `src/storage/config.rs` (TOML) | 远程/自定义 binary server |

---

## 1. 后端 — 启动与 session 生命周期

### 1.1 启动器 `acp::resolve_agent`

`src/acp/mod.rs:5184-5371`

`pub fn resolve_agent(agent_name) -> Option<ResolvedAgent>` 返回 `{ agent_type, agent_name, command, args, url, auth_header }`。**每个内置分支是手写的**——这是 §8 要收口的地方。

| canonical | 可用性规则 (`builtin_acp_unavailable_reason` line 5132) | 启动命令 |
|---|---|---|
| `claude` | `claude` AND (`claude-agent-acp` OR `claude-code-acp` OR `npx`) | `claude-agent-acp`（或 `claude-code-acp`，或 `npx -y @agentclientprotocol/claude-agent-acp`） |
| `codex` | `codex` AND (`codex-acp` OR `npx`) | `codex-acp` 或 `npx -y @zed-industries/codex-acp` |
| `cursor` | `cursor-agent` OR `agent` | `cursor-agent` |
| `gemini` | `gemini` | `gemini --experimental-acp` |
| `copilot` | `copilot` | `copilot` |
| `junie` | `junie` | `junie` |
| `kimi` | `kimi` | `kimi acp` |
| `opencode` | `opencode` | `opencode acp` |
| `qwen` | `qwen` | `qwen --experimental-acp` |
| `traecli` | `traex` OR `traecli` | `traex` 在 PATH 走 `traex`，否则 `traecli`，参数 `acp serve` |
| `hermes` | `hermes` | `hermes acp` |

### 1.2 Session 生命周期

`src/acp/mod.rs`

| 入口 | 行号 | 说明 |
|---|---|---|
| `get_or_start_session` | 1765-2032 | 中央启动入口。`STARTING_SESSIONS` set 串行化同 key 的并发启动。spawn `std::thread` 跑 `tokio::runtime::Builder::new_current_thread()` + `LocalSet` 托管 ACP `Client` |
| `run_acp_session` | 2033-2320 | npx 启动预热 npm 缓存（1.5s 阈值发 `AcpUpdate::ConnectPhase { phase: "downloading" }`）。`crate::check::resolve_program` 找 binary。`tokio::process::Command` spawn。接 `acp::Client` builder 装通知 handler |
| `drive_session` | 2325-3531 | 主循环。提 `available_modes` / `available_models` / `available_thought_levels`。`AuthRequired (-32000)` 重试。`ForkSession` / `DeleteSession` RPC 分发。resume 走 `LoadSession`。claude-agent-acp ≥ 0.40 走 `set_session_model` / `set_session_config_option`。提示队列消费 |
| `connect_remote_agent` | 3532-3614 | 远程 ACP（WebSocket，token 鉴权） |
| `AcpSessionHandle` impl | 3618-4433 | `derive_node_status`（`permission_required` / `busy` / `idle`）、`fork_session`、`delete_session`、`emit`（多数 update 落 `session.json`） |
| `kill_session` | 4678-4689 | 给 cmd loop 发 `AcpCommand::Kill` |
| `chat_dir` / `sock_path` / `session_json_path` | 4697-4725 | `~/.grove/projects/<key>/tasks/<task>/chats/<chat>`、`/tmp/grove-acp/<hash>.sock`、`<chat>/session.json` |
| `read_session_metadata` / `write_session_metadata` | 4728-4765 | 原子 tmp+rename |
| `run_socket_listener` / `handle_socket_connection` / `dispatch_socket_command` | 4774-4893 | 多进程 session 归属的 WS 代理 |
| `discover_session` / `send_socket_command` | 4894-4983 | 进程内 HashMap 查不到就探 `/tmp/grove-acp/<hash>.sock` |

### 1.3 其他 agent 相关文件

| 文件 | 用途 |
|---|---|
| `src/acp/adapter.rs` | 每 agent 内容适配器（`ClaudeAdapter`、`DefaultAdapter`）。`resolve_adapter(agent_name, agent_command)` 按 binary 名挑 |
| `src/api/handlers/agent_pty.rs` | 终端模式 WS handler。clamp cols/rows。要求 `chat.launch_mode == "terminal"`。尊重 `args_override` + `env_override`。每 chat 写 `~/.grove/agents-tmp/<chat_id>/mcp.json` 给 `--mcp-config` 用。`--session-id <uuid>`（新开）或 `--resume <uuid>`（续） |

---

## 2. 后端 — 探测 & 安装状态

### 2.1 `list_base_agents`

`src/api/handlers/agents.rs:29-42` `GET /api/v1/agents/base`

返回 `BaseAgentDto { id, display_name, icon_id, available, unavailable_reason }`。调 `crate::acp::base_acp_agent_statuses()` → 11 个 `BUILTIN_ACP_AGENTS` 各跑一遍 `builtin_acp_unavailable_reason`。**每次调用都重新探测 PATH，不缓存。**

§8 把它**收进** marketplace API，前端不再单独调它。

### 2.2 `list_marketplace`

`src/api/handlers/marketplace.rs:159-234` `GET /api/v1/agents/marketplace`

缓存优先读；缓存空时尝试一次同步刷新。Pass 1 走 `BUILTIN_SUPPLEMENTS`，Pass 2 走未匹配的 registry 项。每个 agent 算：

| 字段 | 算 |
|---|---|
| `install_state` | `compute_install_state` — `grove-managed` 优先，否则探测。规则：`terminal_check 在 PATH AND (acp_check OR acp_fallback OR npx-with-package) → "auto-detected"`，否则 `"not-installed"` |
| `binary` | `resolve_binary_for_supplement` — 从 `[acp_check, acp_fallback, terminal_check]` 选第一个在 PATH 的，调 `probe_binary` 拿绝对路径 + `--version` |
| `version`（顶层） | 上游 registry 的版本 |

§8 改成"纯数据 merge"，见 §8.3。

### 2.3 `check_commands`

`src/api/handlers/env.rs:234-251` `POST /api/v1/env/check-commands`

任意命令列表 → `HashMap<String, bool>`。`ACP_AGENT_COMMANDS` 白名单（`claude-agent-acp, claude-code-acp, codex-acp, npx, gemini, copilot, opencode, qwen, kimi, traecli, traex, cursor-agent, agent, junie`）。

§8 删掉。探测逻辑走 marketplace API。

### 2.4 `installed_agents` 表

`src/storage/installed_agents.rs`

| 列 | 含义 |
|---|---|
| `id` | canonical agent id |
| `version` | registry 的 semver |
| `install_method` | `Npx` / `Binary` / `Uvx` / `External` |
| `install_path` | 装好的 binary 绝对路径（或 `npx -y <pkg>@<ver>`） |
| `status` | `Installing` / `Installed` / `Failed` |
| `failure_reason` | 安装失败原因 |
| `args_override` | JSON 数组，追加到 spawn args |
| `env_override` | JSON map，合并到 spawn env |
| `launch_mode` | `acp` / `terminal` — 覆盖全局 `Config.agent_launch_modes[id]` |
| `hidden` | 用户主动从选择器移除时置 true |
| `installed_at`, `updated_at` | RFC3339 |

`spawn_for(rec, supplement)`（line 265）把记录翻译回 `(command, args)`。`Npx`/`Uvx` → pin 版本。`Binary` → 用 `install_path`，带磁盘存在性兜底。`External` → `None`（调用方退到 `acp::resolve_agent`）。

§8 把 `spawn_for` 里的 supplement 引用去掉，改成从 `RegistryAgent.distribution` 派生。

### 2.5 Marketplace install / uninstall / patch

`src/api/handlers/marketplace.rs`

| 端点 | 行号 | 说明 |
|---|---|---|
| `POST /api/v1/agents/marketplace/{id}/install` | 648-672 | 选 `InstallMethod`（默认 `npx > binary > uvx`） |
| `install_binary` | 696-782 | 写 `installing` 行，下载解压，`sanitize_extract_path` 验 `target.cmd` 防 zip-slip，更新到 `Installed` |
| `install_npx` / `install_uvx` | 788-858 | PATH 预检，写 `Installed` 行 + pin 版本 |
| `DELETE /api/v1/agents/marketplace/{id}/install` | 861-905 | `Binary` 安装算 `install_dir(id, version)`，不在 `~/.grove/agents/` 下直接拒 |
| `PATCH /api/v1/agents/marketplace/{id}` | 920-959 | 拒 `launch_mode ∉ {acp, terminal}`；拒不在 `supp.supported_launch_modes` 里的 launch_mode；委托 `installed_agents::patch_or_create` |
| `POST /api/v1/agents/marketplace/refresh` | 237-246 | 手动重抓 CDN，错误透传 |

§8 把 `supported_launch_modes` 移到 `RegistryAgent`（registry 上游提供，或本地 Trae/TraeX JSON 里）。

---

## 3. 前端 — catalog & 类型

### 3.1 `agentOptions`（静态，浏览器侧）

`grove-web/src/data/agents.ts:50-64` 13 条硬编码。

```
{ id, label, value, icon, terminalCheck, acpCheck, acpFallback?, npxPackage?, supportedLaunchModes? }
```

同文件两个 helper：

- `getAcpAvailabilityCommands(options)` line 66 — 收集要探测的命令名（去重）
- `applyAcpAvailability(opt, availability, loaded)` line 78 — 选项级门控

**§8 把这份 catalog 整个删掉**。前端用 marketplace API 拿数据。

### 3.2 `listBaseAgents`（服务端驱动）

`grove-web/src/api/agents.ts:17` `GET /api/v1/agents/base`

`useACPAvailability.ts`、`App.tsx`、`SettingsPage.tsx`、`TaskChat.tsx` 在用。

§8 把这个端点删掉。

### 3.3 `MarketplaceAgent`（CDN 合并视图）

`grove-web/src/api/marketplace.ts:72-94`

§8 之后，`MarketplaceAgent` 跟 `RegistryAgent` 字段**完全对齐**——前端再也不用自己 merge。

### 3.4 图标 & 颜色

| 文件 | 用途 |
|---|---|
| `grove-web/src/components/ui/AgentIcons.tsx` | 13 个 React 图标组件（`Claude`/`Codex`/`Cursor`/`Trae`/`Qwen`/`Kimi`/`OpenAI`/`Junie`/`OpenCode`/`OpenClaw`/`Hermes`/`Kiro`/`Gemini`/`Copilot`） |
| `grove-web/src/utils/agentIcon.ts` | 按 `canonicalKey`/legacy alias 查图标 |
| `grove-web/src/components/Skills/AgentIcon.tsx` | Skills 页 agent 过滤器用（不同关注点） |
| `grove-web/src/components/Stats/agentColors.ts` | 统计图色（如 `traecli: "#16a34a"`） |

§8 之后，icon_id 来自 `RegistryAgent`（本地 Trae/TraeX JSON 也带 `icon` 字段），前端按 id 查 asset。

---

## 4. 前端 — 接入面

### 4.1 选择器 / 可用性

| 文件 | 行号 | 说明 |
|---|---|---|
| `grove-web/src/components/ui/AgentPicker.tsx` | — | 通用选择器。`displayOptions = externalOptions ?? agentOptions` |
| `grove-web/src/components/Tasks/TaskView/TaskGraph.tsx` | 276-300 | mount 时 `checkCommands(getAcpAvailabilityCommands())`，再 `applyAcpAvailability` 门控 |
| `grove-web/src/components/Tasks/TaskView/useACPAvailability.ts` | 32-93 | mount 时 `listBaseAgents` + `getConfig` + `loadCustomAgentPersonas` |
| `grove-web/src/components/Config/SettingsPage.tsx` | 580-613 | 两条路：本地 `checkCommands` + 服务端 `listBaseAgents` |
| `grove-web/src/components/Tray/TrayPopover.tsx` | 127-132 | 按 `terminalCheck` / `acpCheck`（小写）查 agent 拿图标 |
| `grove-web/src/App.tsx` | 429-465 | 启动探测：挑第一个 available 当默认 |

§8 之后，所有探测走 marketplace。`useACPAvailability` / `applyAcpAvailability` 删掉。

### 4.2 Marketplace 弹窗

`grove-web/src/components/Config/MarketplaceModal.tsx`

- `installStateLabel(agent)` line 400 — `"Detected on PATH"` / `"Installed via <method>"` / `"Installing…"` / `"Install failed"` / `"Bring your own"` / `"Available"`
- `AgentDetail` line 426 — 右侧详情

### 4.3 聊天 / 4.4 Automation / 4.5 Graph toolbar / 4.6 Skills / 4.7 keyboard / 4.8 tray

都从 agent catalog 读 id。§8 之后统一从 marketplace 读，**前端不维护任何 agent 静态表**。

---

## 5. 当前漂移（写在新方案前，便于对比）

### 5.1 "grove 实际启动哪个 binary" — 4 种实现

| 路径 | 逻辑 | 位置 |
|---|---|---|
| `acp::resolve_agent` | 11 个手写 if-else 分支 | `src/acp/mod.rs:5184-5371` |
| `marketplace::resolve_binary_for_supplement` | 走 `[acp_check, acp_fallback, terminal_check]` | `src/api/handlers/marketplace.rs:391-420` |
| 前端 `applyAcpAvailability` | 看 `acpCheck + acpFallback` | `grove-web/src/data/agents.ts:78-105` |
| `ACP_AGENT_COMMANDS` 白名单 | 硬编码含 `traex` | `src/api/handlers/env.rs:217-232` |

系统上同时有 `traex` 和 `traecli` 时，**4 个地方 4 种答案**。

### 5.2 `acp_candidates` 字段存在但没人用

`SupplementEntry.acp_candidates`（`src/storage/agent_supplement.rs`）加了但**没人读**。

### 5.3 `acp_fallback` 在两处语义不同

supplement 注释说"已废弃的旧 wrapper 探测兜底"；`marketplace::resolve_binary_for_supplement` 把它当"启动时兜底"。

### 5.4 `acp_check` 多词探测

Hermes（`"hermes acp"`）、Kiro（`"kiro-cli acp"`）、OpenClaw（`"openclaw acp"`）的 `acp_check` 带子命令。probe 切头处理，resolve_agent 没处理。

### 5.5 三个形状各表各的

`BaseAcpAgentStatus` / `BaseAgentDto` / `MarketplaceAgent` / `agentOptions` — 4 个 struct，同一个概念。

### 5.6 version 在三处不一致

- `MarketplaceAgent.version` = registry 最新版
- `MarketplaceAgent.installed.version` = 装的版本
- `BinaryView.version` = `cmd --version`（auto-detected 实际跑的）

### 5.7 Marketplace 慢

`probe_binary` 对每个 auto-detected agent 同步 `cmd --version`，最坏 13 × 1.5s = 20s 阻塞 axum task。

### 5.8 卡片排版差

`MarketplaceModal.tsx` 卡片把名字 + 版本 + 状态挤 2 行，部分宽度被截。

---

## 6. 加新 agent 的清单（现状）

加 agent X：

1. `BUILTIN_ACP_AGENTS` 加项（`src/acp/mod.rs:5013`）
2. `BUILTIN_SUPPLEMENTS` 加项（`src/storage/agent_supplement.rs:76`）
3. `agentOptions` 加项（`grove-web/src/data/agents.ts:50`）
4. `AgentIcons.tsx` 加组件，`agentColors.ts` 加颜色
5. `acp::resolve_agent` 和 `builtin_acp_unavailable_reason` 加分支
6. `ACP_AGENT_COMMANDS` 加 binary 名
7. `cli/mcp.rs::normalize_agent_name` 加 token
8. `GROVE_TEST_NO_<NAME>=1` 测试 override

**1/2/3/5/6 必须人工对齐。** §8 之后只剩 1 步：写 JSON。

---

## 7. （已废弃）加新 binary 别名

原本 trae 走 traecli 加 traex 的修法讨论。**§8 给出的方案不再需要这一节**——加 alias 不再改 4 处代码，只改 1 处 JSON。

---

## 8. 统一 catalog 设计（新方案，取代 §0、§1.1、§2.1、§2.2、§2.3、§3.1、§3.2、§4.1、§5.1–5.5、§6、§7）

**核心原则：**

1. **唯一的 schema** = `RegistryAgent`（registry CDN 用的那个 struct）
2. **唯一的真源** = registry CDN 拉来的 list
3. **Trae / TraeX 是手写 JSON**，跟 registry 解析出来**完全同 shape**，merge 进同一个 list
4. **代码里没有 supplement 表、没有手写 if-else、没有特判分支**
5. **前端只调一个 API** —— `GET /api/v1/agents/marketplace`

### 8.1 统一 schema

`RegistryAgent`（`src/storage/agent_registry.rs:33-51`）扩展后承载所有字段：

```rust
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub icon: Option<String>,

    // 新增：本地 Grove 关心的字段
    pub launch_modes: Vec<String>,       // ["acp"] 或 ["acp", "terminal"]
    pub terminal: Option<TerminalSpec>,  // 终端模式参数（base_command, fresh_args, resume_args, ...）
    pub env: HashMap<String, String>,    // spawn 时注入的额外环境变量

    // 现有
    pub distribution: Distribution,
}
```

CDN 拉来的 agent 这些字段可能为 null / 空数组；本地 Trae/TraeX JSON 里手动填上。

`Distribution` 扩展：

```rust
pub struct Distribution {
    pub npx: Option<NpxDistribution>,
    pub uvx: Option<UvxDistribution>,
    pub binary: HashMap<String, BinaryTarget>,
    // 新增
    pub local: Option<LocalDistribution>,  // PATH 探测 + 启动参数
}

pub struct LocalDistribution {
    /// PATH 探测命令（多词切头）。如 `traex`、`claude`。
    pub probe: String,
    /// PATH 探测兜底命令列表（多词切头）。当前 binary 不在 PATH 时用这个。
    pub probe_fallback: Vec<String>,
    /// 启动参数（base 命令后追加）。
    pub args: Vec<String>,
    /// 可选：跳过 grove-managed install 流程。
    pub installable: bool,  // false → 不能 install，PATH 探测驱动
}
```

Trae / TraeX 的 JSON：

```json
// trae.json
{
  "id": "traecli",
  "name": "Trae",
  "version": "0.0.0",
  "description": "ByteDance's Trae CLI",
  "icon": "trae-color.svg",
  "launch_modes": ["acp"],
  "distribution": {
    "local": {
      "probe": "traex",
      "probe_fallback": [],
      "args": ["acp", "serve"],
      "installable": false
    }
  }
}

// traex.json
{
  "id": "traex",
  "name": "TraeX",
  "version": "0.0.0",
  "description": "ByteDance's Trae CLI v2",
  "icon": "trae-color.svg",
  "launch_modes": ["acp"],
  "distribution": {
    "local": {
      "probe": "traex",
      "probe_fallback": [],
      "args": ["acp", "serve"],
      "installable": false
    }
  }
}
```

**两份 JSON 完全同 schema。** 区别只在 `id` 和 `name`。

### 8.2 三类 agent 全部用 `RegistryAgent` 表达

| 来源 | 形态 | `distribution.local` |
|---|---|---|
| Registry CDN agent（如 Claude Code） | `Distribution { npx: ..., uvx: ..., binary: {...} }` | None（走 registry 的 npx/uvx/binary 路径） |
| 本地 Trae / TraeX JSON | `Distribution { local: { probe: "traex", ... } }` | 有（PATH 探测 + 直接 spawn） |
| 用户自定义 (`Config.acp.custom_agents`) | `Distribution { local: { probe: "agent", ... } }` | 有 |

**没有 supplement 表。** RegistryAgent 就是事实上的"统一 catalog"。

### 8.3 Marketplace API（唯一）

`GET /api/v1/agents/marketplace` 返回 `Vec<MarketplaceAgent>`（每个 MarketplaceAgent 就是加了 `install_state` + `binary` + `installed` + `launch_mode` 字段的 `RegistryAgent`）：

```rust
pub struct MarketplaceAgent {
    // 直接 from RegistryAgent —— 字段完全 1:1
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub repository: Option<String>,
    pub website: Option<String>,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub icon: Option<String>,
    pub launch_modes: Vec<String>,
    pub terminal: Option<TerminalSpec>,
    pub env: HashMap<String, String>,
    pub distribution: Distribution,

    // marketplace 专属：每请求派生
    pub source: Source,                   // "registry" | "local"
    pub install_state: InstallState,      // "auto-detected" | "grove-installed" | "not-installed" | "installing" | "install-failed"
    pub binary: Option<BinaryView>,       // PATH 上挑出来的 + --version
    pub installed: Option<InstalledAgentView>,
    pub launch_mode: String,              // effective launch mode (Config.agent_launch_modes[id] || "acp")
}
```

**生成流程：**

```
list_marketplace():
    1. registry = load_cached() || refresh().await
    2. local_agents = load_local_json_files()  // trae.json + traex.json, 不存在就 skip
    3. all_agents = registry.agents + local_agents
    4. for agent in all_agents:
         compute_install_state(agent, installed_agents.get(agent.id))
         resolve_binary(agent)  // 走 distribution.local 或 distribution.npx/uvx/binary
    5. 排序（name, then id）
```

**步骤 2 的 `load_local_json_files`** 读 `~/.grove/builtin-agents/*.json`（或编进二进制）。每份 JSON 解析成 `RegistryAgent`。**不存在的文件不报错**——用户没下载 trae，trae.json 不存在，Trae 就不出现在 list 里。

### 8.4 解析规则

`resolve_binary(agent) -> Option<BinaryView>`：

```rust
fn resolve_binary(agent: &RegistryAgent) -> Option<BinaryView> {
    let dist = &agent.distribution;
    if let Some(local) = &dist.local {
        // 本地 Trae / TraeX / custom_agents 路径
        for probe in iter::once(&local.probe).chain(&local.probe_fallback) {
            let head = probe.split_whitespace().next().unwrap();
            if command_exists(head) {
                return Some(BinaryView {
                    command: head.to_string(),
                    path: resolve_program(head).map(|p| p.to_string_lossy().to_string()),
                    version: probe_version(head),  // 500ms timeout
                });
            }
        }
        None
    } else if let Some(npx) = &dist.npx {
        // Registry npx 路径（grove-installed 时用，auto-detected 时 binary=null）
        None
    } else {
        // ...
    }
}
```

**没有特判分支。** 所有 agent 走同一函数。

### 8.5 `compute_install_state`（统一规则）

```rust
fn compute_install_state(agent: &RegistryAgent, installed: Option<&InstalledAgent>) -> InstallState {
    // 1. Grove-managed install 优先
    if let Some(rec) = installed {
        if !matches!(rec.install_method, InstallMethod::External)
            && rec.status == InstallStatus::Installed
            && !rec.hidden
        {
            return InstallState::GroveInstalled;
        }
        if rec.status == InstallStatus::Installing {
            return InstallState::Installing;
        }
        if rec.status == InstallStatus::Failed {
            return InstallState::InstallFailed;
        }
    }

    // 2. auto-detected: PATH 探测
    let dist = &agent.distribution;
    let any_probe_present = if let Some(local) = &dist {
        let probes = iter::once(&local.probe).chain(&local.probe_fallback);
        probes.any(|p| {
            let head = p.split_whitespace().next().unwrap();
            command_exists(head)
        })
    } else if let Some(npx) = &dist.npx {
        command_exists("npx")
    } else {
        false
    };

    if any_probe_present { InstallState::AutoDetected } else { InstallState::NotInstalled }
}
```

**没有特判分支。** 所有 agent 走同一函数。

### 8.6 `acp::resolve_agent`（统一规则）

```rust
pub fn resolve_agent(agent: &RegistryAgent) -> Option<ResolvedAgent> {
    if let Some(local) = &agent.distribution.local {
        for probe in iter::once(&local.probe).chain(&local.probe_fallback) {
            let head = probe.split_whitespace().next().unwrap();
            if command_exists(head) {
                return Some(ResolvedAgent {
                    agent_type: "local".into(),
                    agent_name: agent.id.clone(),
                    command: head.to_string(),
                    args: local.args.clone(),
                    url: None,
                    auth_header: None,
                });
            }
        }
        None
    } else if let Some(npx) = &agent.distribution.npx {
        // npx 路径
        ...
    }
    // ...
}
```

`resolve_agent` 现在**接收 `RegistryAgent`**（不是字符串 id）。chat 创建时 `chat.agent` 字符串 → 查 marketplace list → 拿到 `RegistryAgent` → 调这个函数。

### 8.7 删除清单

新方案里**整个消失**的东西：

| 删除项 | 位置 |
|---|---|
| `BUILTIN_SUPPLEMENTS` supplement 表 | `src/storage/agent_supplement.rs` |
| `BUILTIN_ACP_AGENTS` 11 个 id 硬编码 | `src/acp/mod.rs:5013-5080` |
| `builtin_acp_unavailable_reason` 11 个 if-else | `src/acp/mod.rs:5132-5181` |
| `resolve_agent` 11 个手写 spawn 分支 | `src/acp/mod.rs:5184-5371` |
| `TERMINAL_AGENT_PRIORITY` 硬编码顺序 | `src/acp/mod.rs:5376-5412` |
| `pick_first_available_acp_agent` / `pick_first_available_terminal_agent` | `src/acp/mod.rs:5391-5412` |
| `ACP_AGENT_COMMANDS` 白名单 | `src/api/handlers/env.rs:217-232` |
| `check_commands` 端点（POST /api/v1/env/check-commands） | `src/api/handlers/env.rs:234-251` |
| `list_base_agents` 端点（GET /api/v1/agents/base） | `src/api/handlers/agents.rs:29-42` |
| `acp_check` / `acp_fallback` / `acp_candidates` 字段 | supplement + marketplace |
| `terminal_check` / `npx_package` 字段 | supplement + marketplace |
| 前端 `agentOptions` 13 条静态 catalog | `grove-web/src/data/agents.ts:50-64` |
| 前端 `getAcpAvailabilityCommands` | `grove-web/src/data/agents.ts:66-76` |
| 前端 `applyAcpAvailability` | `grove-web/src/data/agents.ts:78-105` |
| 前端 `useACPAvailability` | `grove-web/src/components/Tasks/TaskView/useACPAvailability.ts` |
| 前端 `listBaseAgents` 调用 | `grove-web/src/api/agents.ts` |
| 前端 `TaskGraph.tsx` 探测逻辑 | line 276-300 |
| 前端 `App.tsx` 启动探测 | line 429-465 |
| 前端 `SettingsPage.tsx` 探测逻辑 | line 580-613, 979 |
| `acp/mod.rs` line 2528-2531 (unknown → traecli 兜底) | Trae 不再走 `acp_check`，不需要 |
| `acp/mod.rs` line 2882 traecli 相关注释 | — |
| `cli/mcp.rs` line 1074 trae token 特例 | Trae 跟其他 agent 走同一 normalize |

### 8.8 保留清单

| 保留 | 原因 |
|---|---|
| `acp/mod.rs` session 生命周期（get_or_start_session、drive_session 等） | 跟 agent 身份无关，是 ACP 协议实现 |
| `acp/adapter.rs` | 内容适配，按 binary 名挑——可以从 RegistryAgent.name 派生 |
| `installed_agents` 表 + `spawn_for` | 装的管理 + per-agent 偏好，跟 catalog 解耦 |
| `marketplace.rs::merge` / `compute_install_state` / `resolve_binary_for_supplement` / `probe_binary` | 改成纯数据驱动（见 §8.4-8.5） |
| `marketplace.rs::install_binary` / `install_npx` / `install_uvx` | 走 `agent.distribution` 而不是 supplement |
| `marketplace.rs::uninstall_agent` | 走 `installed_agents` 表，不变 |
| `marketplace.rs::patch_agent` | 校验逻辑改用 `agent.launch_modes` |
| `agent_pty.rs` | 终端模式逻辑——参数从 `agent.terminal` 派生 |
| `acp/mod.rs` line 2528-2531 兜底 → 改成通用"启动后 agent_name 为空时的兜底" | 不依赖 traecli 特定字符串 |
| `cli/mcp.rs::normalize_agent_name` | orchestrator 端，**重新设计**——不再靠 trae token，靠 marketplace list |
| `storage/skills.rs::AgentDef` | Skills 关注点不同，保留 |
| 前端 `MarketplaceAgent` 形状 | 不变（§8.3 给出的形状） |
| 前端 `MarketplaceModal.tsx` | 不变 |
| 前端 `AgentPicker` 通用选择器 | 不变，只是 `displayOptions` 数据源从 marketplace 来 |

### 8.9 命名澄清

| 旧术语 | 新术语 |
|---|---|
| `acp_check` (supplement 字段) | `distribution.local.probe` (RegistryAgent 字段) |
| `acp_fallback` (supplement 字段) | `distribution.local.probe_fallback` (RegistryAgent 字段) |
| `acp_candidates` (supplement 字段) | `distribution.local.probe` + `probe_fallback` 合成（不再独立） |
| `terminal_check` (supplement 字段) | 删（终端模式探测 = `probe` 复用） |
| `npx_package` (supplement 字段) | `distribution.npx.package` (RegistryAgent 字段，已存在) |
| `supported_launch_modes` (supplement 字段) | `launch_modes` (RegistryAgent 字段) |
| `terminal_profile` (supplement 字段) | `terminal` (RegistryAgent 字段) |

**新字段都直接挂在 `RegistryAgent` 顶层**，不再有 supplement 层级。

### 8.10 数据流总图

```
Registry CDN
   ↓ (拉 / 缓存)
~/.grove/registry/registry.json
   ↓ (反序列化为 RegistryAgent)
registry: Vec<RegistryAgent>

~/.grove/builtin-agents/trae.json  (用户在 Trae 页下载后才有)
~/.grove/builtin-agents/traex.json (同上)
   ↓ (反序列化为 RegistryAgent)
local: Vec<RegistryAgent>

all = registry + local
   ↓ (compute_install_state + resolve_binary 派生)
MarketplaceAgent Vec
   ↓ (HTTP 响应)
GET /api/v1/agents/marketplace
   ↓ (前端)
MarketplaceModal / AgentPicker / TaskChat
```

**全链路零特判。** 新增 agent = 写一份 JSON（或等 registry CDN 更新）。

### 8.11 慢的问题（§5.7）一并解决

`probe_binary` 现在对**所有** agent 跑 `--version`。§8 之后只对 `distribution.local` 的 agent 跑——registry agent 走 `version` 字段。marketplace 慢问题消失。

### 8.12 卡片排版问题（§5.8）

跟 §8 解耦，单独修 UI。

### 8.13 已有数据的迁移（首次升级）

#### 8.13.1 `installed_agents` 表的 id 重映射

**问题：** 现在 `installed_agents.id` 可能是 legacy id（如 `claude`），registry 用 canonical id（`claude-acp`）。§8 之后 supplement 表没了，**`id` 字段必须跟 registry 一致**，否则查 marketplace list 时 id 匹配不上。

**迁移规则（启动时跑一次，写 idempotent SQL）：**

```sql
-- 旧 → 新
UPDATE installed_agents SET id = 'claude-acp' WHERE id = 'claude';
UPDATE installed_agents SET id = 'codex-acp'  WHERE id = 'codex';
UPDATE installed_agents SET id = 'cursor'     WHERE id = 'cursor-agent';
UPDATE installed_agents SET id = 'github-copilot-cli' WHERE id IN ('gh-copilot', 'copilot');
UPDATE installed_agents SET id = 'qwen-code'   WHERE id = 'qwen';
-- traecli 保留（历史 ChatSession.agent 还是 "traecli"，不能改）
-- 其余 id（gemini/kimi/opencode/junie/hermes）已是 canonical，no-op
```

**老用户的 ChatSession.agent 字段**——同样跑一次：`UPDATE chat_session SET agent = 'claude-acp' WHERE agent = 'claude'`，依此类推。

**好处：** 迁移后 `installed_agents.id` 和 `chat_session.agent` 都跟 registry `RegistryAgent.id` 完全对齐，`marketplace.rs` 一行 join 就能找到 agent。

**触发时机：** `src/storage/database.rs::ensure_storage_version` 在检测到 storage_version 旧时调用新加的 `migrate_agents_to_registry_ids` 函数。迁移完 bump version。下次启动跳过。

#### 8.13.2 已装未在 registry 的 agent（如 traecli）

迁移后 `installed_agents.id = 'traecli'` 仍存在。**`traecli` 不在 registry**，marketplace 列表里没有这一项。这条 `installed_agents` 行变成"孤儿"。

**§8 之后的处理：**
- `traecli` 的 MarketplaceAgent 由本地 `~/.grove/builtin-agents/trae.json` 注入
- `installed_agents.id = 'traecli'` 在 `compute_install_state` 时，跟 marketplace list 里 id 匹配（trae.json 注入后能匹配上）
- 老用户机器上没装 trae，trae.json 不存在，Trae 不进 list，`installed_agents` 里的 traecli 行就**不显示**——但卸载时这条孤儿记录还在

**清理策略：** `uninstall_agent` 时不只删 `installed_agents` 行，**也清掉对应 `chat_session` 历史**？不，历史数据不能动。**保留孤儿行**就行，UI 看不到而已。未来用户装了 trae，Trae 重新出现在 list 时，老记录复活。

#### 8.13.3 persona (`custom_agent.base_agent`) 的 id 引用

`custom_agent.base_agent` 也是字符串引用，需要同样迁移：

```sql
UPDATE custom_agent SET base_agent = 'claude-acp' WHERE base_agent = 'claude';
-- ...
```

### 8.14 新用户首次安装的体验（curated 预装）

**问题：** 新用户 `installed_agents` 表空 → marketplace 弹窗 Installed tab 空 → Explore tab 40+ agent → 用户得自己挑 → 体验差。

**§8 方案：** `~/.grove/builtin-agents/curated.json` 跟 trae/traex.json 同目录存在，**grove 在二进制内嵌一份默认 curated**。**首次启动**把它 copy 到 `~/.grove/builtin-agents/curated.json`，UI 默认展示这一组作为"推荐安装"。

```json
// 内嵌默认 curated.json
{
  "name": "Recommended starter pack",
  "agent_ids": ["claude-acp", "codex-acp", "gemini", "opencode"]
}
```

**UI 行为：**
- Installed tab：用户装的（installed_agents 表里 Installed/Installing 的行 + auto-detected）
- Explore tab：所有 registry + 本地 agent，**默认用 curated 的 4 个作默认展示**
- 用户点 "Show all" 切到完整 registry
- 用户能编辑 `curated.json`（高级用户 / 公司内部员工加 traecli / traex / 内网 agent 到 curated）

**预装机制：**
- curated 本身**不安装任何 agent**——它只是一个 `agent_ids` 列表
- 首次启动时，**弹 onboarding 卡片**问"要不要一键装这 4 个？"（npx 装，binary 装，按 curated 顺序串行）
- 用户可以跳过，永远用空 curated

### 8.15 Distribution 三种形态的 install dispatch

**问题：** 现在 `install_agent` handler 接受 `method: Option<InstallMethod>`，默认走 `pick_default_method`（`npx > binary > uvx`）。**后端不该有优先级** —— 用户点哪个就装哪个。

**§8 方案：**

```rust
pub async fn install_agent(Path(id), Json(body)) -> Result<...> {
    let reg = lookup_in_registry_or_local(&id)?;  // registry + local
    let method = body.method.ok_or(BadRequest("choose npx/binary/uvx"))?;

    match method {
        InstallMethod::Npx   => install_npx(&reg).await,
        InstallMethod::Binary => install_binary(&reg).await,
        InstallMethod::Uvx    => install_uvx(&reg).await,
        InstallMethod::External => Err(BadRequest("external isn't installable")),
    }
}
```

**前端 `availableMethods`**（已存在，line 431-434）从 `distribution` 的非空 key 派生 → UI 列出来给用户点。

**`local` 不进 install handler**——`local` agent 是 PATH 探测驱动，没有 install 流程。marketplace UI 看到 `distribution.local` 时**不显示** "Install via" 按钮，只显示 "Detected on PATH"。

### 8.16 Distribution 形态完整覆盖

§8 之后 `Distribution` 完整形态：

```rust
pub struct Distribution {
    pub npx: Option<NpxDistribution>,
    pub uvx: Option<UvxDistribution>,
    pub binary: HashMap<String, BinaryTarget>,
    pub local: Option<LocalDistribution>,  // 新增
}
```

**运行 dispatch（agent 启动时挑怎么跑）：**

| `Distribution` 内容 | 运行方式 | 来源 |
|---|---|---|
| `npx` 有 + `installed_agents` 有 Installed 记录 | `npx -y <pkg>@<installed.version> <args>` | `installed_agents::spawn_for` |
| `npx` 有 + 无 Installed + PATH 上有 npx | 同上（auto-detected，pin 到 registry.version） | `acp::resolve_agent` |
| `binary` 有 + `installed_agents` 有 Binary 记录 | 跑 `~/.grove/agents/<id>/<version>/<cmd> <args>` | `installed_agents::spawn_for` |
| `binary` 有 + 无 Installed | "未安装" | install 流程 |
| `uvx` 有 | 同 npx，但用 `uvx <pkg><==ver> <args>` | — |
| `local` 有 + PATH 上有 `probe` 或 `probe_fallback` | 跑 `<probe> <args>` | §8.4 通用 dispatch |
| 全部 None | 不可用 | UI 标 not-installed |

**无"优先级"——一个 agent 的 `Distribution` 形态决定它怎么跑；`npx` + `binary` 同时有的 agent（kilo, sigit, codex-acp），UI 给用户挑。**

### 8.17 当前代码审计：installed_agents + install/uninstall/spawn 流程

**审计日期 2026-06-09。** §8 设计**实施前必须先修这些** bug。

#### 8.17.1 `installed_agents` 表 schema（不动）

```sql
CREATE TABLE installed_agents (
    id              TEXT PRIMARY KEY,
    version         TEXT NOT NULL,
    install_method  TEXT NOT NULL,  -- 'npx' | 'binary' | 'uvx'
    install_path    TEXT,           -- binary only (extracted dir)
    status          TEXT NOT NULL,  -- installing | installed | failed
    failure_reason  TEXT,
    args_override   TEXT,           -- JSON array of strings
    env_override    TEXT,           -- JSON map
    launch_mode     TEXT NOT NULL DEFAULT 'acp',
    hidden          INTEGER NOT NULL DEFAULT 0,
    installed_at    TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

**没存** registry 提供的 args/env（`BinaryTarget.args`、`NpxDistribution.args`、`*.env`）。这些**只能从 registry 实时派生**。

#### 8.17.2 当前 bug 清单

##### Bug 1: `install_binary` 把 `target.env` 写进 `env_override` 字段（错位语义）

`marketplace.rs:720`：

```rust
env_override: target.env.clone(),  // ❌ 错
```

`env_override` 字段语义是"**用户** override 的 env"，但 install 阶段把 **registry 默认 env** 塞进这个字段。结果：

- 用户 PATCH env 时**全量覆盖** registry env（registry 升级改了默认 env，DB 不会同步；用户 PATCH 完会丢失 registry 后续升级带来的 env）
- registry env 跟用户 override env 混在一个字段，分不开

**修法：** 三个 install handler 初始化时 `env_override: HashMap::new()`（空），registry env **不写 DB**。

##### Bug 2: `spawn_for` 完全忽略 registry 提供的 args

`installed_agents.rs:265-301`：

| 分支 | 当前 base_args | 应该 |
|---|---|---|
| Npx | `["-y", "<pkg>@<ver>"]` | `["-y", "<pkg>@<ver>"]` + `npx.args`（如 `["--acp"]`） |
| Uvx | `["<pkg>==<ver>"]` | `["<pkg>==<ver>"]` + `uvx.args`（如 `["-x"]`） |
| Binary | `[]` | `target.args`（如 `["acp", "serve"]`） |

**修法：** `spawn_for` 接收 `&RegistryAgent`，从 `distribution.npx/binary/uvx` 里读 args append 到 base_args。

##### Bug 3: registry env 完全没拼到 spawn env

`acp.rs:1459-1470`：

```rust
for (k, v) in &rec.env_override {  // ❌ 只有用户 override
    env_vars.insert(k.clone(), v.clone());
}
```

**registry 提供的 env 完全不传给子进程。** 比如 `vtcode` registry 给 `env: { VT_ACP_ENABLED: "1", VT_ACP_ZED_ENABLED: "1" }`，用户装完**这两个 env 不会出现在子进程里**，agent 行为不对。

**修法：** spawn 时 merge 顺序：

```
1. grove 默认 env (GROVE_* 之类，已在 build_grove_env 里)
2. + registry 提供的 env (target.env / npx.env / uvx.env)  ← 新加
3. + env_override (用户 PATCH 时填的，覆盖同 key)         ← 已存在
```

##### Bug 4: Npx/Uvx spawn_for 强依赖 `supplement.npx_package`

`installed_agents.rs:271, 280`：

```rust
InstallMethod::Npx => {
    let pkg = supplement?.npx_package?;  // ❌ §8 之后 supplement 表没了
    ...
}
```

**修法（§8 之后）：** `spawn_for` 接收 `&RegistryAgent` 参数，从 `agent.distribution.npx.package` 读。`supplement` 参数整删。

#### 8.17.3 当前 bug 总结表

| Bug | 位置 | 影响 | §8 改法 |
|---|---|---|---|
| 1. registry env 错写到 env_override | `marketplace.rs:720, 811, 847` | 用户 PATCH env 丢 registry 默认；registry 升级 env 不会同步 | 三个 install handler 初始化为空 |
| 2. spawn_for 不读 registry args | `installed_agents.rs:265-301` | registry 提供的 `--acp` 等参数丢失，agent 不能进入 ACP 模式 | `spawn_for` 接收 `&RegistryAgent`，从 distribution 派生 args |
| 3. registry env 没传子进程 | `acp.rs:1464-1466` + `agent_pty.rs:146` | 用户装的 registry agent 缺关键 env（如 `VT_ACP_ENABLED`） | spawn 时 merge 顺序：grove → registry → user |
| 4. Npx/Uvx 强依赖 supplement | `installed_agents.rs:271, 280` | §8 之后 supplement 删了会 NPE | `spawn_for` 改从 `RegistryAgent.distribution` 派生 |

#### 8.17.4 Uninstall 审计

| Method | 删什么 | 状态 |
|---|---|---|
| Binary | `~/.grove/agents/<id>/<ver>/` + SQLite 行 | ✅ 完整（含安全校验：canonicalize + `starts_with(agents_root)`） |
| Npx | 只删 SQLite 行（npm cache 留着） | ✅ 合理（npx 是 lazy download，磁盘上本来就没装） |
| Uvx | 只删 SQLite 行（uv cache 留着） | ✅ 同 Npx |
| External | 只删 SQLite 行 | ✅ |

**前端 `handleUninstall`**（`MarketplaceModal.tsx:157-167`）调 `uninstallAgent(id)` → `await reload()` → marketplace list 重算 `install_state` → 卡片自动从 Installed tab 消失。**OK。**

#### 8.17.5 修法（影响范围 + 顺序）

1. **`spawn_for` 签名改**（`installed_agents.rs:265`）：
   ```rust
   pub fn spawn_for(
       rec: &InstalledAgent,
       reg: &RegistryAgent,  // ← 替代 supplement
   ) -> Option<(String, Vec<String>)>
   ```
2. **`acp.rs:1458, 1460` 改**：传 `&reg`，删 supplement 引用
3. **`agent_pty.rs:152, 154` 改**：同上
4. **`marketplace.rs:720, 811, 847` 改**：三个 install handler 初始化 `env_override: HashMap::new()`
5. **`acp.rs:1464` / `agent_pty.rs:146` 改**：spawn 时先 merge registry env 再 merge user env

**5 个文件，~20 行。** 跟 §8 的更大改造一起做。

#### 8.17.6 顺序约束

1. 先 §8.13 迁移（id 重映射）
2. 再 §8.17.5 修 bug（spawn_for 签名 + registry env 分离）
3. 然后 §8.7 删 supplement 表
4. 最后 §8.14 curated 预装（可独立）

**不能**先删 supplement 再修 spawn_for —— 会 NPE 编译错误（`spawn_for` 还在引用 supplement）。

---

## 8.18 Followup Review (2026-06-09) — scope-cut notes

A second-pass review turned up 5 issues that didn't fit in the §8 push.
Filed here for the next PR; the current PR is "backend §8 complete,
frontend still on the §7 dual-source pattern":

### Backend open items (in this PR, fixed)

- **A. resolve_agent step 3 (`./` prefix + command_exists check)** —
  `target.cmd` is now only honored when it's a bare command AND
  `command_exists` returns true. `./amp-acp`-style archive-relative
  paths fall through to step 4 (acp_candidates / id) instead of
  spawning a broken relative-path binary.
- **B. agent_pty.rs terminal mode (#14)** — terminal-mode now
  launches the `grove_agent_meta::terminal_profile.base_command`
  (e.g. raw `claude`) under a PTY, NOT
  `installed_agents::spawn_for` (which would yield the ACP adapter).
  `--session-id` / `--resume <uuid>` resume protocol now works for
  users who installed Claude via npx/uvx/binary.
- **C. base_acp_agent_statuses hardcoded traecli** — replaced the
  one-line `if r.id == "traecli"` carve-out with a full
  `BTreeSet<String>` union of `BUILTIN_GROVE_META ∪ registry.agents`.
  All 24 registry-only agents (agoragentic-acp, amp-acp, …) now
  show up in the SettingsPage picker.
- **D. BuiltinAcpAgent `Box::leak` per call** — fields changed from
  `&'static str` to `String` / `Vec<String>`. The SettingsPage
  SettingsPage no longer leaks per render.
- **E. Trae `acp_candidates` fallback** —
  `grove_agent_meta::BUILTIN_GROVE_META[traecli].acp_candidates =
  &["traecli", "traex"]`. The synthetic registry entry is the
  *fast* path; this `acp_candidates` row is the redundant cold-start
  fallback so resolve_agent / base_acp_agent_statuses always have
  a path to Trae regardless of cache state.
- **F. agent_pty.rs drop registry_agent get()** — removed the
  `agent_registry::get()` + `find` call in terminal mode; it's no
  longer needed.
- **H. CDN registry sanity check** — verified all 4 curated ids
  (`claude-acp` / `codex-acp` / `gemini` / `opencode`) exist in
  `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
  and ship a usable distribution channel (npx or binary).

### Frontend open item (deferred to next PR)

- **G. Frontend §8 收口 (agents.ts)** — the file currently maintains
  a 13-row `agentOptions` + `applyAcpAvailability` /
  `getAcpAvailabilityCommands` helpers in parallel to the backend
  marketplace. This is what the TS strict-mode build "broke" on
  after the first pass deleted the helper functions. The fix in
  this PR was to restore those helpers (so the build passes), but
  the long-term fix is to delete the frontend-side catalog and
  have the agent pickers (App.tsx, TaskGraph, TaskChat,
  SettingsPage, AutomationDialog, TrayPopover, AgentPicker) read
  from the backend `listBaseAgents` / `marketplace/list` endpoints
  directly. That's a separate frontend-only PR with its own
  blast-radius on UI components. Not done here to keep the backend
  push focused.
