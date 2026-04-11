//! Skills storage — agent definitions, sources, manifest, installed records

use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

// TOML wrapper structs (still used by API serialization)
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
            // `value` here is still the raw ">" / "|" token from split_once,
            // not the expanded content (which is in `resolved_value`).
            // If block scalar consumed extra lines, `i` was already advanced — don't increment again.
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

pub fn repos_dir() -> PathBuf {
    grove_dir().join("skills").join("repos")
}

/// Compute a deterministic 16-char hex key from a URL (FNV-1a, stable across Rust versions)
pub fn compute_repo_key(url: &str) -> String {
    const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET_BASIS;
    for byte in url.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
    }
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
// SQLite CRUD — Agents
// ============================================================================

pub fn load_agents() -> AgentsFile {
    let conn = crate::storage::database::connection();

    // Custom agents: is_builtin = 0
    let custom_agents: Vec<AgentDef> = (|| {
        let mut stmt = conn
            .prepare(
                "SELECT id, display_name, global_skills_dir, project_skills_dir, \
             shared_group, icon_id, enabled FROM skill_agents WHERE is_builtin = 0",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AgentDef {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    global_skills_dir: row.get(2)?,
                    project_skills_dir: row.get(3)?,
                    shared_group: row.get(4)?,
                    icon_id: row.get(5)?,
                    enabled: row.get::<_, i32>(6)? != 0,
                    is_builtin: false,
                })
            })
            .ok()?;
        Some(rows.filter_map(|r| r.ok()).collect())
    })()
    .unwrap_or_default();

    // Builtin overrides: is_builtin = 1
    let builtin_overrides: Vec<BuiltinOverride> = (|| {
        let mut stmt = conn
            .prepare("SELECT id, enabled FROM skill_agents WHERE is_builtin = 1")
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok(BuiltinOverride {
                    id: row.get(0)?,
                    enabled: row.get::<_, i32>(1)? != 0,
                })
            })
            .ok()?;
        Some(rows.filter_map(|r| r.ok()).collect())
    })()
    .unwrap_or_default();

    AgentsFile {
        builtin_overrides,
        custom_agents,
    }
}

pub fn save_agents(data: &AgentsFile) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    tx.execute("DELETE FROM skill_agents", [])?;

    // Insert custom agents
    for agent in &data.custom_agents {
        tx.execute(
            "INSERT INTO skill_agents (id, display_name, global_skills_dir, project_skills_dir, \
             shared_group, icon_id, enabled, is_builtin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
            params![
                agent.id,
                agent.display_name,
                agent.global_skills_dir,
                agent.project_skills_dir,
                agent.shared_group,
                agent.icon_id,
                agent.enabled as i32,
            ],
        )?;
    }

    // Insert builtin overrides — fill display_name/dirs from builtin_agents() constants
    let builtins = builtin_agents();
    for ovr in &data.builtin_overrides {
        if let Some(b) = builtins.iter().find(|a| a.id == ovr.id) {
            tx.execute(
                "INSERT INTO skill_agents (id, display_name, global_skills_dir, project_skills_dir, \
                 shared_group, icon_id, enabled, is_builtin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![
                    ovr.id,
                    b.display_name,
                    b.global_skills_dir,
                    b.project_skills_dir,
                    b.shared_group,
                    b.icon_id,
                    ovr.enabled as i32,
                ],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Return all agents: builtin (from code, with persisted enabled overrides) + custom (from DB)
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
    let conn = crate::storage::database::connection();

    // Check if override row already exists
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM skill_agents WHERE id = ?1 AND is_builtin = 1",
            params![id],
            |row| row.get::<_, i32>(0),
        )
        .unwrap_or(0)
        > 0;

    if exists {
        conn.execute(
            "UPDATE skill_agents SET enabled = ?1 WHERE id = ?2 AND is_builtin = 1",
            params![enabled as i32, id],
        )?;
    } else {
        // Insert a new row, getting display_name/dirs from builtin_agents()
        let builtins = builtin_agents();
        if let Some(b) = builtins.iter().find(|a| a.id == id) {
            conn.execute(
                "INSERT INTO skill_agents (id, display_name, global_skills_dir, project_skills_dir, \
                 shared_group, icon_id, enabled, is_builtin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)",
                params![
                    id,
                    b.display_name,
                    b.global_skills_dir,
                    b.project_skills_dir,
                    b.shared_group,
                    b.icon_id,
                    enabled as i32,
                ],
            )?;
        }
    }

    Ok(())
}

/// Check if an agent ID belongs to a builtin agent
pub fn is_builtin_agent(id: &str) -> bool {
    builtin_agents().iter().any(|a| a.id == id)
}

/// Add a custom agent
pub fn add_custom_agent(agent: AgentDef) -> Result<()> {
    let conn = crate::storage::database::connection();
    conn.execute(
        "INSERT INTO skill_agents (id, display_name, global_skills_dir, project_skills_dir, \
         shared_group, icon_id, enabled, is_builtin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)",
        params![
            agent.id,
            agent.display_name,
            agent.global_skills_dir,
            agent.project_skills_dir,
            agent.shared_group,
            agent.icon_id,
            agent.enabled as i32,
        ],
    )?;
    Ok(())
}

/// Update a custom agent
pub fn update_custom_agent(
    id: &str,
    display_name: String,
    global_dir: String,
    project_dir: String,
) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let rows = conn.execute(
        "UPDATE skill_agents SET display_name = ?1, global_skills_dir = ?2, \
         project_skills_dir = ?3 WHERE id = ?4 AND is_builtin = 0",
        params![display_name, global_dir, project_dir, id],
    )?;
    Ok(rows > 0)
}

/// Delete a custom agent
pub fn delete_custom_agent(id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let rows = conn.execute(
        "DELETE FROM skill_agents WHERE id = ?1 AND is_builtin = 0",
        params![id],
    )?;
    Ok(rows > 0)
}

// ============================================================================
// SQLite CRUD — Sources
// ============================================================================

pub fn load_sources() -> SourcesFile {
    let conn = crate::storage::database::connection();
    let sources: Vec<SkillSourceDef> = (|| {
        let mut stmt = conn
            .prepare(
                "SELECT name, source_type, url, subpath, repo_key, last_synced, local_head \
             FROM skill_sources",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                let last_synced_str: Option<String> = row.get(5)?;
                let last_synced = last_synced_str.and_then(|s| {
                    DateTime::parse_from_rfc3339(&s)
                        .ok()
                        .map(|d| d.with_timezone(&Utc))
                });
                Ok(SkillSourceDef {
                    name: row.get(0)?,
                    source_type: row.get(1)?,
                    url: row.get(2)?,
                    subpath: row.get(3)?,
                    repo_key: row.get(4)?,
                    last_synced,
                    local_head: row.get(6)?,
                })
            })
            .ok()?;
        Some(rows.filter_map(|r| r.ok()).collect())
    })()
    .unwrap_or_default();
    SourcesFile { sources }
}

pub fn save_sources(data: &SourcesFile) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    tx.execute("DELETE FROM skill_sources", [])?;

    for src in &data.sources {
        let last_synced_str = src.last_synced.map(|d| d.to_rfc3339());
        tx.execute(
            "INSERT INTO skill_sources (name, source_type, url, subpath, repo_key, last_synced, local_head) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                src.name,
                src.source_type,
                src.url,
                src.subpath,
                src.repo_key,
                last_synced_str,
                src.local_head,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ============================================================================
// SQLite CRUD — Manifest
// ============================================================================

pub fn load_manifest() -> ManifestFile {
    let conn = crate::storage::database::connection();
    let skills: Vec<SkillManifestEntry> = (|| {
        let mut stmt = conn.prepare(
            "SELECT repo_key, repo_path, name, description, source, relative_path, license, author \
             FROM skill_manifest",
        ).ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SkillManifestEntry {
                    repo_key: row.get(0)?,
                    repo_path: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    source: row.get(4)?,
                    relative_path: row.get(5)?,
                    license: row.get(6)?,
                    author: row.get(7)?,
                })
            })
            .ok()?;
        Some(rows.filter_map(|r| r.ok()).collect())
    })()
    .unwrap_or_default();
    ManifestFile { skills }
}

pub fn save_manifest(data: &ManifestFile) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    tx.execute("DELETE FROM skill_manifest", [])?;

    for entry in &data.skills {
        tx.execute(
            "INSERT INTO skill_manifest (repo_key, repo_path, name, description, source, \
             relative_path, license, author) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                entry.repo_key,
                entry.repo_path,
                entry.name,
                entry.description,
                entry.source,
                entry.relative_path,
                entry.license,
                entry.author,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ============================================================================
// SQLite CRUD — Installed
// ============================================================================

pub fn load_installed() -> InstalledFile {
    let conn = crate::storage::database::connection();

    // Query 1: base records
    let base_records: Vec<(String, String, String, String, String)> = (|| {
        let mut stmt = conn
            .prepare(
                "SELECT repo_key, repo_path, source_name, skill_name, installed_at \
             FROM skill_installed",
            )
            .ok()?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .ok()?;
        Some(rows.filter_map(|r| r.ok()).collect())
    })()
    .unwrap_or_default();

    if base_records.is_empty() {
        return InstalledFile::default();
    }

    // Query 2: all global agents in one shot, keyed by (repo_key, repo_path)
    let mut agents_map: HashMap<(String, String), Vec<ScopeAgentRef>> = HashMap::new();
    if let Ok(mut stmt) = conn
        .prepare("SELECT repo_key, repo_path, agent_id, symlink_path FROM skill_installed_agents")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        }) {
            for row in rows.flatten() {
                agents_map
                    .entry((row.0, row.1))
                    .or_default()
                    .push(ScopeAgentRef {
                        agent_id: row.2,
                        symlink_path: row.3,
                    });
            }
        }
    }

    // Query 3: all project installs in one shot, keyed by (repo_key, repo_path)
    let mut projects_map: HashMap<(String, String), HashMap<String, Vec<ScopeAgentRef>>> =
        HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT repo_key, repo_path, project_path, agent_id, symlink_path FROM skill_installed_projects",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }) {
            for row in rows.flatten() {
                projects_map
                    .entry((row.0, row.1))
                    .or_default()
                    .entry(row.2)
                    .or_default()
                    .push(ScopeAgentRef {
                        agent_id: row.3,
                        symlink_path: row.4,
                    });
            }
        }
    }

    // Assemble from maps
    let mut installed = Vec::with_capacity(base_records.len());
    for (repo_key, repo_path, source_name, skill_name, installed_at_str) in base_records {
        let installed_at = DateTime::parse_from_rfc3339(&installed_at_str)
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());

        let key = (repo_key.clone(), repo_path.clone());
        let global_agents = agents_map.remove(&key).unwrap_or_default();
        let project_installs = projects_map
            .remove(&key)
            .unwrap_or_default()
            .into_iter()
            .map(|(project_path, agents)| ProjectInstall {
                project_path,
                agents,
            })
            .collect();

        installed.push(InstalledSkillDef {
            repo_key,
            repo_path,
            source_name,
            skill_name,
            installed_at,
            global_agents,
            project_installs,
        });
    }

    InstalledFile { installed }
}

pub fn save_installed(data: &InstalledFile) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    // CASCADE handles child tables
    tx.execute("DELETE FROM skill_installed", [])?;

    for skill in &data.installed {
        let installed_at_str = skill.installed_at.to_rfc3339();
        tx.execute(
            "INSERT INTO skill_installed (repo_key, repo_path, source_name, skill_name, installed_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                skill.repo_key,
                skill.repo_path,
                skill.source_name,
                skill.skill_name,
                installed_at_str,
            ],
        )?;

        // Insert global agents
        for agent in &skill.global_agents {
            tx.execute(
                "INSERT INTO skill_installed_agents (repo_key, repo_path, agent_id, symlink_path) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    skill.repo_key,
                    skill.repo_path,
                    agent.agent_id,
                    agent.symlink_path
                ],
            )?;
        }

        // Insert project installs
        for proj in &skill.project_installs {
            for agent in &proj.agents {
                tx.execute(
                    "INSERT INTO skill_installed_projects \
                     (repo_key, repo_path, project_path, agent_id, symlink_path) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        skill.repo_key,
                        skill.repo_path,
                        proj.project_path,
                        agent.agent_id,
                        agent.symlink_path,
                    ],
                )?;
            }
        }
    }

    tx.commit()?;
    Ok(())
}

// ============================================================================
// Builtin Agents
// ============================================================================

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
            id: "gemini-cli".into(),
            display_name: "Gemini".into(),
            global_skills_dir: "~/.gemini/skills".into(),
            project_skills_dir: ".gemini/skills".into(),
            shared_group: None,
            icon_id: Some("gemini".into()),
            enabled: false,
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
            id: "hermes".into(),
            display_name: "Hermes".into(),
            global_skills_dir: "~/.hermes/skills".into(),
            project_skills_dir: String::new(),
            shared_group: None,
            icon_id: Some("hermes".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "junie".into(),
            display_name: "Junie".into(),
            global_skills_dir: "~/.junie/skills".into(),
            project_skills_dir: ".junie/skills".into(),
            shared_group: None,
            icon_id: Some("junie".into()),
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
            id: "kiro".into(),
            display_name: "Kiro".into(),
            global_skills_dir: "~/.kiro/skills".into(),
            project_skills_dir: ".kiro/skills".into(),
            shared_group: None,
            icon_id: Some("kiro".into()),
            enabled: false,
            is_builtin: true,
        },
        AgentDef {
            id: "openclaw".into(),
            display_name: "OpenClaw".into(),
            global_skills_dir: "~/.openclaw/skills".into(),
            project_skills_dir: String::new(),
            shared_group: None,
            icon_id: Some("openclaw".into()),
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
            id: "windsurf".into(),
            display_name: "Windsurf".into(),
            global_skills_dir: "~/.codeium/windsurf/skills".into(),
            project_skills_dir: ".windsurf/skills".into(),
            shared_group: None,
            icon_id: Some("windsurf".into()),
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
        assert_eq!(agents.len(), 14);
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
