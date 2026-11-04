# 数据导出与导入

把 Grove 的数据打成一个 `.grove` 文件，带到另一台机器或另一个路径下导入。主要用于换机器和多台机器之间合并数据。

## 导出

用户分别勾选两个维度。

**项目**：可多选。只勾全局类别、不选项目也可以。

**数据类别**：

| 层级 | 类别 | 内容 |
|---|---|---|
| 项目内 | 上下文 | Memory（日志、实体、关系和 md 文件）、笔记、Studio 指令和资源 |
| | 任务 | 任务元数据、关联项目、Studio 任务的 input/output |
| | 对话 | session 表、`history.jsonl`（依赖"任务"） |
| | Review | 评论和回复（依赖"任务"） |
| | 自动化 | automations、memory_project_configs |
| | 统计 | token 用量、agent graph 边 |
| 全局 | 设置 | 主题、布局、快捷键 |
| | 自定义内容 | 自定义 agent、用户自建 skill |
| | Buddies 与 Connect | buddies 及其对话、connects（不含凭据） |

规则：

- 依赖自动处理：勾"对话"会带上"任务"。
- 指向未选中项目的引用（关联项目、任务组槽位、跨项目的 agent graph 边）会被丢弃，导出前提示。
- 每个类别显示大致体积。
- 对话不支持按时间筛选。
- 导出前列出有未提交或未推送改动的任务：这些改动不会被带走。

### 不导出

- 所有密钥和凭据，没有开关：`ai_providers.api_key`、`connects.app_secret` 和 `adapter_config_json` 内的凭据、`mcp_installations.values_json`、`agent_config_json` 内的 env 值、`auth_devices`、`auth_servers`、`local_report_token`、`auth-revoked`。
- 已安装的 agent 和 MCP 配置。
- 缓存、日志、`index.db`、`session.json`、`agent.log`。
- 代码和 worktree。git 是代码的唯一来源。

每张表必须显式声明为"可导出 / 需清理 / 不导出"，由测试保证。新增的表没有声明时测试失败，避免新密钥被带出。

## 包格式

`.grove` 文件，tar.zst 压缩：

```
manifest.json      格式版本、grove 版本、storage_version、导出时间、来源机器、
                   selection（项目与类别）、项目清单（原路径、原 ID、类型、
                   git remote、默认分支）、每个文件的 sha256
db/<table>.jsonl   每行一个 JSON 对象，键为列名
files/projects/<oldhash>/...
files/studios/<oldhash>/...
files/config.toml
```

按列名导出而不是拷贝 `grove.db`，表结构变化后仍可导入：未知列忽略，缺失列用默认值。包的 storage_version 比本机新时拒绝导入。

## 导入

1. **预览**：校验版本和 sha256，展示包内的项目和类别。
2. **项目映射**：每个项目一行，全部确定后才能继续。
3. **写入**：先备份到 `~/.grove/backups/import-<ts>/`，文件先解到临时目录再改名移入，数据库在一个事务里写完。受影响项目有运行中的 session 时要求先停止。
4. **报告**：写出 `report.json`，界面展示结果和待办（补填凭据、失败的项目）。

### 项目映射

项目 ID 由路径哈希得出（`project_hash`），路径变了 ID 就变，所以导入时要把所有项目 ID 字段和目录名换成新值。

自动匹配按优先级：

1. 本机存在完全相同的路径。
2. git remote 相同（规范化后比较，ssh 和 https 视为同一地址）。
3. 同名 Studio 项目，只作为建议，需用户确认。

手动选项：

| 选项 | 适用于 |
|---|---|
| 合并到已有项目 | 仓库、Studio |
| 选择本地文件夹 | 仓库 |
| 从远程克隆（预填 manifest 里的地址） | 有 remote 的仓库 |
| 新建 Studio 项目 | Studio |
| 跳过 | 全部 |

两个包内项目不能映射到同一个本机项目。

CLI 用 `--map <项目名>=<路径|new|skip>`；没指定的项目只走自动匹配，匹配不上时报错并列出，不猜测。

### 导入失败

本机没有仓库且拿不到代码（没有 remote 或克隆失败）时，该项目导入失败，原因写进报告。

- 克隆在写入数据之前完成，失败的项目不留下任何数据。
- 其他项目照常导入，指向失败项目的引用被丢弃。
- 解决问题后重新导入同一个包即可。

### 冲突与重复

- 只替换项目 ID，对话、任务、memory 等的 ID 原样保留，导入时按 ID 去重。同一个包导两次，第二次没有变化。
- 文件冲突保留本地版本，包内文件加后缀另存并写进报告。
- Memory 的 md 冲突同样加后缀另存，交给 AI 的 Memory 整理流程处理。
- 被清空凭据的条目（Provider、Connect、MCP）默认禁用，进入报告的待办清单。

### 任务

| 任务类型 | 处理 |
|---|---|
| Studio 任务 | 文件随包恢复 |
| 本地任务（`is_local`） | 指向映射后的项目根目录 |
| 已归档的 Coding 任务 | 保持归档，不建 worktree |
| 进行中的 Coding 任务，分支能找到 | 先找本地分支，再 fetch 找 `origin/<branch>`，导入时直接建好 worktree |
| 进行中的 Coding 任务，分支找不到 | 以归档状态导入，写进报告 |

## 只读会话

独立于导入导出的通用会话状态。agent 的本地 session 无法迁移，也可能被 agent 自己清理，丢失后不可恢复。

`session` 表新增：

| 列 | 取值 |
|---|---|
| `readonly_reason` | `NULL`、`imported`、`agent_expired` |
| `readonly_meta` | JSON：来源机器和时间，或报错原文 |

进入只读的时机：

- 导入时设为 `imported`，同时清空 `acp_session_id`。
- 恢复会话时 `missing_saved_session` 命中且对话非空，设为 `agent_expired`，不再报错。只在打开时被动检测，不扫描各家 agent 的本地目录。

只读是终态，不提供重试恢复。

### 能力矩阵

行为集中在两处，不在各入口分散判断：

- `tasks::ensure_chat_writable`：`get_or_start_session` 开头调用，所有 Agent 启动都经过这里。
- `tasks::load_writable_chat_sessions`：所有"把 Session 当目标"的列表都用它；只读 Session 仍在 `load_chat_sessions` 里，可以查看。

Buddy Segment 不会被标记只读：它的生命周期归 Buddy 管，活跃 Segment 变只读会把 Buddy 锁死。

| 能力 | 正常 | 只读 |
|---|---|---|
| 查看、重命名、置顶、归档、删除 | ✅ | ✅ |
| 发消息、恢复、切 mode 或 model | ✅ | ❌ |
| Fork | 按 agent 能力 | ❌ |
| 被别的 agent 读取 | ✅ | ✅ |
| 作为消息目标 | ✅ | ❌ |
| 出现在 Agent Graph | ✅ | ❌ |

### 联动

| 联动点 | 只读会话的处理 |
|---|---|
| Agent Graph 视图 | 隐藏会话及其边 |
| `grove_agent_contacts` | 不列出 |
| `grove_agent_send` | 拒绝，返回 `target_read_only` |
| `grove_send_prompt` 及其他启动 Agent 的入口 | 被 `ensure_chat_writable` 拒绝 |
| 发往或来自只读 Session 的待回复消息 | 标记只读时删除 |
| `grove_list_chats` | 照常返回，带 `readonly` 和 `history_path` |
| `grove_chat_status` | 不启动 Agent，返回 `state: read_only` 和 `history_path` |
| @ 提及的发送目标、Connect 的会话选项、Radio 的会话列表 | 不列出 |
| 绑定了只读 Session 的自动化 | 下次触发时在同任务下用同一 Agent 新建会话并改绑 |
| 绑定了只读 Session 的 Connect | 解除绑定，按没有会话时的流程处理 |
| 任务组 `target_chat_id` | 清空 |
| Orbit 侧栏 | 会话行显示只读图标 |
| Orbit 会话页 | 输入框的位置换成 `OrbitReadOnlyCard`，顶部状态为 Read only |
| 会话菜单 | 只留 Rename、Archive、Delete |
| Workbench | 底部中性胶囊提示，列表行显示 Read-only 文字 |
| 终端 app | 发送时收到服务端的只读错误 |

### 让 agent 读取

复用现有的 `chat_history` @ 提及（把 `history.jsonl` 路径交给 agent，由 agent 自己读），不新增 MCP 工具：

- `grove_list_chats`、`grove_chat_status` 返回 `history_path`，agent 可以自行读取。
- 只读会话底部显示原因和 "Continue in new session"、"Archive"。"Continue in new session" 先让用户选 agent，在同一任务下新建对话，输入框预填这段历史的 @ 提及，不自动发送。
- 导入时把来源机器名写进 `readonly_meta.source`，卡片标题显示 "Imported from <source>"。

## 使用入口

- **API**：`POST /api/v1/data/export`、`/data/import/preview`、`/data/import/apply`。
- **CLI**：`grove export [-o file] [--projects …] [--no-chats]`、`grove import <file> [--map …] [--replace] [--dry-run]`，与 `grove migrate` 同级。
- **GUI**：设置里的「数据」页，导出和导入两个向导。
- **Remote**：支持导出和导入，仅限已信任设备。导入向导可以直接从已连接的远端机器拉取。

导入策略默认合并，`--replace` 用于在新机器上完整恢复。

### 进度

- 导出：先在服务端生成临时文件，再带 `Content-Length` 下载。
- 导入：XHR upload 进度事件，服务端步骤通过 WS 推送。
- 第一版不做断点续传。

## 实现顺序

| 阶段 | 内容 |
|---|---|
| P0 | 只读会话（状态、统一检查、联动点） |
| P1 | 导入导出后端（`src/storage/bundle/`）和 CLI，用 `GROVE_DIR_OVERRIDE` 写往返测试 |
| P2 | GUI 向导、Remote 拉取、进度条 |

## 不在范围内

- 撤销导入：用自动备份恢复。
- 云同步、定时自动导出。
- 把代码打进导出包。
- 项目路径变动后的重新关联。
- 全局文件上传下载的进度条。
- Agent 自动升级和首次安装引导。
