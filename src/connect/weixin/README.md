# WeChat Connect

Built-in personal WeChat / ClawBot adapter for Tencent's iLink API. The wire
compatibility baseline is [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
2.4.10. This is separate from WeCom and Official Accounts.

## Setup

Open IM Connect, add a connection, and select WeChat. Scan with WeChat and
confirm. If the service asks for a verification code, enter the digits shown
in WeChat. Select the Grove Project, Task, and Session after authorization.
Manual setup accepts `bot_token`, `bot_id`, `user_id`, and an optional
`base_url` (default `https://ilinkai.weixin.qq.com`). Credentials and redirects
are restricted to HTTPS origins under `weixin.qq.com`.

Only the authorizing user's private messages are accepted. A connection maps
to one current Grove target. Token expiration stops the transport and reports
an error; use **Authorize WeChat again** to renew the same connection. Renewal
requires the original user and preserves the current name, enabled state,
target, and ownership.

## Text interactions

- `/new` lists agents; `/new <agent_id>` creates and starts a session.
- `/target` shows the current target and available subcommands.
- `/target project` lists projects. `/target project <number-or-id>` stages a
  project and immediately lists its tasks. Selecting a task immediately lists
  its sessions. Selecting a session commits the entire target. Session `0`
  selects automatic creation on the first prompt.
- `/target task` and `/target session` start from the corresponding current
  parent. Unrelated messages or commands cancel unfinished target selections.
  Menus also expire after 15 minutes or a target change.
- `/config` lists the session's available configuration. `/config model`
  displays its options; `/config model <number-or-id>` applies a choice. Other
  selector names are supplied dynamically by the agent.
- `/respond <request-id> <number-or-id>` answers a permission request.
- `/answer <request-id> <field-id> <answer>` stages a form answer. Multiple
  choices use comma-separated numbers or IDs; booleans use `true`/`false`.
  `/submit <request-id>` submits; `/decline <request-id>` declines.
- `/help` lists the available commands. Ordinary messages use Grove's existing
  session delivery and queue.

## Boundaries and recovery

This directory owns iLink HTTP, QR flow/code submission, connection workers,
private-message filtering, reply context, checkpoints, text presentation, and
secondary-command drafts. Grove's message core, session delivery, and command
semantics remain shared. Feishu retains native cards. Platform lifecycle hooks
and registration HTTP endpoints dispatch generically to the owning adapter.

The matching frontend adapter lives in
`grove-web/src/components/Config/ConnectAdapters/WeixinAdapter.tsx`. Shared
settings manage connection records and targets; frontend adapters own their
authorization instructions, inputs, and platform settings. QR layout and
credential fields are reusable visual components.

Transport checkpoints live under `~/.grove/connect/weixin/<connection-id>.json`
with owner-only file permissions on Unix. A fetched batch and cursor are saved
before delivery; completed message IDs and each message's individual reply
context are retained in a bounded window. A changed credential resets the
checkpoint. Corrupt state stops the worker instead of silently discarding it.
There is no durable Grove submission receipt: a crash between submission and
checkpoint completion may replay a message. Outbound requests are not blindly
retried after an ambiguous network failure.

## Validation and current scope

Automated checks cover HTTP headers/body and API errors, private-user filtering,
large message IDs, Unicode splitting, checkpoint recovery, staged target/config
interactions, permissions/forms, registration ownership and cancellation, and
frontend authorization races.

Real-account QR login and message round trips still require integration
validation. This version supports text and voice transcriptions supplied by
WeChat. CDN media download/upload, raw voice, images/files, group chat, and
native interactive cards are outside this version's scope.
