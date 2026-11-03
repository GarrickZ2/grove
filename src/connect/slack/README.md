# Slack Connect

Built-in adapter for a Slack app the user creates in their workspace, over
Socket Mode (an outbound WebSocket, so Grove needs no public URL).

## Setup

Open IM Connect, add a connection, and select Slack. The setup page links to
Slack's "create app from manifest" with Grove's manifest prefilled (DMs,
`message.im`, interactivity, the `/grove` slash command, Socket Mode). After
installing the app, paste the Bot User OAuth Token (`xoxb-`) and an
App-Level Token with `connections:write` (`xapp-`). Grove checks both
(`auth.test`, opening a socket) and shows a one-time code. The Slack user who
sends that code to the app in a DM becomes the owner; only that user's DM is
served. **Connect Slack again** renews tokens and requires the same user.

## Interaction

Slack's client treats any message starting with `/` as a command, so Grove
commands are typed as `/grove <command>` (`/grove new`, `/grove target
project 2`, …); command hints in replies are rewritten to that form. Menus
and forms use the shared text UI; its options become Block Kit buttons that
replay the same text command. Pressed buttons are removed from the message.

Each agent turn is one live message (`connect/turn_text.rs`): posted when the
turn starts, edited at most every two seconds (`chat.update` is Tier 3) with
the status, recent commentary and tool calls, then replaced by the final
answer, which continues in follow-up messages when long.

Replies are Markdown converted to mrkdwn and posted top-level in the DM.
Status uses reactions (`:eyes:` waiting, `:hourglass_flowing_sand:`
working). Text and files (≤ 20 MB, downloaded only from `files.slack.com`)
reach the agent.

## Recovery

The socket reader acknowledges every envelope immediately and a worker
handles them in order, so slow deliveries never exceed Slack's 3-second ack
window. Slack-requested disconnects reconnect at once; failures back off.
Redelivered events are dropped by message `ts`. A revoked token stops the
connection with an error.
