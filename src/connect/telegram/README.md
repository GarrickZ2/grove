# Telegram Connect

Built-in adapter for a Telegram bot the user owns, over the Bot API
(`getUpdates` long polling, so Grove needs no public URL).

## Setup

Open IM Connect, add a connection, and select Telegram. Create a bot with
@BotFather (`/newbot`) and paste its token. Grove checks the token
(`getMe`), removes any webhook (polling and webhooks are exclusive, and the
bot is dedicated to Grove), and shows a one-time `t.me/<bot>?start=<code>`
link and QR. The account that presses **Start** becomes the owner; only that
account's private chat is served. **Connect Telegram again** renews the token
and requires the same account.

## Interaction

Menus and forms use the shared text UI (`connect/text_ui.rs`). Every option
it lists is also an inline keyboard button; a button replays the same text
command, so typed and tapped choices are validated identically. Buttons are
single-use: the keyboard is removed when pressed. `callback_data` only holds
a short token (Telegram limits it to 64 bytes); the command stays in memory
for 15 minutes. `/start` (with or without a payload) is treated as `/help`.

Each agent turn is one live message (`connect/turn_text.rs`): it is posted
when the turn starts and edited at most once a second with the status, recent
commentary and tool calls, then replaced by the final answer. An answer longer
than one message continues in follow-up messages.

Replies are Markdown converted to Telegram HTML (headings, bold, strike,
inline and fenced code, links); if Telegram refuses the entities the chunk is
resent as plain text. Status uses message reactions (👀 waiting, 👨‍💻 working)
plus a typing indicator. Text, photos, documents, voice and audio (≤ 20 MB,
the Bot API download limit) reach the agent; stickers, video and other
content get a notice.

## Recovery

`~/.grove/connect/telegram/<connection-id>.json` (owner-only on Unix) keeps
the last processed `update_id`, so a restart does not replay delivered
prompts. A changed bot resets it. A crash between delivery and the checkpoint
may replay one update. A revoked token stops the connection with an error.
