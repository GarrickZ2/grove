//! What a caller may do to other Sessions. Buddies and Working Agents share one
//! set of Session capabilities (read, search, work on the queue, interrupt);
//! this is the only place they differ.

use crate::error::{GroveError, Result};
use crate::radio::{TurnAction, TurnActionKind, TurnActor};
use crate::storage::{agent_graph as graph_db, buddies::Buddy, database, tasks};

pub enum SessionScope {
    /// A Buddy acts for the user: every Session but its own conversations.
    Buddy(Buddy),
    /// A Working Agent reaches the Sessions it works with, inside its Task:
    /// it reads those connected to it, and directs those it has an edge to.
    Graph {
        project: String,
        task: String,
        chat: String,
    },
}

impl SessionScope {
    fn graph_session(&self, session: &str) -> Result<(String, String, String)> {
        let Self::Graph {
            project,
            task,
            chat,
        } = self
        else {
            unreachable!("only called for Graph");
        };
        let (target_project, target_task, _) = tasks::find_chat_session_any(session)?
            .ok_or_else(|| GroveError::not_found("Session not found"))?;
        if &target_project != project || &target_task != task {
            return Err(GroveError::invalid_data(
                "same_task_required: you can only reach Sessions in your own Task",
            ));
        }
        Ok((project.clone(), task.clone(), chat.clone()))
    }

    pub fn ensure_readable(&self, session: &str) -> Result<()> {
        if matches!(self, Self::Buddy(_)) {
            return Ok(());
        }
        let (_, task, chat) = self.graph_session(session)?;
        if graph_db::sessions_connected(&database::connection(), &task, &chat, session)? {
            Ok(())
        } else {
            Err(GroveError::invalid_data(
                "no_edge: this Session is not connected to you in the Graph",
            ))
        }
    }

    pub fn ensure_manageable(&self, session: &str) -> Result<()> {
        if let Self::Buddy(buddy) = self {
            return crate::buddy::tools::ensure_not_own_segment(buddy, session);
        }
        let (_, _, chat) = self.graph_session(session)?;
        let has_edge = graph_db::outgoing_for_session(&database::connection(), &chat)?
            .iter()
            .any(|contact| contact.to_session_id == session);
        if has_edge {
            Ok(())
        } else {
            Err(GroveError::invalid_data(
                "no_edge: you can only direct Sessions you have an outgoing edge to",
            ))
        }
    }

    /// Attribution for something this caller does to a Session.
    pub fn action(&self, kind: TurnActionKind) -> TurnAction {
        let by = match self {
            Self::Buddy(_) => TurnActor::Buddy,
            Self::Graph { .. } => TurnActor::Agent,
        };
        TurnAction { by, kind }
    }
}
