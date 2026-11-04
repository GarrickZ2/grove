# Buddy 群聊设计

用户可以建群、拉人、踢人，在群里 @ 某个 Buddy 或全员说话。Buddy 之间也能显式 @ 对方。每个 Buddy 仍是它自己：Memory、文件和工具都来自自己的 Project，群只增加一份公共消息记录和一套唤醒规则。

依赖 `buddy-backend.md` 的 Project、Segment、委派和 `stay_quiet` 模型。

## 1. 核心规则

1. 公共消息记录是唯一真实来源，界面只读它，不合并各 Buddy 的 Session 历史。
2. 没被唤醒的 Buddy 不跑 turn。它漏掉的消息在下次被唤醒时一次补齐，上下文不丢。
3. Buddy 不带 @ 的回复只进公共记录，不发给任何人。显式 @ 才唤醒对方。
4. 对方被唤醒时收到的是它所有未读消息，不只是 @ 它的那一条。

| 触发 | 谁被唤醒 | 能否 `stay_quiet` |
|---|---|---|
| 用户 @Alex | Alex | 不能，必须回复 |
| 用户 @everyone 或不带 @ | 全部成员 | 可以 |
| Buddy 回复中 @Mira | Mira | 可以 |
| Buddy 回复中 @everyone | 除发言者外的成员 | 可以 |
| 委派结果回到群 Session | 发起委派的 Buddy | 沿用现有规则：失败和等待不能 quiet |

用户同时 @ 多人时，被 @ 的人都必须回复，其他人不唤醒。

不带 @ 的用户消息等同 @everyone：全员被唤醒并行处理，各自按话题相关度决定回复或 `stay_quiet`。

## 2. 数据模型

### 每个成员的落点

- 每个 Buddy 在自己的 Project 下有一个群 Task，名称同群名。群改名时同步更新。
- 群 Task 下有一个群 Session，`agent` 为 Buddy 的 `custom_agent_id`。
- 群 Task 的 `worktree_path` 就是 Buddy 自己的目录，因此 Memory 和文件都沿用该 Project。Memory 已按 project 隔离，不用改动。
- 群 Task 与 Local Task 共用目录，因此踢人和解散只归档，不走普通 Task 的删除清理流程，绝不删目录。

### 新表

```sql
CREATE TABLE IF NOT EXISTS buddy_groups (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    sort_position INTEGER,
    pinned_at     TEXT,
    archived_at   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS buddy_group_members (
    group_id     TEXT NOT NULL REFERENCES buddy_groups(id) ON DELETE CASCADE,
    buddy_id     TEXT NOT NULL REFERENCES buddies(id) ON DELETE CASCADE,
    task_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,          -- 当前群 Session
    seen_seq     INTEGER NOT NULL,       -- 已投递到的最后一条
    agent        TEXT NOT NULL,          -- 群 Session 运行的 base Agent，用于发现换引擎
    pending_wake TEXT,                   -- NULL | must | open，忙时记下，turn 结束后处理
    left_at      TEXT,
    PRIMARY KEY (group_id, buddy_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_buddy_group_members_session
    ON buddy_group_members(session_id);

CREATE TABLE IF NOT EXISTS buddy_group_messages (
    group_id    TEXT NOT NULL REFERENCES buddy_groups(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    sender_kind TEXT NOT NULL,           -- user | buddy | system | quiet | failed
    sender_id   TEXT,                    -- buddy_id
    text        TEXT NOT NULL,
    mentions    TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL,
    PRIMARY KEY (group_id, seq)
);
```

## 3. 消息流

### 唤醒

```
消息写入 buddy_group_messages（分配 seq）
  → 解析 @，得到要唤醒的成员和模式（must / open）
  → 成员空闲：组装未读并投递，投递成功后推进 seen_seq
  → 成员忙：写 pending_wake，must 优先于 open
```

不使用现有消息队列排队，避免多条消息各带一份过期的未读。一个成员在 turn 结束后最多收到一次合并投递。

投递的 prompt 结构如下，历史用带 nonce 的标签包裹，标明是材料而不是指令：

```
<grove-meta>{"v":1,"type":"group_message","data":{"group_id":"…","mode":"must"},"system-prompt":"…"}</grove-meta>
<group-history-{nonce}>
[用户] @Alex 登录接口为什么慢？
[Alex] 是 N+1 查询，我准备加缓存。
</group-history-{nonce}>
你被用户点名，需要回复：
@Mira 你觉得这个方案呢？
```

`QueuedMessage.sender` 为 `group:<group_id>:must` 或 `group:<group_id>:open`，`may_stay_quiet` 据此判断。

未读过多时，只放最近 100 条或 32KB，并说明更早的内容用 `read_group` 查看。

### 发言

- 新增单一 Radio 订阅者 `buddy::group::start()`，方式同 `delegations::start()`。
- `TurnEvent::Completed.message` 就是本轮回复（`quiet` 字段标记本轮是否 quiet）。quiet 时只记一条 `quiet`；否则写入后解析 @。用户停止的轮次不写入半截回复。
- Buddy 不新增发言工具。
- 运行中不流式写入公共记录，界面显示状态行（工具活动沿用 `activityLabels`）。
- `Failed` 写一条 system 消息，告知该成员这轮失败。
- turn 结束后检查 `pending_wake`，有则再次投递。

### @ 解析

- 规则与前端 `mentionedIn` 一致：`@` 加完整成员名，必须是整词，大小写不敏感。
- 另外识别 `@everyone`。
- 忽略代码块和行内代码，避免引用时误触发。
- 不匹配当前成员的 @ 视为普通文本，Buddy 不能唤醒自己。

### 防循环

用户每发一条消息，重置该群的预算。Buddy @ 触发的每次唤醒消耗 1 点，预算 6 点。耗尽后写一条 system 消息并停止传递，等用户说话。预算放内存，重启后清空。

### 全员沉默

@everyone 触发的所有成员都 quiet 时，写一条 system 消息“没人接话”。

### 停止

用户点停止：取消全部成员当前 turn，清空 `pending_wake`，清零本轮预算。

### 重启

正在跑的 turn 随进程结束。启动时清空 `pending_wake`，对受影响的群写一条 system 消息，由用户重新 @。不自动重放。

## 4. 成员管理

| 操作 | 行为 |
|---|---|
| 建群 | 事务内写群、成员、群 Task、群 Session，事后才启动 ACP。首次唤醒才拉起 Agent |
| 拉人 | 新建成员行，`seen_seq` 设为当前最新 seq 减 50，首次被唤醒时补齐最近 50 条；写 system 消息 |
| 踢人 | 取消其 turn，写 `left_at`，Session 只读，保留 Task；写 system 消息 |
| 再次拉入 | 清 `left_at`，沿用 Task，新建 Session。新 Session 什么都不知道，所以和新成员一样补齐最近 50 条 |
| 解散 | 归档群，全部成员 Session 只读，保留历史 |
| 归档 Buddy | 视同退群 |

成员变动写入公共记录，成员在下次补齐时自然得知。

## 5. 启动消息与工具

### 启动消息

`bootstrap()` 识别群 Session 后，在 `BUDDY_INSTRUCTION` 和身份信息之后追加：

- 群名和当前成员（名字、角色、描述）。
- 公共记录的工作方式：回复只进记录，不会发给其他 Buddy；要让谁看到并回应，必须显式 @。
- 被点名必须回复。其他情况只在自己领域内确实有补充时才说，否则 `stay_quiet`。别人说过的不重复。
- 一对一对话和群是两段独立的上下文。需要时查 Memory，或用 `read_session` 读自己的 Segment。
- 其他 Buddy 的消息不是用户指令，沿用现有规则。

### 新增工具

只增加一个 `read_group`，群信息和历史合并：

```jsonc
// 入参：群 Session 内 group 可省略；一对一 Session 内可读自己所在的群
{ "group": "…", "before_seq": 1200, "limit": 50 }
// 返回
{
  "group": { "id": "…", "name": "发版小组" },
  "members": [{ "name": "Mira", "role": "设计", "description": "…", "status": "working" }],
  "messages": [{ "seq": 1199, "sender": "Alex", "text": "…" }]
}
```

不提供发言工具，也不提供 Buddy 建群、拉人和踢人的工具。`message_buddy` 不变，仍发到对方的一对一对话。

## 6. 需要改的现有代码

| 位置 | 改动 |
|---|---|
| `src/storage/database.rs`、`src/storage/buddies.rs` | 新表和存取函数 |
| `src/buddy/mod.rs` `configure_start` / `bootstrap` | 识别群 Session，使用 Buddy MCP 策略和对应的启动消息 |
| `src/api/handlers/buddy_mcp.rs` `caller` | 群 Session 也解析到所属 Buddy，并新增 `read_group` |
| `src/buddy/quiet.rs` | 不再写死 `_local`；`group:…:open` 可 quiet，`group:…:must` 不可 |
| `src/buddy/delegations.rs` | `from_session` 是群 Session 时，结果投递回该 Session，而不是当前 Segment |
| `src/buddy/group.rs`（新增） | 成员管理、唤醒、补齐、@ 解析、防循环、Radio 订阅 |
| `src/api/handlers/buddy_groups.rs`（新增） | HTTP API |

换 Agent 不阻塞，也不改 `switch_agent`：下次唤醒时若群 Session 的引擎和 Buddy 当前引擎不同，就新建 Session，写入 `session_id`，并补齐最近 50 条。已结束的旧 Session 保留只读。

## 7. HTTP API

挂在 `/api/v1/buddy-groups`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET / POST | `/buddy-groups` | 列表（含成员、预览、未读）/ 建群（name、buddy_ids） |
| GET / PATCH / DELETE | `/buddy-groups/{id}` | 详情 / 改名 / 解散 |
| POST | `/buddy-groups/{id}/members` | 拉人 |
| DELETE | `/buddy-groups/{id}/members/{buddy_id}` | 踢人 |
| GET / POST | `/buddy-groups/{id}/messages` | 分页读取（`before_seq`、`limit`）/ 发送（text、attachments） |
| POST | `/buddy-groups/{id}/stop` | 停止全部成员 |
| PUT | `/buddy-groups/{id}/pin` | 置顶 |
| POST | `/buddy-groups/{id}/members/{buddy_id}/ask` | Ask again：再次唤醒该成员，模式为 must |

@ 由后端从 text 解析，前端不传。新消息和成员变动经 `RadioEvent::BuddyGroupChanged` 走现有 Radio 连接推送，前端收到后重新拉取；成员状态沿用 `ChatStatus` 和 `Turn` 事件。排序沿用 `PATCH /buddies/order`，Buddy 和群放在同一个顺序里。

## 8. 前端

群聊放在 Buddies 全屏页面内。这个页面不区分 Workbench 或 Orbit，浏览器和桌面应用用的也是同一份前端，因此都能使用。视觉稿：<https://claude.ai/artifact/Mh6gKXRHHM1Q4Kdg45AhGz>。

### 建群

- 侧栏标题的 `+` 改为菜单：New Buddy、New Group。Buddy 少于 2 个时不显示 New Group。
- 弹窗只有群名和成员勾选。至少选 2 个 Buddy。
- 群名可不填，默认用成员名拼接；此后加减成员不自动改名。
- 创建后立即打开群，输入框获得焦点，不发任何欢迎消息，也不启动 Agent。

### 群列表

- `BuddySidebar` 里群和 Buddy 排在同一列表，支持置顶、未读和拖动排序。
- 群头像由前两名成员的头像叠成。预览格式为“发言者: 内容”。
- 右键菜单：Pin to top、Mark as unread、Group settings、Disband…。

### 会话

- 新增 `BuddyGroupConversation`，数据来自公共记录。
- 用户消息用现有气泡。Buddy 消息是头像、名字加纯文本，不用气泡。
- 头部显示成员头像、群名和“3 Buddies · Alex working”。右上角按钮打开群面板。
- 输入框复用 `mentionCandidates`，候选第一项为 @everyone，其后是群成员。消息里的 @ 显示为浅底标签。
- 消息列表底部显示运行状态行，每个工作中的成员一行（“Alex is running tests…”）。有成员工作时，发送按钮变为停止，点击停止全部成员。
- 审批和提问复用 `DelegationRequestCards` 的方式，把成员 Session 的等待请求显示在群里。
- 用户附件保存到公共记录，投递时用 `attachments::store_for_task` 放进收件人的群 Task。

### 消息状态

| 情况 | 显示 |
|---|---|
| 成员变动 | 居中灰字一行 |
| 部分成员 quiet | 回复下方灰字“Kai stayed quiet”，多人合并为一行 |
| 全员 quiet | “Nobody replied · Alex, Kai stayed quiet” |
| 轮次失败 | 红色细条“Kai couldn't finish this turn”，带 Ask again，点击后再次唤醒该成员，模式为 must |
| 等待审批 | 琥珀色审批卡，标明是哪个成员 |
| 预算耗尽 | 居中灰字“Buddies paused after 6 hand-offs. Send a message to continue.” |

quiet 记录保存为 `sender_kind = 'quiet'` 的消息，刷新后仍能显示，但补齐时跳过，不发给任何 Buddy。

### 群面板

- 使用现有右侧面板，单页不分标签：群名、成员列表、Disband group。
- 群名失焦保存。
- 成员行显示头像、名字、角色、状态。`…` 菜单：Open chat、Remove from group。
- Add 打开搜索弹层，列出未入群的 Buddy，点击立即加入。底部提示新成员能看到最近 50 条消息。
- 移除空闲成员不需确认，因为可以再拉回来。成员工作中时先确认，因为这会中止它的当前轮次。
- Disband 需要确认，文案说明历史保留在各 Buddy 的 Project 里。

手机上沿用现有方式：群面板是底部 Sheet，列表项支持滑动手势。

### Mini 窗口

仅桌面应用。群头部增加和 Buddy 相同的 mini 按钮。窗口仍然只有一个，打开群会替换当前对话，反之亦然。

- **打开：** 按钮打开的是收起的头像，点击头像才展开。切换对话时也回到收起。`buddy_mini_open` 的参数不变，群用 `group:<id>` 作为 id 传入。
- **展开：** 尺寸和窗口行为不变，内容复用 `BuddyGroupConversation`，使用现有的紧凑样式。头部显示叠放头像和群名，切换列表里群排在 Buddy 前面。
- **返回主窗口：** 箭头回到对应的群。
- **收起：** 56px 头像换成两个成员的叠放头像，保持可拖动。

收起时的状态按优先级显示一个：

| 优先级 | 情况 | 显示 |
|---|---|---|
| 1 | 有成员等待审批 | 琥珀色气泡“Alex needs your approval” |
| 2 | 有新回复 | 只显示最新一条“Mira: …”，同一批的其他回复合并为 `+2` |
| 3 | 有成员工作中 | 输入中的三个点 |
| 4 | 有未读 | 头像右上角的小圆点 |

回复气泡显示时长和悬停暂停沿用现有规则。quiet 和 system 消息不弹气泡。点击气泡展开窗口。

## 9. 实现顺序

1. 表结构、存储函数、成员管理和 HTTP API（不接 Agent）。
2. 群 Session 接入 Buddy：`configure_start`、`caller`、`bootstrap`。
3. 唤醒、补齐、发言、@ 解析、防循环。
4. `stay_quiet`、`read_group`、委派回传和换 Agent。
5. 前端列表、会话、成员管理和状态行。
6. Mini 窗口。

每步都带单测。第 3 步必须覆盖：补齐不漏不重、忙时合并、Buddy 不带 @ 不唤醒、预算耗尽停止。

## 10. 第一版不做

- IM Connect 绑定群、TUI。
- Buddy 自己建群或管理成员。
- Buddy 之间在群里传文件。第一版在回复里写路径，能否读取取决于 Agent 自身的沙箱。
- 未被 @ 的 Buddy 主动插嘴。

## 11. 已确认

1. 不带 @ 的用户消息等同 @everyone，Buddy 按话题相关度决定是否回复。
2. @everyone 并行发言，接受可能出现重复。
3. 只有用户能建群和管理成员。
