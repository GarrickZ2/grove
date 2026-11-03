//! Turn progress as one editable chat message, for platforms that can edit
//! messages but have no card entities (Telegram, Slack). Implements the
//! `ConnectAdapter` turn-card contract on top of plain post/edit calls:
//! `create` only reserves an id, `send` posts the message, `update`/`replace`
//! edit it. A final answer longer than one message overflows into follow-ups.
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use async_trait::async_trait;

use super::{
    adapter::TurnView,
    markdown,
    progress::{TurnBlock, TurnTool},
};

/// Tools listed per group; earlier ones collapse into a count.
const TOOLS_SHOWN: usize = 6;
/// Cards whose turn never finished are dropped after this many newer ones.
const MAX_CARDS: usize = 64;

// async_trait emits #[must_use] on boxed futures; see ConnectAdapter.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait TurnMessages: Send + Sync {
    /// Largest Markdown source that still fits one message after rendering.
    fn max_bytes(&self) -> usize;
    /// Minimum spacing between progress edits (finals are never delayed).
    fn edit_interval(&self) -> Duration;
    /// Posts a message replying to `parent`; returns its id.
    async fn post(&self, parent: &str, markdown: &str) -> Result<String, String>;
    /// Replaces a message's content. Unchanged content must not be an error.
    async fn edit(&self, message_id: &str, markdown: &str) -> Result<(), String>;
}

struct Card {
    view: TurnView,
    parent: String,
    message: Option<String>,
    /// Final-answer overflow messages already posted (retries skip them).
    overflow_sent: usize,
    last_edit: Option<Instant>,
    created: Instant,
}

#[derive(Default)]
pub struct TurnCards(Mutex<HashMap<String, Card>>);

fn icon(tool: &TurnTool) -> &'static str {
    match tool.status.as_str() {
        "completed" => "✓",
        "failed" => "✗",
        _ => "⋯",
    }
}

fn status_line(status: &str) -> String {
    match status {
        "Responding" => "✍️ Responding…".into(),
        "Running tools" => "🛠 Running tools…".into(),
        "Waiting for permission" => "✋ Waiting for permission".into(),
        "Waiting for input" => "📝 Waiting for input".into(),
        other => format!("⏳ {other}…"),
    }
}

/// The message chunks for a view: the whole final answer, or one progress
/// message showing the latest tail of the turn.
pub fn render(view: &TurnView, max_bytes: usize) -> Vec<String> {
    if let Some(output) = &view.final_output {
        let chunks = markdown::chunk(output, max_bytes);
        return if chunks.is_empty() {
            vec!["Agent completed without a text response.".into()]
        } else {
            chunks
        };
    }
    let mut body = String::new();
    for block in &view.blocks {
        match block {
            TurnBlock::Text(text) => {
                body.push_str(text.trim());
                body.push_str("\n\n");
            }
            TurnBlock::Tools { count, ids } => {
                let tools: Vec<_> = ids
                    .iter()
                    .filter_map(|id| view.tools.iter().find(|tool| &tool.id == id))
                    .collect();
                let hidden = count.saturating_sub(TOOLS_SHOWN.min(tools.len()));
                if hidden > 0 {
                    body.push_str(&format!("… {hidden} earlier tool calls\n"));
                }
                for tool in tools.iter().skip(tools.len().saturating_sub(TOOLS_SHOWN)) {
                    // Titles are agent text; keep them out of Markdown markup.
                    let title = tool.title.replace(['`', '*', '~', '[', ']'], "");
                    body.push_str(&format!("{} {}\n", icon(tool), title.trim()));
                }
                body.push('\n');
            }
        }
    }
    let header = status_line(&view.status);
    let budget = max_bytes.saturating_sub(header.len() + 8);
    // chunk() keeps fences balanced, so the tail renders on its own.
    let mut tail = markdown::chunk(body.trim(), budget)
        .pop()
        .unwrap_or_default();
    if tail.len() < body.trim().len() {
        tail = format!("…\n{tail}");
    }
    vec![if tail.is_empty() {
        header
    } else {
        format!("{header}\n\n{tail}")
    }]
}

impl TurnCards {
    pub fn create(&self, view: &TurnView) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let mut cards = self.0.lock().unwrap();
        if cards.len() >= MAX_CARDS {
            if let Some(oldest) = cards
                .iter()
                .min_by_key(|(_, card)| card.created)
                .map(|(id, _)| id.clone())
            {
                cards.remove(&oldest);
            }
        }
        cards.insert(
            id.clone(),
            Card {
                view: view.clone(),
                parent: String::new(),
                message: None,
                overflow_sent: 0,
                last_edit: None,
                created: Instant::now(),
            },
        );
        id
    }

    pub async fn send<T: TurnMessages>(
        &self,
        channel: &T,
        parent: &str,
        card_id: &str,
    ) -> Result<String, String> {
        let view = {
            let cards = self.0.lock().unwrap();
            let card = cards.get(card_id).ok_or("Turn message expired")?;
            if let Some(message) = &card.message {
                return Ok(message.clone());
            }
            card.view.clone()
        };
        let first = render(&view, channel.max_bytes()).remove(0);
        let message = channel.post(parent, &first).await?;
        if let Some(card) = self.0.lock().unwrap().get_mut(card_id) {
            card.parent = parent.into();
            card.message = Some(message.clone());
            card.last_edit = Some(Instant::now());
        }
        if view.final_output.is_some() {
            self.finish(channel, card_id, &view).await?;
        }
        Ok(message)
    }

    pub async fn update<T: TurnMessages>(
        &self,
        channel: &T,
        card_id: &str,
        view: &TurnView,
    ) -> Result<(), String> {
        let (message, last_edit) = {
            let mut cards = self.0.lock().unwrap();
            let card = cards.get_mut(card_id).ok_or("Turn message expired")?;
            card.view = view.clone();
            (card.message.clone(), card.last_edit)
        };
        // Not posted yet: `send` will post the latest view.
        let Some(message) = message else {
            return Ok(());
        };
        if view.final_output.is_some() {
            return self.finish(channel, card_id, view).await;
        }
        if let Some(wait) =
            last_edit.and_then(|at| channel.edit_interval().checked_sub(at.elapsed()))
        {
            tokio::time::sleep(wait).await;
        }
        let chunks = render(view, channel.max_bytes());
        channel.edit(&message, &chunks[0]).await?;
        if let Some(card) = self.0.lock().unwrap().get_mut(card_id) {
            card.last_edit = Some(Instant::now());
        }
        Ok(())
    }

    /// Fallback when a final update failed: edit by message id.
    pub async fn replace<T: TurnMessages>(
        &self,
        channel: &T,
        message_id: &str,
        view: &TurnView,
    ) -> Result<(), String> {
        let card_id = self
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|(_, card)| card.message.as_deref() == Some(message_id))
            .map(|(id, _)| id.clone());
        match card_id {
            Some(card_id) => self.finish(channel, &card_id, view).await,
            None => {
                let chunks = render(view, channel.max_bytes());
                channel.edit(message_id, &chunks[0]).await?;
                for chunk in &chunks[1..] {
                    channel.post("", chunk).await?;
                }
                Ok(())
            }
        }
    }

    async fn finish<T: TurnMessages>(
        &self,
        channel: &T,
        card_id: &str,
        view: &TurnView,
    ) -> Result<(), String> {
        let (message, parent, sent) = {
            let cards = self.0.lock().unwrap();
            let card = cards.get(card_id).ok_or("Turn message expired")?;
            (
                card.message.clone().ok_or("Turn message not posted")?,
                card.parent.clone(),
                card.overflow_sent,
            )
        };
        let chunks = render(view, channel.max_bytes());
        channel.edit(&message, &chunks[0]).await?;
        for (index, chunk) in chunks.iter().enumerate().skip(1 + sent) {
            channel.post(&parent, chunk).await?;
            if let Some(card) = self.0.lock().unwrap().get_mut(card_id) {
                card.overflow_sent = index;
            }
        }
        self.0.lock().unwrap().remove(card_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        calls: Mutex<Vec<String>>,
        fail_posts_after: Mutex<Option<usize>>,
    }

    #[async_trait]
    impl TurnMessages for Recorder {
        fn max_bytes(&self) -> usize {
            200
        }
        fn edit_interval(&self) -> Duration {
            Duration::ZERO
        }
        async fn post(&self, parent: &str, markdown: &str) -> Result<String, String> {
            let mut calls = self.calls.lock().unwrap();
            let posts = calls.iter().filter(|call| call.starts_with("post")).count();
            if self
                .fail_posts_after
                .lock()
                .unwrap()
                .is_some_and(|limit| posts >= limit)
            {
                return Err("rate limited".into());
            }
            calls.push(format!("post {parent}: {markdown}"));
            Ok(format!("m{}", posts + 1))
        }
        async fn edit(&self, message_id: &str, markdown: &str) -> Result<(), String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("edit {message_id}: {markdown}"));
            Ok(())
        }
    }

    fn tool(id: &str, status: &str) -> TurnTool {
        TurnTool {
            id: id.into(),
            name: None,
            title: format!("Read `{id}`"),
            status: status.into(),
        }
    }

    #[test]
    fn progress_shows_status_commentary_and_recent_tools() {
        let ids: Vec<String> = (0..8).map(|index| format!("t{index}")).collect();
        let view = TurnView {
            status: "Running tools".into(),
            text: "Looking".into(),
            tools: ids.iter().map(|id| tool(id, "completed")).collect(),
            blocks: vec![
                TurnBlock::Text("Looking around".into()),
                TurnBlock::Tools {
                    count: 8,
                    ids: ids.clone(),
                },
            ],
            final_output: None,
        };
        let rendered = render(&view, 3000);
        assert_eq!(rendered.len(), 1);
        let text = &rendered[0];
        assert!(text.starts_with("🛠 Running tools…\n\nLooking around"));
        assert!(text.contains("… 2 earlier tool calls"));
        assert!(text.contains("✓ Read t7") && !text.contains("Read t1\n"));
        let long = TurnView {
            blocks: vec![TurnBlock::Text(format!("```\n{}", "line\n".repeat(200)))],
            ..TurnView::default()
        };
        let tail = &render(&long, 300)[0];
        assert!(tail.len() <= 300);
        // The cut code block is reopened, so the tail still renders as code.
        assert!(tail.contains("…\n```\nline"), "{tail}");
    }

    #[tokio::test]
    async fn final_answer_edits_the_card_and_overflows_once_across_retries() {
        let channel = Recorder::default();
        let cards = TurnCards::default();
        let id = cards.create(&TurnView::default());
        let message = cards.send(&channel, "user-1", &id).await.unwrap();
        assert_eq!(message, "m1");
        cards
            .update(
                &channel,
                &id,
                &TurnView {
                    status: "Responding".into(),
                    blocks: vec![TurnBlock::Text("Half".into())],
                    ..TurnView::default()
                },
            )
            .await
            .unwrap();
        let answer = "word ".repeat(100);
        let done = TurnView {
            final_output: Some(answer.clone()),
            ..TurnView::default()
        };
        *channel.fail_posts_after.lock().unwrap() = Some(2);
        assert!(cards.update(&channel, &id, &done).await.is_err());
        *channel.fail_posts_after.lock().unwrap() = None;
        cards.update(&channel, &id, &done).await.unwrap();
        let calls = channel.calls.lock().unwrap().clone();
        let posts: Vec<_> = calls
            .iter()
            .filter(|call| call.starts_with("post"))
            .collect();
        let chunks = render(&done, 200);
        // Card post + every overflow chunk exactly once.
        assert_eq!(posts.len(), chunks.len());
        assert!(posts[1].starts_with("post user-1: "));
        assert!(calls.contains(&format!("edit m1: {}", chunks[0])));
        assert!(
            cards.update(&channel, &id, &done).await.is_err(),
            "card is released"
        );
    }

    #[tokio::test]
    async fn a_final_view_before_posting_is_sent_complete() {
        let channel = Recorder::default();
        let cards = TurnCards::default();
        let id = cards.create(&TurnView::default());
        cards
            .update(
                &channel,
                &id,
                &TurnView {
                    final_output: Some("Done".into()),
                    ..TurnView::default()
                },
            )
            .await
            .unwrap();
        cards.send(&channel, "user-1", &id).await.unwrap();
        let calls = channel.calls.lock().unwrap().clone();
        assert_eq!(calls[0], "post user-1: Done");
    }
}
