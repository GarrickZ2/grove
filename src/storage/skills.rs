//! Skills storage — agent definitions, sources, manifest, installed records

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use super::grove_dir;
use crate::error::Result;

// ============================================================================
// Data Structures
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDef {
    pub id: String,
    pub display_name: String,
    pub global_skills_dir: String,
    pub project_skills_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_id: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub is_builtin: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSourceDef {
    pub name: String,
    pub source_type: String,
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subpath: Option<String>,
    /// Stable identifier: hash(url). Present for both git and local sources.
    #[serde(default)]
    pub repo_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_synced: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_head: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifestEntry {
    pub name: String,
    pub description: String,
    pub source: String,
    /// Source's repo_key (hash of URL)
    #[serde(default)]
    pub repo_key: String,
    /// Path relative to the source's scan directory
    pub relative_path: String,
    /// Absolute path from repo root: subpath + "/" + relative_path (normalized)
    #[serde(default)]
    pub repo_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

/// Agent reference within a single scope (global or project)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopeAgentRef {
    pub agent_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_path: Option<String>,
}

/// A project-level install group: agents installed for a specific project
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInstall {
    pub project_path: String,
    #[serde(default)]
    pub agents: Vec<ScopeAgentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkillDef {
    /// Unique key part 1: hash(url) of the source
    #[serde(default)]
    pub repo_key: String,
    /// Unique key part 2: absolute path from repo root
    #[serde(default)]
    pub repo_path: String,
    /// Source display name
    #[serde(default)]
    pub source_name: String,
    /// SKILL.md name — also used as symlink directory name
    #[serde(default)]
    pub skill_name: String,
    pub installed_at: DateTime<Utc>,
    /// Global-scope agent installs
    #[serde(default)]
    pub global_agents: Vec<ScopeAgentRef>,
    /// Project-scope installs, grouped by project path
    #[serde(default)]
    pub project_installs: Vec<ProjectInstall>,
}

/// Stored override for a builtin agent (only the enabled flag is persisted)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuiltinOverride {
    pub id: String,
    pub enabled: bool,
}

// TOML wrapper structs
#[derive(Debug, Serialize, Deserialize, Default)]
pub struct AgentsFile {
    /// Enabled/disabled overrides for builtin agents
    #[serde(default)]
    pub builtin_overrides: Vec<BuiltinOverride>,
    /// User-defined custom agents (full definition)
    #[serde(default)]
    pub custom_agents: Vec<AgentDef>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct SourcesFile {
    #[serde(default)]
    pub sources: Vec<SkillSourceDef>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct ManifestFile {
    #[serde(default)]
    pub skills: Vec<SkillManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct InstalledFile {
    #[serde(default)]
    pub installed: Vec<InstalledSkillDef>,
}

// ============================================================================
// SKILL.md Parsing
// ============================================================================

/// Parsed SKILL.md structure
///
/// Official spec fields: name, description, license, compatibility, allowed-tools, metadata
/// Non-standard top-level fields are collected into the `metadata` map alongside
/// entries from the `metadata:` YAML block.
pub struct ParsedSkillMd {
    // --- Official required fields ---
    pub name: String,
    pub description: String,
    // --- Official optional fields ---
    pub license: Option<String>,
    pub compatibility: Option<String>,
    pub allowed_tools: Option<String>,
    // --- Arbitrary key-value: official `metadata:` block + non-standard top-level keys ---
    pub metadata: std::collections::BTreeMap<String, String>,
    // --- Markdown body after frontmatter ---
    pub body: String,
}

/// Parse SKILL.md: extract YAML frontmatter between `---` markers, then parse `key: value` lines.
///
/// Official fields (`name`, `description`, `license`, `compatibility`, `allowed-tools`) are
/// extracted into dedicated struct fields. The `metadata:` block and any non-standard top-level
/// keys (e.g. `author`, `version`, `category`, `tags`) are collected into a generic map.
pub fn parse_skill_md(content: &str) -> Option<ParsedSkillMd> {
    let trimmed = content.trim();
    if !trimmed.starts_with("---") {
        return None;
    }

    // Find the closing ---
    let after_first = &trimmed[3..];
    let end_idx = after_first.find("\n---")?;
    let frontmatter = &after_first[..end_idx];
    let body_start = 3 + end_idx + 4; // skip "---\n" + frontmatter + "\n---"
    let body = if body_start < trimmed.len() {
        trimmed[body_start..].trim().to_string()
    } else {
        String::new()
    };

    let mut name = None;
    let mut description = None;
    let mut license = None;
    let mut compatibility = None;
    let mut allowed_tools = None;
    let mut metadata = std::collections::BTreeMap::new();

    let mut in_metadata = false;
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            i += 1;
            continue;
        }

        if trimmed_line == "metadata:" {
            in_metadata = true;
            i += 1;
            continue;
        }

        if let Some((key, value)) = trimmed_line.split_once(':') {
            let raw_key = key;
            let key = key.trim();
            let value = value.trim().trim_matches('"');

            if in_metadata {
                if raw_key.starts_with(' ') || raw_key.starts_with('\t') {
                    let key = key.trim();
                    if !key.is_empty() && !value.is_empty() {
                        metadata.insert(key.to_string(), value.to_string());
                    }
                    i += 1;
                    continue;
                }
                // Not indented — leaving metadata block
                in_metadata = false;
            }

            // Handle YAML block scalars (> folded, | literal)
            let resolved_value = if value == ">" || value == "|" {
                let is_folded = value == ">";
                let mut block_lines = Vec::new();
                i += 1;
                while i < lines.len() {
                    let next = lines[i];
                    // Block continues while lines are indented
                    if next.starts_with(' ') || next.starts_with('\t') {
                        block_lines.push(next.trim());
                        i += 1;
                    } else {
                        break;
                    }
                }
                if is_folded {
                    block_lines.join(" ")
                } else {
                    block_lines.join("\n")
                }
            } else {
                value.to_string()
            };

            match key {
                // Official required
                "name" => name = Some(resolved_value),
                "description" => description = Some(resolved_value),
                // Official optional
                "license" => license = Some(resolved_value),
                "compatibility" => compatibility = Some(resolved_value),
                "allowed-tools" => allowed_tools = Some(resolved_value),
                "metadata" => in_metadata = true,
                // Non-standard → generic metadata
                _ => {
                    if !resolved_value.is_empty() {
                        metadata.insert(key.to_string(), resolved_value);
                    }
                }
            }
            // If we consumed block scalar lines, don't increment i again
            if !(value == ">" || value == "|") {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    Some(ParsedSkillMd {
        name: name?,
        description: description.unwrap_or_default(),
        license,
        compatibility,
        allowed_tools,
        metadata,
        body,
    })
}

// ============================================================================
// Directory Helpers
// ============================================================================

pub fn skills_dir() -> PathBuf {
    grove_dir().join("skills")
}

pub fn repos_dir() -> PathBuf {
    skills_dir().join("repos")
}

/// Compute a deterministic 16-char hex key from a URL
pub fn compute_repo_key(url: &str) -> String {
    let mut hasher = DefaultHasher::new();
    url.hash(&mut hasher);
    let hash = hasher.finish();
    format!("{:016x}", hash)
}

/// Compute repo_path: absolute path from repo root = subpath + "/" + relative_path (normalized)
pub fn compute_repo_path(subpath: Option<&str>, relative_path: &str) -> String {
    match subpath {
        Some(sub) if !sub.is_empty() => {
            let sub = sub.trim_matches('/');
            let rel = relative_path.trim_matches('/');
            if rel.is_empty() {
                sub.to_string()
            } else {
                format!("{}/{}", sub, rel)
            }
        }
        _ => relative_path.trim_matches('/').to_string(),
    }
}

/// Check if two subpaths overlap (one contains or equals the other)
pub fn subpaths_overlap(a: Option<&str>, b: Option<&str>) -> bool {
    let norm = |s: Option<&str>| -> String {
        match s {
            Some(v) if !v.is_empty() => {
                let trimmed = v.trim_matches('/');
                if trimmed.is_empty() {
                    String::new()
                } else {
                    trimmed.to_string()
                }
            }
            _ => String::new(),
        }
    };
    let na = norm(a);
    let nb = norm(b);
    // Either is whole repo (empty) → always overlaps
    if na.is_empty() || nb.is_empty() {
        return true;
    }
    if na == nb {
        return true;
    }
    // Check containment
    na.starts_with(&format!("{}/", nb)) || nb.starts_with(&format!("{}/", na))
}

// ============================================================================
// TOML CRUD
// ============================================================================

pub fn load_agents() -> AgentsFile {
    let path = skills_dir().join("agents.toml");
    if !path.exists() {
        return AgentsFile::default();
    }
    super::load_toml(&path).unwrap_or_default()
}

pub fn save_agents(data: &AgentsFile) -> Result<()> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir)?;
    super::save_toml(&dir.join("agents.toml"), data)
}

pub fn load_sources() -> SourcesFile {
    let path = skills_dir().join("sources.toml");
    if !path.exists() {
        return SourcesFile::default();
    }
    super::load_toml(&path).unwrap_or_default()
}

pub fn save_sources(data: &SourcesFile) -> Result<()> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir)?;
    super::save_toml(&dir.join("sources.toml"), data)
}

pub fn load_manifest() -> ManifestFile {
    let path = skills_dir().join("manifest.toml");
    if !path.exists() {
        return ManifestFile::default();
    }
    super::load_toml(&path).unwrap_or_default()
}

pub fn save_manifest(data: &ManifestFile) -> Result<()> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir)?;
    super::save_toml(&dir.join("manifest.toml"), data)
}

pub fn load_installed() -> InstalledFile {
    let path = skills_dir().join("installed.toml");
    if !path.exists() {
        return InstalledFile::default();
    }
    super::load_toml(&path).unwrap_or_default()
}

pub fn save_installed(data: &InstalledFile) -> Result<()> {
    let dir = skills_dir();
    std::fs::create_dir_all(&dir)?;
    super::save_toml(&dir.join("installed.toml"), data)
}

// ============================================================================
// Builtin Agents Seeding
// ============================================================================

/// Return all agents: builtin (from code, with persisted enabled overrides) + custom (from toml)
pub fn get_all_agents() -> Vec<AgentDef> {
    let file = load_agents();
    let builtins = builtin_agents();

    let mut agents: Vec<AgentDef> = builtins
        .into_iter()
        .map(|mut b| {
            // Apply persisted enabled override if present
            if let Some(ovr) = file.builtin_overrides.iter().find(|o| o.id == b.id) {
                b.enabled = ovr.enabled;
            }
            b
        })
        .collect();

    // Append custom agents
    agents.extend(file.custom_agents.iter().cloned());
    agents
}

/// Persist the enabled flag for a builtin agent
pub fn set_builtin_enabled(id: &str, enabled: bool) -> Result<()> {
    let mut file = load_agents();
    if let Some(ovr) = file.builtin_overrides.iter_mut().find(|o| o.id == id) {
        ovr.enabled = enabled;
    } else {
        file.builtin_overrides.push(BuiltinOverride {
            id: id.to_string(),
            enabled,
        });
    }
    save_agents(&file)
}

/// Check if an agent ID belongs to a builtin agent
pub fn is_builtin_agent(id: &str) -> bool {
    builtin_agents().iter().any(|a| a.id == id)
}

/// Add a custom agent
pub fn add_custom_agent(agent: AgentDef) -> Result<()> {
    let mut file = load_agents();
    file.custom_agents.push(agent);
    save_agents(&file)
}

/// Update a custom agent
pub fn update_custom_agent(
    id: &str,
    display_name: String,
    global_dir: String,
    project_dir: String,
) -> Result<bool> {
    let mut file = load_agents();
    if let Some(agent) = file.custom_agents.iter_mut().find(|a| a.id == id) {
        agent.display_name = display_name;
        agent.global_skills_dir = global_dir;
        agent.project_skills_dir = project_dir;
        save_agents(&file)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Delete a custom agent
pub fn delete_custom_agent(id: &str) -> Result<bool> {
    let mut file = load_agents();
    let before = file.custom_agents.len();
    file.custom_agents.retain(|a| a.id != id);
    if file.custom_agents.len() < before {
        save_agents(&file)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

fn builtin_agents() -> Vec<AgentDef> {
    vec![
        AgentDef {
            id: "claude-code".into(),
            display_name: "Claude Code".into(),
            global_skills_dir: "~/.claude/skills".into(),
            project_skills_dir: ".claude/skills".into(),
            shared_group: None,
            icon_id: Some("claude".into()),
            enabled: true,
            is_builtin: true,
        },
        AgentDef {
            id: "cursor".into(),
            display_name: "Cursor".into(),
            global_skills_dir: "~/.cursor/skills".into(),
            project_skills_dir: ".cursor/skills".into(),
            shared_group: None,
            icon_id: Some("cursor".into()),
            enabled: true,
            is_builtin: true,
        },
        AgentDef {
            id: "copilot".into(),
            display_name: "GitHub Copilot".into(),
            global_skills_dir: "~/.copilot/skills".into(),
            project_skills_dir: ".github/skills".into(),
            shared_group: None,
            icon_id: Some("copilot".into()),
            enabled: true,
            is_builtin: true,
        },
        AgentDef {
            id: "windsurf".into(),
            display_name: "Windsurf".into(),
            global_skills_dir: "~/.codeium/windsurf/skills".into(),
            project_skills_dir: ".windsurf/skills".into(),
            shared_group: None,
            icon_id: Some("windsurf".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "gemini-cli".into(),
            display_name: "Gemini CLI".into(),
            global_skills_dir: "~/.gemini/skills".into(),
            project_skills_dir: ".gemini/skills".into(),
            shared_group: None,
            icon_id: Some("gemini".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "trae".into(),
            display_name: "Trae".into(),
            global_skills_dir: "~/.trae/skills".into(),
            project_skills_dir: ".trae/skills".into(),
            shared_group: None,
            icon_id: Some("trae".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "qwen".into(),
            display_name: "Qwen".into(),
            global_skills_dir: "~/.qwen/skills".into(),
            project_skills_dir: ".qwen/skills".into(),
            shared_group: None,
            icon_id: Some("qwen".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "kimi".into(),
            display_name: "Kimi".into(),
            global_skills_dir: "~/.kimi/skills".into(),
            project_skills_dir: ".kimi/skills".into(),
            shared_group: None,
            icon_id: Some("kimi".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "codex".into(),
            display_name: "CodeX".into(),
            global_skills_dir: "~/.agents/skills".into(),
            project_skills_dir: ".agents/skills".into(),
            shared_group: None,
            icon_id: Some("openai".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "opencode".into(),
            display_name: "OpenCode".into(),
            global_skills_dir: "~/.config/opencode/skills".into(),
            project_skills_dir: ".opencode/skills".into(),
            shared_group: None,
            icon_id: Some("opencode".into()),
            enabled: false,
            is_builtin: true,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_repo_key() {
        let key1 = compute_repo_key("https://github.com/anthropics/skills");
        let key2 = compute_repo_key("https://github.com/anthropics/skills");
        let key3 = compute_repo_key("https://github.com/other/repo");
        assert_eq!(key1, key2);
        assert_ne!(key1, key3);
        assert_eq!(key1.len(), 16);
    }

    #[test]
    fn test_parse_skill_md() {
        let content = r#"---
name: code-review
description: Review code changes with best practices
license: Apache-2.0
metadata:
  author: anthropics
  version: "1.2"
---

# Code Review

Use this skill for code reviews.
"#;
        let parsed = parse_skill_md(content).unwrap();
        assert_eq!(parsed.name, "code-review");
        assert_eq!(
            parsed.description,
            "Review code changes with best practices"
        );
        assert_eq!(parsed.license.as_deref(), Some("Apache-2.0"));
        // author from metadata: block
        assert_eq!(
            parsed.metadata.get("author").map(|s| s.as_str()),
            Some("anthropics")
        );
        assert!(parsed.body.contains("# Code Review"));
    }

    #[test]
    fn test_parse_skill_md_full_spec() {
        let content = r#"---
name: test-generator
description: "Generate comprehensive unit and integration tests"
version: 0.8.0
author: AgentKit Community
category: development
tags: [testing, unit-test, tdd]
license: MIT
compatibility: Claude Code, Cursor
allowed-tools: Read, Grep, Glob, Write, Bash(go test *)
---

Body content here.
"#;
        let parsed = parse_skill_md(content).unwrap();
        // Official fields
        assert_eq!(parsed.name, "test-generator");
        assert_eq!(parsed.license.as_deref(), Some("MIT"));
        assert_eq!(parsed.compatibility.as_deref(), Some("Claude Code, Cursor"));
        assert_eq!(
            parsed.allowed_tools.as_deref(),
            Some("Read, Grep, Glob, Write, Bash(go test *)")
        );
        // Non-standard → metadata map
        assert_eq!(
            parsed.metadata.get("version").map(|s| s.as_str()),
            Some("0.8.0")
        );
        assert_eq!(
            parsed.metadata.get("author").map(|s| s.as_str()),
            Some("AgentKit Community")
        );
        assert_eq!(
            parsed.metadata.get("category").map(|s| s.as_str()),
            Some("development")
        );
        assert_eq!(
            parsed.metadata.get("tags").map(|s| s.as_str()),
            Some("[testing, unit-test, tdd]")
        );
        // Body
        assert_eq!(parsed.body, "Body content here.");
    }

    #[test]
    fn test_parse_skill_md_block_scalar() {
        let content = r#"---
name: sql-helper
description: >
  SQL query optimization skill for relational databases.
  Use when writing complex joins, indexing strategies,
  or analyzing slow query performance.
---

# SQL Helper Skill
"#;
        let parsed = parse_skill_md(content).unwrap();
        assert_eq!(parsed.name, "sql-helper");
        assert!(
            parsed.description.starts_with("SQL query optimization"),
            "description should contain folded text, got: {}",
            parsed.description
        );
        assert!(
            parsed.description.contains("analyzing slow query"),
            "folded scalar should join continuation lines"
        );
    }

    #[test]
    fn test_parse_skill_md_literal_block_scalar() {
        let content = r#"---
name: test
description: |
  Line one.
  Line two.
---
"#;
        let parsed = parse_skill_md(content).unwrap();
        assert_eq!(parsed.name, "test");
        assert!(parsed.description.contains("Line one.\nLine two."));
    }

    #[test]
    fn test_parse_skill_md_no_frontmatter() {
        assert!(parse_skill_md("# Just markdown").is_none());
    }

    #[test]
    fn test_builtin_agents_count() {
        let agents = builtin_agents();
        assert_eq!(agents.len(), 10);
    }

    #[test]
    fn test_compute_repo_path() {
        assert_eq!(
            compute_repo_path(Some("coding/"), "code-review"),
            "coding/code-review"
        );
        assert_eq!(
            compute_repo_path(None, "coding/code-review"),
            "coding/code-review"
        );
        assert_eq!(compute_repo_path(Some(""), "code-review"), "code-review");
        assert_eq!(
            compute_repo_path(Some("/coding/"), "/code-review/"),
            "coding/code-review"
        );
        assert_eq!(compute_repo_path(Some("sub"), ""), "sub");
    }

    #[test]
    fn test_subpaths_overlap() {
        // Same subpath
        assert!(subpaths_overlap(Some("coding"), Some("coding")));
        // One is whole repo
        assert!(subpaths_overlap(None, Some("coding")));
        assert!(subpaths_overlap(Some("coding"), None));
        assert!(subpaths_overlap(Some(""), Some("coding")));
        // Containment
        assert!(subpaths_overlap(Some("coding"), Some("coding/advanced")));
        assert!(subpaths_overlap(Some("coding/advanced"), Some("coding")));
        // No overlap
        assert!(!subpaths_overlap(Some("coding"), Some("testing")));
        assert!(!subpaths_overlap(Some("coding"), Some("coding-extra")));
    }
}
