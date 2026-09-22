use crate::storage::connects::Connect;

/// A registered IM system command. Bare-invocation semantics: commands with
/// `takes_args: false` only trigger when nothing follows the command word —
/// "/cancel now" is a prompt for the AI, not a cancellation. Commands with
/// `takes_args: true` always receive the remainder as raw arguments and must
/// handle the empty case gracefully (usage or current state).
#[derive(Debug, Clone, PartialEq)]
pub struct CommandDef {
    pub name: &'static str,
    pub takes_args: bool,
    pub usage: &'static str,
    pub summary: &'static str,
}

pub const COMMANDS: &[CommandDef] = &[
    CommandDef {
        name: "help",
        takes_args: false,
        usage: "/help",
        summary: "Show available commands",
    },
    CommandDef {
        name: "status",
        takes_args: false,
        usage: "/status",
        summary: "Show session state and routing target",
    },
    CommandDef {
        name: "cancel",
        takes_args: false,
        usage: "/cancel",
        summary: "Cancel the current agent turn",
    },
    CommandDef {
        name: "new",
        takes_args: false,
        usage: "/new",
        summary: "Start a new session on the current task (pick an agent in a card)",
    },
    CommandDef {
        name: "clear",
        takes_args: false,
        usage: "/clear",
        summary: "Same as /new — start a fresh session",
    },
    CommandDef {
        name: "config",
        takes_args: false,
        usage: "/config",
        summary: "Change session options: mode, model, effort (in a card)",
    },
    CommandDef {
        name: "target",
        takes_args: false,
        usage: "/target",
        summary: "Change the routing target: project, task, session (in a card)",
    },
    CommandDef {
        name: "skill",
        takes_args: true,
        usage: "/skill <name> [prompt]",
        summary: "Invoke an AI skill, e.g. /skill review this PR",
    },
];

fn find(name: &str) -> Option<&'static CommandDef> {
    COMMANDS
        .iter()
        .find(|def| def.name.eq_ignore_ascii_case(name))
}

/// Result of classifying an inbound message: either a system command with its
/// raw argument tail, or a prompt that must reach the AI verbatim.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Command(&'static CommandDef, String),
    Prompt,
}

pub fn parse(text: &str) -> Parsed {
    let trimmed = text.trim();
    let (token, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((token, rest)) => (token, rest),
        None => (trimmed, ""),
    };
    let Some(def) = token.strip_prefix('/').and_then(find) else {
        return Parsed::Prompt;
    };
    if !def.takes_args && !rest.trim().is_empty() {
        // A no-arg command followed by text is the user talking to the AI
        // ("/cancel for the second feature"); forward the message untouched.
        return Parsed::Prompt;
    }
    Parsed::Command(def, rest.trim().to_owned())
}

pub fn help() -> String {
    let mut text = String::from("Grove Connect commands:\n");
    for def in COMMANDS {
        text.push_str(&format!("{} — {}\n", def.usage, def.summary));
    }
    text.push_str(
        "\nAny other / command is sent to the AI as-is (skills and prompts).\n\
         A command word followed by extra text also goes to the AI.\n\
         Use /skill when a skill name collides with a command above.",
    );
    text
}

/// Platform-neutral description of an interactive card. Adapters render it
/// into their native card format.
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CardSpec {
    /// Agent picker for a fresh session; `current` preselects the agent of
    /// the session being replaced.
    NewSession {
        agents: Vec<AgentOption>,
        current: Option<String>,
    },
    Target(Box<TargetCard>),
    Config(Box<ConfigCard>),
    Permission(PermissionCard),
    Elicitation(ElicitationCard),
    AskForm(AskFormCard),
    Notice(String),
}

#[derive(serde::Serialize)]
pub struct PermissionCard {
    pub request_id: String,
    pub description: String,
    pub options: Vec<PermissionCardOption>,
}

#[derive(serde::Serialize)]
pub struct PermissionCardOption {
    pub id: String,
    pub label: String,
    pub kind: String,
}

#[derive(serde::Serialize)]
pub struct ElicitationCard {
    pub request_id: String,
    pub message: String,
    pub fields: Vec<ElicitationField>,
}

#[derive(serde::Serialize)]
pub struct ElicitationField {
    pub name: String,
    pub label: String,
    pub description: Option<String>,
    pub required: bool,
    pub kind: ElicitationFieldKind,
    pub options: Vec<(String, String)>,
}

/// Grove's own structured form. Unlike ACP elicitation, submitting it starts
/// a normal follow-up prompt; the adapter only renders the question shape.
#[derive(serde::Serialize)]
pub struct AskFormCard {
    pub form_id: String,
    pub definition: crate::agent_graph::ask_form::AskFormInput,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ElicitationFieldKind {
    Text,
    Integer,
    Number,
    Boolean,
    StringArray,
}

/// Routing target editor: project / task / session (existing or auto-new).
#[derive(serde::Serialize)]
pub struct TargetCard {
    pub project_id: String,
    pub task_id: String,
    /// Currently routed session — preselected in the session dropdown
    /// ("" = Auto New option).
    pub session_id: String,
    pub projects: Vec<ProjectOption>,
    pub tasks: Vec<TaskOption>,
    /// Existing chat sessions of `task_id` — empty when no task is routed.
    pub sessions: Vec<TaskOption>,
}

/// Live session config editor: one dropdown per select-style config option
/// the agent advertises (mode / model / effort / …), rendered dynamically
/// from the session's `configOptions` snapshot.
#[derive(serde::Serialize)]
pub struct ConfigCard {
    pub selectors: Vec<ConfigSelectorOption>,
}

#[derive(serde::Serialize)]
pub struct ConfigSelectorOption {
    /// Form field name (`opt_<index>`); mapped back by position on submit.
    pub name: String,
    pub label: String,
    pub current: Option<String>,
    pub options: Vec<(String, String)>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProjectOption {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TaskOption {
    pub id: String,
    pub name: String,
}

/// What a command handler asks the runtime to do next.
pub enum CommandOutcome {
    /// Quick text reply — no agent turn involved.
    Reply(String),
    /// Send an interactive card as a reply.
    Card(CardSpec),
    /// Hand the text to the full prompt pipeline (queue, reactions, replies).
    ForwardToAgent(String),
}

/// Agents available for a new session — the same list the Web UI's chat
/// picker offers: installed (not merely catalogued), not hidden, sorted by
/// display name. Names come from the registry, ids are canonical.
pub fn agent_options() -> Vec<AgentOption> {
    let names: std::collections::HashMap<_, _> = crate::storage::agent_registry::get()
        .agents
        .into_iter()
        .map(|agent| (agent.id, agent.name))
        .collect();
    let mut agents: Vec<AgentOption> = crate::storage::installed_agents::list()
        .unwrap_or_default()
        .into_iter()
        .filter(|agent| {
            !agent.hidden
                && agent.selected_installation().is_some_and(|installation| {
                    installation.status
                        == crate::storage::installed_agents::InstallStatus::Installed
                })
        })
        .map(|agent| AgentOption {
            name: names
                .get(&agent.id)
                .cloned()
                .unwrap_or_else(|| agent.id.clone()),
            id: agent.id,
        })
        .collect();
    agents.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    agents
}

pub fn project_options() -> Vec<ProjectOption> {
    crate::storage::workspace::load_active_projects()
        .unwrap_or_default()
        .into_iter()
        .map(|project| ProjectOption {
            id: crate::storage::workspace::project_hash(&project.path),
            name: project.name,
        })
        .collect()
}

pub fn task_options(project_id: &str) -> Vec<TaskOption> {
    crate::storage::tasks::load_tasks(project_id)
        .unwrap_or_default()
        .into_iter()
        .map(|task| {
            // Match the Web UI: the synthetic per-project task is labelled.
            let name = if task.id == crate::storage::tasks::LOCAL_TASK_ID {
                format!("{} (Local Task)", task.name)
            } else {
                task.name
            };
            TaskOption { id: task.id, name }
        })
        .collect()
}

pub fn session_options(project_id: &str, task_id: &str) -> Vec<TaskOption> {
    crate::storage::tasks::load_chat_sessions(project_id, task_id)
        .unwrap_or_default()
        .into_iter()
        .map(|chat| TaskOption {
            id: chat.id,
            name: format!("{} ({})", chat.title, chat.agent),
        })
        .collect()
}

pub fn target_card(connect: &Connect) -> CardSpec {
    CardSpec::Target(Box::new(TargetCard {
        project_id: connect.project_id.clone(),
        task_id: connect.task_id.clone(),
        session_id: connect.session_id.clone(),
        projects: project_options(),
        tasks: task_options(&connect.project_id),
        sessions: session_options(&connect.project_id, &connect.task_id),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_commands_trigger_and_tailed_commands_fall_through() {
        assert!(matches!(parse("/cancel"), Parsed::Command(_, args) if args.is_empty()));
        assert!(matches!(parse("  /cancel  "), Parsed::Command(_, args) if args.is_empty()));
        assert_eq!(parse("/cancel for the second feature"), Parsed::Prompt);
        assert_eq!(parse("please continue"), Parsed::Prompt);
        assert_eq!(parse("/totally-unknown"), Parsed::Prompt);
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(matches!(parse("/CANCEL"), Parsed::Command(_, _)));
    }

    #[test]
    fn arg_commands_match_with_and_without_args() {
        assert!(
            matches!(parse("/skill review this PR"), Parsed::Command(def, args)
            if def.name == "skill" && args == "review this PR")
        );
        assert!(matches!(parse("/skill"), Parsed::Command(def, args)
            if def.name == "skill" && args.is_empty()));
    }

    #[test]
    fn help_lists_every_registered_command() {
        let text = help();
        for def in COMMANDS {
            assert!(text.contains(def.usage), "help missing {}", def.usage);
        }
    }
}
