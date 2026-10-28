//! Track the v2 foreground state independently of prompt acceptance.
//! A resume snapshot or repeated idle update is not another completion.

use agent_client_protocol::schema::v2::{IdleStateUpdate, StateUpdate};

#[derive(Debug, Default)]
pub struct Foreground {
    active: bool,
}

#[derive(Debug)]
pub enum Transition {
    Active,
    Waiting,
    Completed(IdleStateUpdate),
    Unchanged,
}

impl Foreground {
    pub fn is_active(&self) -> bool {
        self.active
    }
    pub fn apply(&mut self, update: &StateUpdate) -> Transition {
        match update {
            StateUpdate::Running(_) => {
                self.active = true;
                Transition::Active
            }
            StateUpdate::RequiresAction(_) => {
                self.active = true;
                Transition::Waiting
            }
            StateUpdate::Idle(idle) if self.active => {
                self.active = false;
                Transition::Completed(idle.clone())
            }
            _ => Transition::Unchanged,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(value: serde_json::Value) -> StateUpdate {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn resume_snapshot_and_repeated_idle_do_not_complete_twice() {
        let mut state_machine = Foreground::default();
        let idle = state(json!({"state":"idle", "stopReason":"end_turn"}));
        assert!(matches!(state_machine.apply(&idle), Transition::Unchanged));
        assert!(matches!(
            state_machine.apply(&state(json!({"state":"running"}))),
            Transition::Active
        ));
        assert!(matches!(
            state_machine.apply(&state(json!({"state":"requires_action"}))),
            Transition::Waiting
        ));
        assert!(matches!(
            state_machine.apply(&idle),
            Transition::Completed(_)
        ));
        assert!(matches!(state_machine.apply(&idle), Transition::Unchanged));
    }
}
