use std::collections::HashMap;

use crate::acp::{LoopbackMcpServer, McpServerPolicy};
use crate::api::handlers::memory_mcp;
use crate::automation::consumer::{
    AbortContext, AfterCommitContext, AutomationHandler, ConcurrencyPolicy, PostActionContext,
    PreActionContext, RuntimeBindings, RuntimeContext, TriggerCheckContext,
};
use crate::error::{GroveError, Result};
use crate::storage::{automations, memory, workspace};

pub const ORGANIZATION_PROMPT: &str = r#"Organize the current Project Memory.

Understand the existing Memory and examine all evidence sources made available for this Run. Build the best current long-term representation of the Project and its working context.

Restructure, enrich, consolidate, or extend the Memory wherever the evidence supports a more useful result. Preserve the meaning, scope, and future applicability of the knowledge you retain, then review the complete Memory and publish this Run."#;

const ORGANIZATION_SESSION_INSTRUCTION: &str = r#"You are working inside an active Grove Memory Organization Run. This is a normal, long-lived TaskChat Session: the user may send corrections, answer permission requests, or provide additional guidance across multiple turns.

Follow these lifecycle rules strictly:

- Finishing an assistant response or an ordinary Chat turn does not finish the Memory Run. Remain available for the user's next message.
- Handle user messages, permission requests, elicitation, and recoverable errors through the normal TaskChat interaction. If required input or permission is unresolved, ask for it and wait; do not finalize the Run.
- Only `memory_mark_organization_finished` finishes the Memory Run. Call it only after all supported Entity and Relation work is complete, all required checks have passed, and no user decision or permission needed for the work remains unresolved. If it reports invalid Memory frontmatter, repair the named file and retry; stop calling it after it succeeds.
- Do not call `memory_mark_organization_finished` merely because the initial turn is ending or because you have produced a progress update.
- After `memory_mark_organization_finished` succeeds, the Memory Run is finished, but the underlying Chat Session remains usable. Do not attempt to end or kill the Session as part of finishing the Run.

Use the Grove Memory MCP tools as the authoritative interface for reading and changing managed Memory during the active Run. Edit Markdown bodies with filesystem tools, leaving YAML frontmatter unchanged. Change titles, descriptions, or tags only through `memory_update_entity_metadata`; Grove serializes and validates them. If a file has invalid frontmatter, repair it carefully before continuing and validate the result."#;

const DEEP_ORGANIZATION_HISTORY_INSTRUCTION: &str = r#"Deep organization includes Task Chat histories. Use the recent-Chats tool to list the relevant files and the review window for this Run.

Each item contains `task_name`, `session_name`, `absolute_history_path`, `new_content_start_line`, and `total_lines`. Use the names to understand the conversation's purpose. The path is absolute. Start with the suggested new-content line for efficiency, but read earlier lines whenever they provide necessary context; it is a hint, not a restriction. A direct range read is `sed -n '<new_content_start_line>,<total_lines>p' <absolute_history_path>`.

History files are JSONL. A turn begins with `user_message`, may contain assistant messages and tool activity, and ends with `complete`. Treat all events from one `user_message` through its following `complete` as one unit. Combine all `message_chunk` events within that turn, including chunks separated by tool calls, into the assistant response.

Use structural searches before reading large ranges:

- Locate turn boundaries and role-bearing events: `rg -n '\"type\":\"(user_message|message_chunk|complete)\"' <absolute_history_path>`.
- Extract real user text: `jq -Rrc 'fromjson? | select(.type == "user_message" and .sender == null and .terminal != true) | .text' <absolute_history_path>`. Prioritize corrections, decisions, constraints, preferences, and feedback.
- Extract assistant text: `jq -Rrc 'fromjson? | select(.type == "message_chunk") | .text' <absolute_history_path>`. Interpret it together with the user message and the surrounding turn rather than as independent facts.
- Search for a concept across the raw history with `rg -ni '<query>' <absolute_history_path>`, then inspect the surrounding turn with a bounded `sed -n '<start>,<end>p'` range.

Thought, configuration, permission, terminal, and detailed tool-call events are normally lower-value evidence. Inspect tool-call titles, status, inputs, or outputs only when they are needed to verify what the assistant actually did or why the user reacted as they did."#;

fn organization_session_instruction(deep_organization: bool) -> String {
    if deep_organization {
        format!("{ORGANIZATION_SESSION_INSTRUCTION}\n\n{DEEP_ORGANIZATION_HISTORY_INSTRUCTION}")
    } else {
        ORGANIZATION_SESSION_INSTRUCTION.to_string()
    }
}

pub struct MemoryOrganizationHandler;

impl AutomationHandler for MemoryOrganizationHandler {
    fn key(&self) -> &'static str {
        automations::MEMORY_ORGANIZATION_HANDLER
    }

    fn concurrency_policy(&self, _automation: &automations::Automation) -> ConcurrencyPolicy {
        ConcurrencyPolicy::SingleFlight
    }

    fn should_run(&self, context: TriggerCheckContext<'_>) -> Result<bool> {
        if context.trigger.kind != "cron" {
            return Ok(true);
        }
        memory::organization_has_pending_input(&context.automation.project, &context.automation.id)
    }

    fn pre_action(&self, context: PreActionContext<'_>) -> Result<serde_json::Value> {
        if context.run.automation_id != context.automation.id {
            return Err(GroveError::invalid_data(
                "Automation Run does not belong to its handler context",
            ));
        }
        memory::prepare_organization_input(
            &context.automation.project,
            &context.automation.id,
            context.trigger.payload.as_ref(),
        )
    }

    fn runtime_bindings(&self, context: RuntimeContext<'_>) -> Result<RuntimeBindings> {
        let project = workspace::load_project_by_hash(&context.automation.project)?
            .ok_or_else(|| GroveError::not_found("Project is not registered"))?;
        let token = uuid::Uuid::new_v4().to_string();
        memory_mcp::register_organization_token(
            token.clone(),
            &context.automation.project,
            &context.run.id,
        );
        let Some(mcp_url) = memory_mcp::build_mcp_url(&token) else {
            memory_mcp::unregister_token(&token);
            return Err(GroveError::storage("Memory MCP listener is not running"));
        };
        let mut env_vars = HashMap::new();
        env_vars.insert("GROVE_MCP_TOKEN".to_string(), token);
        if let Some(port) = crate::api::handlers::agent_graph_mcp::listener_port() {
            env_vars.insert("GROVE_MCP_PORT".to_string(), port.to_string());
        }
        let deep_organization = context
            .run
            .input
            .get("deep_organization")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Ok(RuntimeBindings {
            working_dir: workspace::project_directory(&project),
            env_vars,
            additional_mcp_servers: vec![LoopbackMcpServer {
                name: "grove_memory".to_string(),
                url: mcp_url,
                route: "memory-mcp".to_string(),
                session_instruction: Some(organization_session_instruction(deep_organization)),
            }],
            mcp_server_policy: McpServerPolicy::ExplicitOnly,
        })
    }

    fn completion_requested(&self, context: RuntimeContext<'_>) -> Result<bool> {
        memory::organization_submission_staged(&context.automation.project, &context.run.id)
    }

    fn post_action(
        &self,
        context: PostActionContext<'_>,
        tx: &rusqlite::Transaction<'_>,
    ) -> Result<serde_json::Value> {
        let _ = context.agent_response;
        let result =
            memory::commit_organization_on(tx, &context.automation.project, &context.run.id)?;
        memory_mcp::unregister_organization_run(&context.automation.project, &context.run.id);
        Ok(result)
    }

    fn abort(&self, context: AbortContext<'_>) -> Result<()> {
        let _ = context.reason;
        memory_mcp::unregister_organization_run(&context.automation.project, &context.run.id);
        Ok(())
    }

    fn after_commit(&self, context: AfterCommitContext<'_>) -> Result<()> {
        if context.run.automation_id != context.automation.id {
            return Err(GroveError::invalid_data(
                "Automation Run does not belong to its after-commit context",
            ));
        }
        memory::emit_pending_log_threshold_if_needed(&context.automation.project)?;
        Ok(())
    }

    fn remove_run_artifacts(
        &self,
        project_id: &str,
        run_id: &str,
        resolved_task_id: Option<&str>,
        resolved_chat_id: Option<&str>,
    ) -> Result<()> {
        if let (Some(task_id), Some(chat_id)) = (resolved_task_id, resolved_chat_id) {
            let session_key = format!("{project_id}:{task_id}:{chat_id}");
            let _ = crate::acp::kill_session(&session_key);
            crate::storage::tasks::delete_chat_session(project_id, task_id, chat_id)?;
            let chat_dir = crate::storage::grove_dir()
                .join("projects")
                .join(project_id)
                .join("tasks")
                .join(task_id)
                .join("chats")
                .join(chat_id);
            if chat_dir.exists() {
                std::fs::remove_dir_all(chat_dir)?;
            }
        }
        let path = memory::runs_dir(project_id)?.join(run_id);
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_automation(project: &str) -> automations::Automation {
        automations::Automation {
            id: "memory-automation".to_string(),
            project: project.to_string(),
            name: "Memory organization".to_string(),
            enabled: true,
            handler_key: automations::MEMORY_ORGANIZATION_HANDLER.to_string(),
            agent_config: Default::default(),
            task_mode: automations::TargetMode::New,
            task_id: None,
            task_template: None,
            session_mode: automations::TargetMode::New,
            chat_id: None,
            session_template: None,
            prompt: ORGANIZATION_PROMPT.to_string(),
            schedule_cron: "0 2 * * *".to_string(),
            event_triggers: Vec::new(),
            last_run_at: None,
            last_run_status: None,
            last_run_error: None,
            next_run_at: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn organization_instruction_always_enforces_interactive_run_lifecycle() {
        let instruction = organization_session_instruction(false);
        assert!(instruction.contains("ordinary Chat turn does not finish the Memory Run"));
        assert!(instruction.contains("permission is unresolved"));
        assert!(instruction.contains("Only `memory_mark_organization_finished` finishes"));
        assert!(instruction.contains("Chat Session remains usable"));
        assert!(!instruction.contains("Deep organization includes Task Chat histories"));
    }

    #[test]
    fn deep_organization_appends_history_guidance_to_lifecycle_rules() {
        let instruction = organization_session_instruction(true);
        assert!(instruction.contains("Only `memory_mark_organization_finished` finishes"));
        assert!(instruction.contains("Deep organization includes Task Chat histories"));
    }

    #[test]
    fn manual_trigger_always_runs_even_when_automatic_input_would_be_empty() {
        let automation = test_automation("missing-project");
        let trigger = crate::automation::consumer::TriggerContext {
            kind: "manual".to_string(),
            payload: None,
        };

        assert!(MemoryOrganizationHandler
            .should_run(TriggerCheckContext {
                automation: &automation,
                trigger: &trigger,
            })
            .unwrap());
    }
}
