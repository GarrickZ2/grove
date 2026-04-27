//! Spec §6 注入格式：构造 agent-to-agent 注入消息的可见前缀。
//!
//! 这是给被注入方 AI 看的人类可读上下文。canonical sender 身份另由
//! `AcpCommand::Prompt.sender = Some("agent:<chat_id>")` / `QueuedMessage.sender`
//! 表达，前端 / 存储层用后者，prefix 仅是 prompt body 的一部分。

#[derive(Debug, Clone, Copy)]
pub enum InjectKind {
    Send,
    Reply,
}

impl InjectKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Send => "send",
            Self::Reply => "reply",
        }
    }
}

/// Build the prompt body that gets injected into the recipient's session.
///
/// For `Send` we append a footer telling the receiving agent how to respond
/// via the MCP `grove_agent_reply` tool, including the `msg_id` it must echo
/// back. The footer is omitted for `Reply` (the original sender doesn't owe a
/// reply back) and when `msg_id` is `None`.
///
/// Format:
/// ```text
/// [from:<sender_name> · session=<sender_chat_id> · kind=<send|reply>[ · msg_id=<id>]]
///
/// <body>
///
/// — Reply with the MCP tool `grove_agent_reply` using msg_id="<id>".
/// ```
pub fn build_injected_prompt(
    sender_chat_id: &str,
    sender_name: &str,
    kind: InjectKind,
    body: &str,
    msg_id: Option<&str>,
) -> String {
    let header = match (kind, msg_id) {
        (InjectKind::Send, Some(id)) => format!(
            "[from:{name} · session={sid} · kind=send · msg_id={id}]",
            name = sender_name,
            sid = sender_chat_id,
        ),
        (kind, _) => format!(
            "[from:{name} · session={sid} · kind={k}]",
            name = sender_name,
            sid = sender_chat_id,
            k = kind.as_str(),
        ),
    };

    let footer = match (kind, msg_id) {
        (InjectKind::Send, Some(id)) => format!(
            "\n\n— To reply, call the MCP tool `grove_agent_reply` with msg_id=\"{id}\". \
             Do not reply by sending a new message; replies are routed by msg_id."
        ),
        _ => String::new(),
    };

    format!("{header}\n\n{body}{footer}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_send_prefix_with_msg_id() {
        let s = build_injected_prompt(
            "chat-aaa",
            "Frontend",
            InjectKind::Send,
            "hi",
            Some("msg-1"),
        );
        assert!(s.starts_with("[from:Frontend · session=chat-aaa · kind=send · msg_id=msg-1]"));
        assert!(s.contains("\n\nhi"));
        assert!(s.contains("grove_agent_reply"));
        assert!(s.contains("msg_id=\"msg-1\""));
    }

    #[test]
    fn build_send_prefix_without_msg_id_omits_footer() {
        let s = build_injected_prompt("chat-aaa", "Frontend", InjectKind::Send, "hi", None);
        assert_eq!(s, "[from:Frontend · session=chat-aaa · kind=send]\n\nhi");
    }

    #[test]
    fn build_reply_prefix_no_footer() {
        let s = build_injected_prompt(
            "chat-bbb",
            "Backend",
            InjectKind::Reply,
            "done",
            Some("msg-1"),
        );
        assert_eq!(s, "[from:Backend · session=chat-bbb · kind=reply]\n\ndone");
    }
}
