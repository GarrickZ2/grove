//! Platform-owned transport checkpoint; this is not an Agent queue.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub peer: String,
    pub text: String,
    pub context_token: String,
    #[serde(default)]
    pub unsupported_media: bool,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Checkpoint {
    pub fingerprint: String,
    pub cursor: String,
    pub pending: VecDeque<Message>,
    pub seen: VecDeque<String>,
    pub replies: HashMap<String, Message>,
}

pub struct Store {
    pub data: Checkpoint,
    path: PathBuf,
}

impl Store {
    pub fn load(path: PathBuf, token: &str) -> Result<Self, String> {
        let fingerprint = hex::encode(Sha256::digest(token.as_bytes()));
        let mut data: Checkpoint = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| {
                "Invalid WeChat transport checkpoint; reconnect after inspecting its state"
                    .to_owned()
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Checkpoint::default(),
            Err(_) => return Err("Could not read WeChat transport checkpoint".into()),
        };
        if data.fingerprint != fingerprint {
            data = Checkpoint {
                fingerprint,
                ..Default::default()
            };
        }
        Ok(Self { data, path })
    }

    pub fn accept(&mut self, messages: Vec<Message>, cursor: Option<&str>) -> Result<(), String> {
        for message in messages {
            if self.data.seen.contains(&message.id)
                || self.data.pending.iter().any(|entry| entry.id == message.id)
            {
                continue;
            }
            self.data
                .replies
                .insert(message.id.clone(), message.clone());
            self.data.pending.push_back(message);
        }
        if let Some(cursor) = cursor.filter(|value| !value.is_empty()) {
            self.data.cursor = cursor.into();
        }
        self.save()
    }

    pub fn complete(&mut self, id: &str) -> Result<(), String> {
        if self
            .data
            .pending
            .front()
            .is_some_and(|message| message.id == id)
        {
            self.data.pending.pop_front();
        }
        self.data.seen.push_back(id.into());
        while self.data.seen.len() > 4096 {
            if let Some(old) = self.data.seen.pop_front() {
                self.data.replies.remove(&old);
            }
        }
        self.save()
    }

    pub fn save(&self) -> Result<(), String> {
        use std::io::Write;
        let directory = self.path.parent().ok_or("Invalid WeChat state path")?;
        std::fs::create_dir_all(directory)
            .map_err(|_| "Could not create WeChat state directory")?;
        let temporary = self.path.with_extension("json.tmp");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Could not write WeChat transport checkpoint")?;
        file.write_all(
            &serde_json::to_vec(&self.data).map_err(|_| "Could not encode WeChat state")?,
        )
        .and_then(|_| file.sync_all())
        .map_err(|_| "Could not persist WeChat transport checkpoint")?;
        std::fs::rename(temporary, &self.path)
            .map_err(|_| "Could not replace WeChat transport checkpoint")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(id: &str, token: &str) -> Message {
        Message {
            id: id.into(),
            peer: "owner".into(),
            text: "hi".into(),
            context_token: token.into(),
            unsupported_media: false,
        }
    }

    #[test]
    fn restart_preserves_pending_and_distinct_reply_contexts_without_replaying_completed_messages()
    {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let mut store = Store::load(path.clone(), "credential").unwrap();
        store
            .accept(
                vec![message("1", "first"), message("2", "second")],
                Some("cursor"),
            )
            .unwrap();
        store.complete("1").unwrap();
        let mut restored = Store::load(path.clone(), "credential").unwrap();
        restored
            .accept(vec![message("1", "first"), message("2", "second")], None)
            .unwrap();
        assert_eq!(restored.data.cursor, "cursor");
        assert_eq!(restored.data.pending.len(), 1);
        assert_eq!(restored.data.replies["1"].context_token, "first");
        assert_eq!(restored.data.replies["2"].context_token, "second");
        let new_account = Store::load(path, "new-credential").unwrap();
        assert!(new_account.data.pending.is_empty());
        assert!(new_account.data.cursor.is_empty());
    }
}
