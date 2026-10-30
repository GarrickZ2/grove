use super::{AcpSessionHandle, AcpUpdate};

impl AcpSessionHandle {
    pub(super) fn has_pending_input(&self) -> bool {
        !self.pending_ask_forms.lock().unwrap().is_empty()
            || self.pending_elicitation_snapshot().is_some()
    }

    fn publish_input_attention(&self, waiting_for_input: bool) {
        if let Some(chat_id) = &self.chat_id {
            crate::radio::publish(crate::radio::RadioEvent::ChatInputStatus {
                project_id: self.project_key.clone(),
                task_id: self.task_id.clone(),
                chat_id: chat_id.clone(),
                waiting_for_input,
            });
        }
    }

    pub fn resolve_ask_form(&self, id: &str) {
        let removed = {
            let mut forms = self.pending_ask_forms.lock().unwrap();
            let before = forms.len();
            forms.retain(|(form_id, _)| form_id != id);
            before != forms.len()
        };
        if removed {
            self.publish_input_attention(self.has_pending_input());
        }
    }

    pub fn pending_ask_form_snapshots(&self) -> Vec<AcpUpdate> {
        self.pending_ask_forms
            .lock()
            .unwrap()
            .iter()
            .map(|(form_id, definition)| AcpUpdate::AskForm {
                form_id: form_id.clone(),
                definition: definition.clone(),
            })
            .collect()
    }

    pub(super) fn update_input_attention(&self, update: &AcpUpdate) {
        if matches!(update, AcpUpdate::SessionEnded) {
            self.pending_ask_forms.lock().unwrap().clear();
            self.publish_input_attention(false);
            return;
        }
        let update = match update {
            AcpUpdate::SubagentEvent { event, .. } => event.as_ref(),
            _ => update,
        };
        match update {
            AcpUpdate::AskForm {
                form_id,
                definition,
            } => {
                {
                    let mut forms = self.pending_ask_forms.lock().unwrap();
                    if !forms.iter().any(|(id, _)| id == form_id) {
                        forms.push((form_id.clone(), definition.clone()));
                    }
                }
                self.publish_input_attention(true);
            }
            AcpUpdate::ElicitationRequest { .. } | AcpUpdate::ElicitationResolved { .. } => {
                self.publish_input_attention(self.has_pending_input());
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn input_attention_includes_native_forms_and_child_requests() {
        use super::super::{acp, ElicitationRequestSnapshot, PendingElicitation};
        let key = format!("native-input-attention-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) =
            super::super::new_handle_for_test(&key, &key, "task", "chat");
        let snapshot = ElicitationRequestSnapshot {
            request_id: "request-1".into(),
            agent_name: "Agent".into(),
            opened: false,
            request: acp::CreateElicitationRequest::new(
                acp::ElicitationFormMode::new(
                    acp::ElicitationSessionScope::new("session-test"),
                    acp::ElicitationSchema::new().string("name", true),
                ),
                "Your name",
            ),
        };
        let (tx, _rx) = tokio::sync::oneshot::channel();
        *handle.pending_elicitation.lock().unwrap() = Some(PendingElicitation {
            snapshot: snapshot.clone(),
            response_tx: tx,
        });
        let mut events = crate::radio::subscribe_plugins();
        handle.update_input_attention(&AcpUpdate::SubagentEvent {
            session_id: "child".into(),
            event: Box::new(AcpUpdate::ElicitationRequest { snapshot }),
        });
        assert!(handle.has_pending_input());
        handle.pending_elicitation.lock().unwrap().take();
        handle.update_input_attention(&AcpUpdate::ElicitationResolved {
            request_id: "request-1".into(),
            action: "accept".into(),
        });
        assert!(!handle.has_pending_input());
        let mut waiting = vec![];
        while let Ok(event) = events.try_recv() {
            if let crate::radio::RadioEvent::ChatInputStatus {
                project_id,
                waiting_for_input,
                ..
            } = event
            {
                if project_id == key {
                    waiting.push(waiting_for_input);
                }
            }
        }
        assert_eq!(waiting, vec![true, false]);
    }

    #[tokio::test]
    async fn input_attention_survives_idle_and_resolves_each_form_separately() {
        let key = format!("input-attention-{}", uuid::Uuid::new_v4());
        let (handle, _updates, _guard) =
            super::super::new_handle_for_test(&key, &key, "task", "chat");
        let mut events = crate::radio::subscribe_plugins();
        let form = |id: &str| AcpUpdate::AskForm {
            form_id: id.into(),
            definition: crate::agent_graph::ask_form::AskFormInput {
                title: "Choose".into(),
                description: None,
                questions: vec![],
            },
        };
        handle.update_input_attention(&form("first"));
        handle.update_input_attention(&form("second"));
        handle.update_input_attention(&form("second"));
        assert_eq!(handle.pending_ask_form_snapshots().len(), 2);
        handle.update_input_attention(&AcpUpdate::Busy { value: false });
        assert!(handle.has_pending_input());
        handle.resolve_ask_form("stale");
        handle.resolve_ask_form("first");
        assert!(handle.has_pending_input());
        assert!(
            matches!(handle.pending_ask_form_snapshots().as_slice(), [AcpUpdate::AskForm { form_id, .. }] if form_id == "second")
        );
        handle.resolve_ask_form("second");
        assert!(!handle.has_pending_input());
        let mut waiting = vec![];
        while let Ok(event) = events.try_recv() {
            if let crate::radio::RadioEvent::ChatInputStatus {
                project_id,
                waiting_for_input,
                ..
            } = event
            {
                if project_id == key {
                    waiting.push(waiting_for_input);
                }
            }
        }
        assert_eq!(waiting, vec![true, true, true, true, false]);
        handle.update_input_attention(&form("last"));
        handle.update_input_attention(&AcpUpdate::SessionEnded);
        assert!(!handle.has_pending_input());
    }
}
