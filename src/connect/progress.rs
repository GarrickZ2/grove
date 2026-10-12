//! One latest-state slot per turn: network backpressure never queues tokens.
use std::time::Duration;

use tokio::sync::watch;
use tokio::time::Instant;

use super::adapter::AdapterRef;

const UPDATE_INTERVAL: Duration = Duration::from_secs(1);
const MAX_TOOLS: usize = 32;
const MAX_PROGRESS_BYTES: usize = 6000;
// Bound the ordered public commentary and tool summaries in each snapshot.
const MAX_BLOCKS: usize = 32;

#[derive(Clone, Debug)]
pub struct TurnTool {
    pub id: String,
    pub title: String,
    pub status: String,
}

#[derive(Clone, Debug)]
pub enum TurnBlock {
    Text(String),
    Tools { count: usize, ids: Vec<String> },
}

#[derive(Clone, Debug)]
pub struct TurnView {
    pub status: String,
    pub text: String,
    pub tools: Vec<TurnTool>,
    /// Ordered public commentary and consecutive groups of tool calls.
    pub blocks: Vec<TurnBlock>,
    pub final_output: Option<String>,
}

impl Default for TurnView {
    fn default() -> Self {
        Self {
            status: "Working".into(),
            text: String::new(),
            tools: Vec::new(),
            blocks: Vec::new(),
            final_output: None,
        }
    }
}

fn bound_blocks(blocks: &mut Vec<TurnBlock>) {
    if blocks.len() > MAX_BLOCKS {
        blocks.drain(..blocks.len() - MAX_BLOCKS);
    }
    let mut remaining = MAX_PROGRESS_BYTES;
    for block in blocks.iter_mut().rev() {
        if let TurnBlock::Text(text) = block {
            keep_tail(text, remaining);
            remaining -= text.len();
        }
    }
    blocks.retain(|block| !matches!(block, TurnBlock::Text(text) if text.is_empty()));
}

fn keep_tail(text: &mut String, limit: usize) {
    if text.len() > limit {
        let mut start = text.len() - limit;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        text.drain(..start);
    }
}

#[derive(Clone)]
pub(crate) struct TurnProgress(watch::Sender<TurnView>);

impl TurnProgress {
    pub fn start(adapter: AdapterRef, message_id: String) -> Self {
        let (tx, rx) = watch::channel(TurnView::default());
        tokio::spawn(deliver(adapter, message_id, rx));
        Self(tx)
    }

    pub fn message(&self, text: &str) {
        self.0.send_modify(|view| {
            if view.final_output.is_some() {
                return;
            }
            view.status = "Responding".into();
            view.text.push_str(text);
            keep_tail(&mut view.text, MAX_PROGRESS_BYTES);
            match view.blocks.last_mut() {
                Some(TurnBlock::Text(content)) => content.push_str(text),
                _ if !text.is_empty() => view.blocks.push(TurnBlock::Text(text.to_owned())),
                _ => {}
            }
            bound_blocks(&mut view.blocks);
        });
    }

    pub fn tool(&self, id: &str, title: Option<&str>, status: Option<&str>) {
        self.0.send_modify(|view| {
            if view.final_output.is_some() {
                return;
            }
            if let Some(title) = title {
                if !view.tools.iter().any(|tool| tool.id == id) {
                    if view.tools.len() == MAX_TOOLS {
                        view.tools.remove(0);
                    }
                    view.tools.push(TurnTool {
                        id: id.to_owned(),
                        title: title.chars().take(200).collect(),
                        status: "in_progress".into(),
                    });
                    match view.blocks.last_mut() {
                        Some(TurnBlock::Tools { count, ids }) => {
                            *count += 1;
                            if ids.len() == MAX_TOOLS {
                                ids.remove(0);
                            }
                            ids.push(id.to_owned());
                        }
                        _ => view.blocks.push(TurnBlock::Tools {
                            count: 1,
                            ids: vec![id.to_owned()],
                        }),
                    }
                    bound_blocks(&mut view.blocks);
                }
            }
            if let Some(tool) = view.tools.iter_mut().find(|tool| tool.id == id) {
                if let Some(title) = title {
                    tool.title = title.chars().take(200).collect();
                }
                if let Some(status) = status {
                    tool.status = status.to_owned();
                }
            }
            view.status = if view
                .tools
                .iter()
                .any(|tool| matches!(tool.status.as_str(), "pending" | "in_progress"))
            {
                "Running tools"
            } else {
                "Working"
            }
            .into();
        });
    }

    pub fn status(&self, status: &str) {
        self.0.send_modify(|view| {
            if view.final_output.is_none() {
                view.status = status.into();
            }
        });
    }

    pub fn finish(&self, text: &str) {
        self.0.send_modify(|view| {
            if view.final_output.is_none() {
                // Terminal state is sticky. Late process events cannot restore it.
                *view = TurnView {
                    final_output: Some(text.into()),
                    ..TurnView::default()
                };
            }
        });
    }
}

async fn deliver(adapter: AdapterRef, parent: String, mut rx: watch::Receiver<TurnView>) {
    let uuid = uuid::Uuid::new_v4().to_string();
    let mut card_id: Option<String> = None;
    let mut message_id: Option<String> = None;
    let mut sequence = 0;
    let mut next_update = Instant::now();
    let mut first = true;
    loop {
        if !first && rx.changed().await.is_err() {
            return;
        }
        first = false;
        tokio::time::sleep_until(next_update).await;
        // Read AFTER throttling, so a final output supersedes pending progress.
        let view = rx.borrow_and_update().clone();
        let attempts = if view.final_output.is_some() { 3 } else { 1 };
        let mut delivered = false;
        for attempt in 0..attempts {
            if attempt > 0 {
                tokio::time::sleep_until(next_update).await;
            }
            let result = async {
                if let Some(id) = &card_id {
                    sequence += 1; // Failed attempts also consume a sequence.
                    adapter.update_turn_card(id, &view, sequence).await?;
                } else {
                    card_id = Some(adapter.create_turn_card(&view).await?);
                }
                if message_id.is_none() {
                    message_id = Some(
                        adapter
                            .send_turn_card(&parent, card_id.as_deref().unwrap(), &uuid)
                            .await?,
                    );
                }
                Ok::<_, String>(())
            }
            .await;
            next_update = Instant::now() + UPDATE_INTERVAL;
            match result {
                Ok(()) => {
                    delivered = true;
                    break;
                }
                Err(error) => eprintln!("[connect] turn card update failed: {error}"),
            }
        }
        if let Some(output) = &view.final_output {
            if !delivered {
                // Try the independent IM message update endpoint before falling
                // back to the existing final-text delivery path.
                if let Some(id) = &message_id {
                    for _ in 0..3 {
                        tokio::time::sleep_until(next_update).await;
                        let result = adapter.replace_turn_card(id, &view).await;
                        next_update = Instant::now() + UPDATE_INTERVAL;
                        match result {
                            Ok(()) => {
                                delivered = true;
                                break;
                            }
                            Err(error) => {
                                eprintln!("[connect] final card replacement failed: {error}");
                            }
                        }
                    }
                }
                if !delivered {
                    if let Err(error) = adapter.reply_text(&parent, output).await {
                        eprintln!("[connect] failed to deliver final reply: {error}");
                    }
                }
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{adapter::ConnectAdapter, commands::CardSpec};
    use super::*;
    use async_trait::async_trait;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::mpsc;

    #[test]
    fn commentary_survives_tools_and_tool_updates_do_not_increment_group_counts() {
        let (tx, _rx) = watch::channel(TurnView::default());
        let progress = TurnProgress(tx);
        progress.message("First message");
        progress.tool("read", Some("Read notes"), Some("in_progress"));
        progress.tool("search", Some("Search files"), Some("in_progress"));
        progress.tool("read", None, Some("completed"));
        progress.message("Found something");
        progress.tool("search", None, Some("completed"));
        progress.tool("check", Some("Check"), Some("in_progress"));
        let view = progress.0.borrow().clone();
        assert_eq!(view.text, "First messageFound something");
        assert_eq!(view.blocks.len(), 4);
        assert!(matches!(&view.blocks[0], TurnBlock::Text(text) if text == "First message"));
        assert!(
            matches!(&view.blocks[1], TurnBlock::Tools { count: 2, ids } if ids == &["read", "search"])
        );
        assert!(matches!(&view.blocks[2], TurnBlock::Text(text) if text == "Found something"));
        assert!(matches!(&view.blocks[3], TurnBlock::Tools { count: 1, .. }));
        progress.finish("Final answer");
        assert!(progress.0.borrow().blocks.is_empty());
        progress.message("late text");
        progress.tool("late", Some("Late tool"), None);
        assert!(progress.0.borrow().blocks.is_empty());
    }

    struct Call {
        kind: &'static str,
        view: Option<TurnView>,
        sequence: u32,
        at: Instant,
        uuid: String,
    }

    struct FakeAdapter {
        calls: mpsc::UnboundedSender<Call>,
        fail_updates: AtomicUsize,
        fail_sends: AtomicUsize,
        fail_creates: AtomicUsize,
    }

    fn fails(counter: &AtomicUsize) -> bool {
        counter
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
                value.checked_sub(1)
            })
            .is_ok()
    }

    impl FakeAdapter {
        fn call(&self, kind: &'static str, view: Option<TurnView>, sequence: u32, uuid: &str) {
            self.calls
                .send(Call {
                    kind,
                    view,
                    sequence,
                    at: Instant::now(),
                    uuid: uuid.into(),
                })
                .unwrap();
        }
    }

    #[async_trait]
    impl ConnectAdapter for FakeAdapter {
        async fn mark_waiting(&self, _: &str) -> Option<String> {
            None
        }
        async fn mark_working(&self, _: &str, _: &Option<String>) -> Option<String> {
            None
        }
        async fn clear_status(&self, _: &str, _: &Option<String>) {}
        async fn reply_text(&self, _: &str, text: &str) -> Result<(), String> {
            self.call(
                "text",
                Some(TurnView {
                    final_output: Some(text.into()),
                    ..TurnView::default()
                }),
                0,
                "",
            );
            Ok(())
        }
        async fn reply_card(&self, _: &str, _: &CardSpec) -> Result<(), String> {
            Ok(())
        }
        async fn create_turn_card(&self, view: &TurnView) -> Result<String, String> {
            self.call("create", Some(view.clone()), 0, "");
            if fails(&self.fail_creates) {
                Err("temporary create error".into())
            } else {
                Ok("card".into())
            }
        }
        async fn send_turn_card(&self, _: &str, id: &str, uuid: &str) -> Result<String, String> {
            assert_eq!(id, "card");
            self.call("send", None, 0, uuid);
            if fails(&self.fail_sends) {
                Err("temporary send error".into())
            } else {
                Ok("message".into())
            }
        }
        async fn update_turn_card(
            &self,
            id: &str,
            view: &TurnView,
            sequence: u32,
        ) -> Result<(), String> {
            assert_eq!(id, "card");
            self.call("update", Some(view.clone()), sequence, "");
            if fails(&self.fail_updates) {
                Err("temporary update error".into())
            } else {
                Ok(())
            }
        }
        async fn replace_turn_card(&self, _: &str, view: &TurnView) -> Result<(), String> {
            self.call("replace", Some(view.clone()), 0, "");
            Ok(())
        }
    }

    fn setup(
        creates: usize,
        sends: usize,
        updates: usize,
    ) -> (TurnProgress, mpsc::UnboundedReceiver<Call>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let adapter = Arc::new(FakeAdapter {
            calls: tx,
            fail_creates: AtomicUsize::new(creates),
            fail_sends: AtomicUsize::new(sends),
            fail_updates: AtomicUsize::new(updates),
        });
        (TurnProgress::start(adapter, "parent".into()), rx)
    }

    async fn recv(rx: &mut mpsc::UnboundedReceiver<Call>) -> Call {
        tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }

    async fn started(rx: &mut mpsc::UnboundedReceiver<Call>) -> Call {
        assert_eq!(recv(rx).await.kind, "create");
        let send = recv(rx).await;
        assert_eq!(send.kind, "send");
        send
    }

    #[tokio::test]
    async fn burst_is_coalesced_and_final_supersedes_pending_progress() {
        let (progress, mut rx) = setup(0, 0, 0);
        let sent = started(&mut rx).await;
        progress.message("interim ");
        progress.message("commentary");
        progress.tool("tool", Some("Search files"), Some("in_progress"));
        progress.finish("Final answer");
        progress.message("late chunk");
        progress.tool("late", Some("late tool"), None);
        let final_call = recv(&mut rx).await;
        assert_eq!(final_call.kind, "update");
        assert!(final_call.at.duration_since(sent.at) >= UPDATE_INTERVAL);
        let view = final_call.view.unwrap();
        assert_eq!(view.final_output.as_deref(), Some("Final answer"));
        assert!(view.tools.is_empty());
        assert!(view.text.is_empty());
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn failed_process_update_does_not_stop_later_updates() {
        let (progress, mut rx) = setup(0, 0, 1);
        started(&mut rx).await;
        progress.tool("tool", Some("Search"), Some("in_progress"));
        let failed = recv(&mut rx).await;
        assert_eq!(failed.sequence, 1);
        progress.tool("tool", None, Some("completed"));
        progress.message("Found result");
        let next = recv(&mut rx).await;
        assert_eq!(next.sequence, 2);
        assert!(next.at.duration_since(failed.at) >= UPDATE_INTERVAL);
        let view = next.view.unwrap();
        assert_eq!(view.tools[0].status, "completed");
        assert_eq!(view.text, "Found result");
        progress.finish("Done");
        assert_eq!(
            recv(&mut rx).await.view.unwrap().final_output.as_deref(),
            Some("Done")
        );
    }

    #[tokio::test]
    async fn send_retry_reuses_entity_and_idempotency_key() {
        let (progress, mut rx) = setup(0, 1, 0);
        let first_send = started(&mut rx).await;
        progress.message("new progress");
        assert_eq!(recv(&mut rx).await.kind, "update");
        let second_send = recv(&mut rx).await;
        assert_eq!(second_send.kind, "send");
        assert_eq!(second_send.uuid, first_send.uuid);
        progress.finish("Done");
        assert_eq!(recv(&mut rx).await.kind, "update");
    }

    #[tokio::test]
    async fn final_retries_then_replaces_existing_message_without_process() {
        let (progress, mut rx) = setup(0, 0, 99);
        started(&mut rx).await;
        progress.message("old progress");
        progress.finish("Answer");
        for sequence in 1..=3 {
            let call = recv(&mut rx).await;
            assert_eq!(call.kind, "update");
            assert_eq!(call.sequence, sequence);
            assert_eq!(call.view.unwrap().final_output.as_deref(), Some("Answer"));
        }
        let fallback = recv(&mut rx).await;
        assert_eq!(fallback.kind, "replace");
        assert!(fallback.view.unwrap().text.is_empty());
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn create_failure_is_retried_on_later_state() {
        let (progress, mut rx) = setup(1, 0, 0);
        assert_eq!(recv(&mut rx).await.kind, "create");
        progress.message("next progress");
        assert_eq!(recv(&mut rx).await.kind, "create");
        assert_eq!(recv(&mut rx).await.kind, "send");
        progress.finish("Done");
        assert_eq!(recv(&mut rx).await.kind, "update");
    }

    #[tokio::test]
    async fn progress_memory_is_bounded_and_unicode_safe() {
        let (progress, mut rx) = setup(0, 0, 0);
        started(&mut rx).await;
        for n in 0..100 {
            progress.tool(&n.to_string(), Some("Read a file"), Some("completed"));
        }
        progress.message(&"中文🙂".repeat(10000));
        let view = progress.0.borrow().clone();
        assert_eq!(view.tools.len(), MAX_TOOLS);
        assert!(view.text.len() <= MAX_PROGRESS_BYTES);
        assert!(matches!(
            &view.blocks[0],
            TurnBlock::Tools { count: 100, .. }
        ));
        assert!(view.blocks.len() <= MAX_BLOCKS);
        progress.finish("Done");
        recv(&mut rx).await;
    }
}
