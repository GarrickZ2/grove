//! What a new Task's agent session starts with, per context source, with
//! estimated token counts (Dashboard "Agent context").
//!
//! Sources mirror what a Working Session really receives:
//! - **Instructions**: Grove's appended `<grove-instructions>` system prompt
//!   (minus the Memory section), plus the instruction file the agent reads at
//!   start: for Repo projects the default agent's own root file (CLAUDE.md /
//!   GEMINI.md / AGENTS.md), for Studio projects the generated task contract
//!   `AGENTS.md` (aliased for every agent) and `instructions.md`.
//! - **Memory**: the Memory usage section of the system prompt and the
//!   Memory tool schemas, only when Project Memory is enabled. Entities are
//!   recalled on demand and are not counted.
//! - **MCP servers**: the built-in `grove` / `grove_agent` tool schemas and
//!   server instructions (known statically), plugin and installed servers by
//!   name; their tool schemas are only known after connecting, so they are
//!   listed without an estimate and the source is marked `partial`.
//! - **Skills**: Grove-installed skills for the default agent; agents list
//!   each skill's name + description up front and read the body on demand.

use axum::{extract::Path, http::StatusCode, Json};
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::api::handlers::common;
use crate::storage::workspace::ProjectType;

/// Estimated token count for `text`.
///
/// Heuristic: ~4 characters per token for ASCII / Latin text, and one token
/// per wide character (CJK, kana, Hangul, full-width forms — everything from
/// U+2E80 up). Real tokenizers differ by roughly ±25%, so the UI always shows
/// these as approximate ("~").
pub fn estimate_tokens(text: &str) -> u64 {
    let (mut narrow, mut wide) = (0u64, 0u64);
    for c in text.chars() {
        if (c as u32) >= 0x2E80 {
            wide += 1;
        } else {
            narrow += 1;
        }
    }
    narrow.div_ceil(4) + wide
}

/// Estimated tokens of one MCP tool definition as an agent receives it
/// (name, description and JSON schemas).
fn estimate_tool(tool: &rmcp::model::Tool) -> u64 {
    serde_json::to_string(tool)
        .map(|json| estimate_tokens(&json))
        .unwrap_or(0)
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ContextItem {
    pub name: String,
    /// None when the size can't be known without starting the agent.
    pub tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ContextSource {
    /// "instructions" | "memory" | "mcp" | "skills"
    pub id: &'static str,
    pub name: &'static str,
    pub enabled: bool,
    /// Estimated tokens loaded at session start (sum of known items).
    pub tokens: u64,
    /// True when some items have no estimate (the real total is higher).
    pub partial: bool,
    pub detail: String,
    pub items: Vec<ContextItem>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct AgentContextResponse {
    /// Canonical id of the agent the MCP / skill sets were resolved for.
    pub agent: String,
    pub agent_label: String,
    pub total_tokens: u64,
    pub partial: bool,
    pub sources: Vec<ContextSource>,
}

/// An instruction file the agent reads at session start.
pub struct InstructionFile {
    pub name: String,
    pub content: String,
    pub modified: Option<DateTime<Utc>>,
    pub note: String,
}

pub enum McpServerInput {
    /// Built-in server with statically known tools + server instructions.
    Known { name: String, tokens: u64 },
    /// Plugin / installed server: tools are listed only after connecting.
    Unknown { name: String, note: &'static str },
}

/// Everything `assemble` needs, gathered from storage by the handler.
pub struct ContextInputs {
    pub agent: String,
    pub agent_label: String,
    pub grove_instruction: String,
    pub files: Vec<InstructionFile>,
    pub memory_enabled: bool,
    pub memory_instruction: Option<String>,
    pub memory_tool_tokens: u64,
    pub mcp: Vec<McpServerInput>,
    /// (name, description) of each skill visible to the agent.
    pub skills: Vec<(String, String)>,
    pub now: DateTime<Utc>,
}

fn ago(at: DateTime<Utc>, now: DateTime<Utc>) -> String {
    let minutes = (now - at).num_minutes().max(0);
    if minutes < 1 {
        "just now".into()
    } else if minutes < 60 {
        format!("{minutes}m ago")
    } else if minutes < 24 * 60 {
        format!("{}h ago", minutes / 60)
    } else {
        format!("{}d ago", minutes / (24 * 60))
    }
}

fn names_preview(names: &[&str], shown: usize) -> String {
    let mut text = names
        .iter()
        .take(shown)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    if names.len() > shown {
        text.push_str(&format!(" +{}", names.len() - shown));
    }
    text
}

/// Turn gathered facts into the per-source response.
pub fn assemble(inputs: ContextInputs) -> AgentContextResponse {
    let mut sources = Vec::new();

    // Instructions
    let mut items = vec![ContextItem {
        name: "Grove session instructions".into(),
        tokens: Some(estimate_tokens(&inputs.grove_instruction)),
        note: Some("Appended to the agent's system prompt".into()),
    }];
    let mut detail = vec!["Grove session instructions".to_string()];
    for file in &inputs.files {
        detail.push(match file.modified {
            Some(at) => format!("{} · edited {}", file.name, ago(at, inputs.now)),
            None => file.name.clone(),
        });
        items.push(ContextItem {
            name: file.name.clone(),
            tokens: Some(estimate_tokens(&file.content)),
            note: Some(file.note.clone()),
        });
    }
    sources.push(ContextSource {
        id: "instructions",
        name: "Instructions",
        enabled: true,
        tokens: items.iter().filter_map(|item| item.tokens).sum(),
        partial: false,
        detail: detail.join(" · "),
        items,
    });

    // Memory
    let (tokens, items) = match (&inputs.memory_instruction, inputs.memory_enabled) {
        (Some(text), true) => {
            let items = vec![
                ContextItem {
                    name: "Memory usage guide".into(),
                    tokens: Some(estimate_tokens(text)),
                    note: Some("Part of the system prompt".into()),
                },
                ContextItem {
                    name: "Memory tools".into(),
                    tokens: Some(inputs.memory_tool_tokens),
                    note: Some("grove_agent memory_* tool schemas".into()),
                },
            ];
            (items.iter().filter_map(|item| item.tokens).sum(), items)
        }
        _ => (0, Vec::new()),
    };
    sources.push(ContextSource {
        id: "memory",
        name: "Memory",
        enabled: inputs.memory_enabled,
        tokens,
        partial: false,
        detail: if inputs.memory_enabled {
            "Usage guide up front · memories recalled on demand".into()
        } else {
            "Turn on to keep what agents learn here".into()
        },
        items,
    });

    // MCP servers
    let mut items = Vec::new();
    for server in &inputs.mcp {
        items.push(match server {
            McpServerInput::Known { name, tokens } => ContextItem {
                name: name.clone(),
                tokens: Some(*tokens),
                note: None,
            },
            McpServerInput::Unknown { name, note } => ContextItem {
                name: name.clone(),
                tokens: None,
                note: Some((*note).into()),
            },
        });
    }
    let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
    let partial = items.iter().any(|item| item.tokens.is_none());
    sources.push(ContextSource {
        id: "mcp",
        name: "MCP servers",
        enabled: !items.is_empty(),
        tokens: items.iter().filter_map(|item| item.tokens).sum(),
        partial,
        detail: if partial {
            format!(
                "{} · tool schemas of others load on connect",
                names_preview(&names, 3)
            )
        } else {
            names_preview(&names, 3)
        },
        items,
    });

    // Skills
    let items: Vec<ContextItem> = inputs
        .skills
        .iter()
        .map(|(name, description)| ContextItem {
            name: name.clone(),
            tokens: Some(estimate_tokens(&format!("- {name}: {description}\n"))),
            note: None,
        })
        .collect();
    let count = items.len();
    sources.push(ContextSource {
        id: "skills",
        name: "Skills",
        enabled: count > 0,
        tokens: items.iter().filter_map(|item| item.tokens).sum(),
        partial: false,
        detail: if count == 0 {
            format!("None installed for {}", inputs.agent_label)
        } else {
            format!(
                "{count} skill{} · names and descriptions up front, bodies on demand",
                if count == 1 { "" } else { "s" }
            )
        },
        items,
    });

    AgentContextResponse {
        total_tokens: sources.iter().map(|source| source.tokens).sum(),
        partial: sources.iter().any(|source| source.partial),
        agent: inputs.agent,
        agent_label: inputs.agent_label,
        sources,
    }
}

/// `claude-acp` → `claude`, `gemini-cli` → `gemini`, `codex` → `codex`.
/// Skill installs use their own agent ids (`claude-code`, `codex`, …), so
/// both sides are compared by family.
fn agent_family(id: &str) -> &str {
    id.split('-').next().unwrap_or(id)
}

fn agent_label(agent: &str) -> String {
    match agent_family(agent) {
        "claude" => "Claude Code".into(),
        "codex" => "Codex".into(),
        "gemini" => "Gemini CLI".into(),
        _ => agent.to_string(),
    }
}

/// The root instruction file the agent CLI itself loads in a repository.
fn agent_native_file(agent: &str) -> &'static str {
    match agent_family(agent) {
        "claude" => "CLAUDE.md",
        "gemini" => "GEMINI.md",
        _ => "AGENTS.md",
    }
}

fn read_file(path: &std::path::Path, note: String) -> Option<InstructionFile> {
    let content = std::fs::read_to_string(path).ok()?;
    if content.trim().is_empty() {
        return None;
    }
    let modified = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .map(DateTime::<Utc>::from);
    Some(InstructionFile {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        content,
        modified,
        note,
    })
}

fn visible_skills(agent: &str, project_path: &str) -> Vec<(String, String)> {
    let family = agent_family(agent);
    let manifest = crate::storage::skills::load_manifest();
    crate::storage::skills::load_installed()
        .installed
        .into_iter()
        .filter(|skill| {
            skill
                .global_agents
                .iter()
                .any(|a| agent_family(&a.agent_id) == family)
                || skill.project_installs.iter().any(|install| {
                    install.project_path == project_path
                        && install
                            .agents
                            .iter()
                            .any(|a| agent_family(&a.agent_id) == family)
                })
        })
        .map(|skill| {
            let description = manifest
                .skills
                .iter()
                .find(|entry| {
                    entry.repo_key == skill.repo_key && entry.repo_path == skill.repo_path
                })
                .map(|entry| entry.description.clone())
                .unwrap_or_default();
            (skill.skill_name, description)
        })
        .collect()
}

/// GET /api/v1/projects/{id}/agent-context
pub async fn get_agent_context(
    Path(id): Path<String>,
) -> Result<Json<AgentContextResponse>, StatusCode> {
    let (project, project_key) = common::find_project_by_id(&id)?;
    let studio = project.project_type == ProjectType::Studio;
    let agent = crate::storage::installed_agents::canonicalize_agent_id(
        crate::storage::config::load_config()
            .acp
            .agent_command
            .as_deref()
            .unwrap_or("claude-acp"),
    );
    let label = agent_label(&agent);

    let preview = crate::acp::preview_working_instructions(&project_key);
    let memory_enabled = preview.memory.is_some();

    let mut files = Vec::new();
    if studio {
        let local_dir =
            crate::storage::tasks::get_task(&project_key, crate::storage::tasks::LOCAL_TASK_ID)
                .ok()
                .flatten()
                .map(|task| std::path::PathBuf::from(task.worktree_path));
        if let Some(file) = local_dir.and_then(|dir| {
            read_file(
                &dir.join("AGENTS.md"),
                "Studio workspace contract, loaded by every agent".into(),
            )
        }) {
            files.push(file);
        }
        if let Ok((_, studio_dir)) = super::crud::resolve_studio_dir(&id) {
            if let Some(file) = read_file(
                &studio_dir.join("instructions.md"),
                "Project guidance the session is told to follow".into(),
            ) {
                files.push(file);
            }
        }
    } else if let Some(file) = read_file(
        &std::path::Path::new(&project.path).join(agent_native_file(&agent)),
        format!("Read by {label} from the repository root"),
    ) {
        files.push(file);
    }

    let (grove_tools, grove_instructions) = crate::cli::mcp::task_surface(studio);
    let (agent_tools, memory_tools) =
        crate::api::handlers::agent_graph_mcp::advertised_tools(memory_enabled);
    let mut mcp = vec![
        McpServerInput::Known {
            name: "grove".into(),
            tokens: grove_tools.iter().map(estimate_tool).sum::<u64>()
                + estimate_tokens(grove_instructions),
        },
        McpServerInput::Known {
            name: "grove_agent".into(),
            tokens: agent_tools.iter().map(estimate_tool).sum(),
        },
    ];
    for name in crate::acp::planned_plugin_mcp_server_names() {
        mcp.push(McpServerInput::Unknown {
            name,
            note: "Plugin server",
        });
    }
    for name in crate::acp::planned_standalone_mcp_server_names(&agent, &project.path) {
        mcp.push(McpServerInput::Unknown {
            name,
            note: "Installed server",
        });
    }

    Ok(Json(assemble(ContextInputs {
        skills: visible_skills(&agent, &project.path),
        agent,
        agent_label: label,
        grove_instruction: preview.grove,
        files,
        memory_enabled,
        memory_instruction: preview.memory.map(str::to_string),
        memory_tool_tokens: memory_tools.iter().map(estimate_tool).sum(),
        mcp,
        now: Utc::now(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimator_counts_latin_by_four_and_wide_chars_one_each() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("你好世界"), 4);
        assert_eq!(estimate_tokens("hi 你好"), 1 + 2);
        assert_eq!(estimate_tokens("カタカナ한국어"), 7);
    }

    #[test]
    fn agent_mapping_by_family() {
        assert_eq!(agent_family("claude-acp"), "claude");
        assert_eq!(agent_native_file("claude-acp"), "CLAUDE.md");
        assert_eq!(agent_native_file("gemini-cli"), "GEMINI.md");
        assert_eq!(agent_native_file("codex-acp"), "AGENTS.md");
        assert_eq!(agent_label("codex-acp"), "Codex");
        assert_eq!(agent_label("opencode"), "opencode");
    }

    fn inputs() -> ContextInputs {
        let now = DateTime::parse_from_rfc3339("2026-11-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        ContextInputs {
            agent: "claude-acp".into(),
            agent_label: "Claude Code".into(),
            grove_instruction: "a".repeat(400),
            files: vec![InstructionFile {
                name: "CLAUDE.md".into(),
                content: "b".repeat(800),
                modified: Some(now - chrono::Duration::days(2)),
                note: "Read by Claude Code".into(),
            }],
            memory_enabled: true,
            memory_instruction: Some("c".repeat(40)),
            memory_tool_tokens: 30,
            mcp: vec![
                McpServerInput::Known {
                    name: "grove".into(),
                    tokens: 500,
                },
                McpServerInput::Known {
                    name: "grove_agent".into(),
                    tokens: 700,
                },
                McpServerInput::Unknown {
                    name: "figma".into(),
                    note: "Installed server",
                },
            ],
            skills: vec![("review".into(), "Review code".into())],
            now,
        }
    }

    #[test]
    fn assemble_sums_sources_and_flags_unknown_mcp_schemas() {
        let response = assemble(inputs());
        let ids: Vec<_> = response.sources.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["instructions", "memory", "mcp", "skills"]);
        let instructions = &response.sources[0];
        assert_eq!(instructions.tokens, 100 + 200);
        assert_eq!(
            instructions.detail,
            "Grove session instructions · CLAUDE.md · edited 2d ago"
        );
        assert_eq!(response.sources[1].tokens, 10 + 30);
        let mcp = &response.sources[2];
        assert_eq!(mcp.tokens, 1200);
        assert!(mcp.partial);
        assert_eq!(mcp.items[2].tokens, None);
        assert!(mcp.detail.starts_with("grove, grove_agent, figma"));
        // "- review: Review code\n" is 22 chars → 6 tokens.
        assert_eq!(response.sources[3].tokens, 6);
        assert!(response.sources[3].detail.starts_with("1 skill ·"));
        assert_eq!(response.total_tokens, 300 + 40 + 1200 + 6);
        assert!(response.partial);
    }

    #[test]
    fn assemble_reports_disabled_sources_as_zero() {
        let mut input = inputs();
        input.memory_enabled = false;
        input.memory_instruction = None;
        input.skills.clear();
        input.mcp.truncate(2);
        let response = assemble(input);
        let memory = &response.sources[1];
        assert!(!memory.enabled);
        assert_eq!(memory.tokens, 0);
        assert!(memory.items.is_empty());
        assert!(!response.sources[2].partial);
        assert_eq!(response.sources[2].detail, "grove, grove_agent");
        let skills = &response.sources[3];
        assert!(!skills.enabled);
        assert_eq!(skills.detail, "None installed for Claude Code");
        assert!(!response.partial);
    }

    #[test]
    fn names_preview_truncates() {
        assert_eq!(names_preview(&["a", "b", "c", "d", "e"], 3), "a, b, c +2");
    }

    #[test]
    fn builtin_tool_surfaces_have_estimates() {
        let (tools, instructions) = crate::cli::mcp::task_surface(false);
        assert!(!tools.is_empty());
        assert!(estimate_tokens(instructions) > 0);
        assert!(tools.iter().map(estimate_tool).sum::<u64>() > 0);
    }
}
