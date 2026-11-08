//! Approvals a person grants one chat Session: using their own browser, or
//! their computer. Each Session asks the first time it needs one; the user
//! answers in that Session's chat.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::watch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    PersonalBrowser,
    Computer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    None,
    Pending,
    Allowed,
}

/// The Session asking, and the Task it belongs to.
#[derive(Debug, Clone)]
pub struct Requester {
    pub project: String,
    pub task: String,
    pub chat: String,
}

struct Entry {
    project: String,
    task: String,
    state: watch::Sender<Approval>,
}

type Key = (String, Capability);

static ENTRIES: LazyLock<Mutex<HashMap<Key, Arc<Entry>>>> = LazyLock::new(Default::default);

fn entry(requester: &Requester, capability: Capability) -> Arc<Entry> {
    ENTRIES
        .lock()
        .unwrap()
        .entry((requester.chat.clone(), capability))
        .or_insert_with(|| {
            Arc::new(Entry {
                project: requester.project.clone(),
                task: requester.task.clone(),
                state: watch::channel(Approval::None).0,
            })
        })
        .clone()
}

/// How a request for approval ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Denied,
    /// Nobody answered in time.
    Unanswered,
}

/// Wait for the user to allow this Session, unless they already did.
pub async fn wait(requester: &Requester, capability: Capability, timeout: Duration) -> Decision {
    let entry = entry(requester, capability);
    let mut state = entry.state.subscribe();
    if *state.borrow() == Approval::Allowed {
        return Decision::Allowed;
    }
    entry.state.send_replace(Approval::Pending);
    let decided =
        tokio::time::timeout(timeout, state.wait_for(|state| *state != Approval::Pending)).await;
    match decided {
        Ok(Ok(state)) if *state == Approval::Allowed => Decision::Allowed,
        Ok(_) => Decision::Denied,
        Err(_) => {
            entry.state.send_replace(Approval::None);
            Decision::Unanswered
        }
    }
}

/// The user's answer to a Session's pending request.
pub fn decide(
    project: &str,
    task: &str,
    chat: &str,
    capability: Capability,
    allow: bool,
) -> Result<(), String> {
    let entries = ENTRIES.lock().unwrap();
    let entry = entries
        .get(&(chat.to_string(), capability))
        .filter(|entry| entry.project == project && entry.task == task)
        .ok_or("Nothing is waiting for that answer.")?;
    entry.state.send_replace(if allow {
        Approval::Allowed
    } else {
        Approval::None
    });
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub chat_id: String,
    pub capability: Capability,
}

/// Every request in a Task still waiting for the user.
pub fn pending(project: &str, task: &str) -> Vec<Pending> {
    let entries = ENTRIES.lock().unwrap();
    let mut pending: Vec<Pending> = entries
        .iter()
        .filter(|(_, entry)| {
            entry.project == project
                && entry.task == task
                && *entry.state.borrow() == Approval::Pending
        })
        .map(|((chat, capability), _)| Pending {
            chat_id: chat.clone(),
            capability: *capability,
        })
        .collect();
    pending.sort_by(|a, b| a.chat_id.cmp(&b.chat_id));
    pending
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requester(task: &str, chat: &str) -> Requester {
        Requester {
            project: "approval-test".to_string(),
            task: task.to_string(),
            chat: chat.to_string(),
        }
    }

    #[tokio::test]
    async fn each_session_asks_once_for_itself() {
        let first = requester("t1", "approval-chat-a");
        let second = requester("t1", "approval-chat-b");
        let waiting = tokio::spawn({
            let first = first.clone();
            async move { wait(&first, Capability::Computer, Duration::from_secs(5)).await }
        });
        while pending("approval-test", "t1").is_empty() {
            tokio::task::yield_now().await;
        }
        decide(
            "approval-test",
            "t1",
            &first.chat,
            Capability::Computer,
            true,
        )
        .unwrap();
        assert_eq!(waiting.await.unwrap(), Decision::Allowed);
        assert_eq!(
            wait(&first, Capability::Computer, Duration::from_millis(10)).await,
            Decision::Allowed
        );
        assert_eq!(
            wait(&second, Capability::Computer, Duration::from_millis(10)).await,
            Decision::Unanswered
        );
        assert_eq!(
            wait(
                &first,
                Capability::PersonalBrowser,
                Duration::from_millis(10)
            )
            .await,
            Decision::Unanswered
        );
    }

    #[tokio::test]
    async fn a_refusal_is_not_a_timeout() {
        let asking = requester("t2", "approval-chat-c");
        let waiting = tokio::spawn({
            let asking = asking.clone();
            async move { wait(&asking, Capability::Computer, Duration::from_secs(5)).await }
        });
        while pending("approval-test", "t2").is_empty() {
            tokio::task::yield_now().await;
        }
        decide(
            "approval-test",
            "t2",
            &asking.chat,
            Capability::Computer,
            false,
        )
        .unwrap();
        assert_eq!(waiting.await.unwrap(), Decision::Denied);
    }

    #[test]
    fn another_task_cannot_answer() {
        let _ = entry(&requester("t3", "approval-chat-d"), Capability::Computer);
        assert!(decide(
            "approval-test",
            "other",
            "approval-chat-d",
            Capability::Computer,
            true
        )
        .is_err());
    }
}
