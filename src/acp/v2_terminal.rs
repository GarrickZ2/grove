//! Projection of agent-owned ACP v2 display terminals.

use std::collections::HashMap;

use agent_client_protocol::schema::{v2, MaybeUndefined};
use base64::{engine::general_purpose::STANDARD, DecodeError, Engine};

pub struct Terminal {
    pub state: v2::TerminalUpdate,
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

#[derive(Default)]
pub struct Terminals {
    items: HashMap<String, Terminal>,
}

impl Terminals {
    pub fn values(&self) -> impl Iterator<Item = &Terminal> {
        self.items.values()
    }
    fn get_or_insert(&mut self, id: &str) -> &mut Terminal {
        self.items.entry(id.to_owned()).or_insert_with(|| Terminal {
            state: v2::TerminalUpdate::new(id),
            bytes: Vec::new(),
            truncated: false,
        })
    }

    pub fn update(&mut self, update: v2::TerminalUpdate) -> Result<&Terminal, DecodeError> {
        // Decode before mutation so malformed data cannot leave a half-applied patch.
        let output = match &update.output {
            MaybeUndefined::Undefined => None,
            MaybeUndefined::Null => Some(Vec::new()),
            MaybeUndefined::Value(output) => Some(STANDARD.decode(&output.data)?),
        };
        let terminal = self.get_or_insert(&update.terminal_id.to_string());
        if let Some(output) = output {
            terminal.bytes = output;
            terminal.truncated = false;
        }
        terminal.state.apply_update(update);
        Ok(terminal)
    }

    pub fn chunk(&mut self, chunk: &v2::TerminalOutputChunk) -> Result<&Terminal, DecodeError> {
        let bytes = STANDARD.decode(&chunk.data)?;
        let terminal = self.get_or_insert(&chunk.terminal_id.to_string());
        terminal.bytes.extend(bytes);
        Ok(terminal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chunks_decode_separately_and_snapshots_replace_existing_bytes() {
        let mut terminals = Terminals::default();
        let chunk =
            |data| serde_json::from_value(json!({"terminalId":"one", "data":data})).unwrap();
        terminals.chunk(&chunk("4g==")).unwrap();
        let terminal = terminals.chunk(&chunk("gqw=")).unwrap();
        assert_eq!(std::str::from_utf8(&terminal.bytes).unwrap(), "€");
        let snapshot =
            serde_json::from_value(json!({"terminalId":"one", "output":{"data":"bmV3"}})).unwrap();
        assert_eq!(terminals.update(snapshot).unwrap().bytes, b"new");
        let terminal = terminals.chunk(&chunk("IQ==")).unwrap();
        assert_eq!(terminal.bytes, b"new!");
        let invalid = serde_json::from_value(
            json!({"terminalId":"one", "output":{"data":"!"}, "command":"ignored"}),
        )
        .unwrap();
        assert!(terminals.update(invalid).is_err());
        assert_eq!(terminals.items["one"].bytes, b"new!");
        assert!(terminals.items["one"].state.command.is_undefined());
    }

    #[test]
    fn large_output_is_preserved_and_snapshot_replaces_it() {
        let mut terminals = Terminals::default();
        let data = STANDARD.encode("界".repeat(32 * 1024));
        let chunk = serde_json::from_value(json!({"terminalId":"one", "data":data})).unwrap();
        let terminal = terminals.chunk(&chunk).unwrap();
        assert!(!terminal.truncated && terminal.bytes.len() > 32 * 1024);
        assert!(std::str::from_utf8(&terminal.bytes).is_ok());
        let snapshot =
            serde_json::from_value(json!({"terminalId":"one", "output":{"data":"bmV3"}})).unwrap();
        assert!(!terminals.update(snapshot).unwrap().truncated);
    }
}
