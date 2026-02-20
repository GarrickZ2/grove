//! Skills operations — sync, discover, install, uninstall business logic

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use chrono::Utc;

use crate::error::{GroveError, Result};
use crate::storage::skills::{
    self, compute_repo_path, load_installed, load_manifest, load_sources, parse_skill_md,
    repos_dir, save_installed, save_manifest, save_sources, InstalledSkillDef, ProjectInstall,
    ScopeAgentRef, SkillManifestEntry, SkillSourceDef,
};

// ============================================================================
// Git helpers (local to this module)
// ============================================================================

fn git_clone(url: &str, dest: &Path) -> Result<()> {
    let output = Command::new("git")
        .args(["clone", "--depth", "1", url])
        .arg(dest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git clone: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GroveError::git(format!("git clone failed: {}", stderr)));
    }
    Ok(())
}

fn git_pull(repo_path: &Path) -> Result<()> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["pull", "--ff-only"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git pull: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GroveError::git(format!("git pull failed: {}", stderr)));
    }
    Ok(())
}

fn git_rev_parse_head(repo_path: &Path) -> Result<String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "HEAD"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git rev-parse: {}", e)))?;

    if !output.status.success() {
        return Err(GroveError::git("git rev-parse HEAD failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_ls_remote_head(url: &str) -> Result<String> {
    let output = Command::new("git")
        .args(["ls-remote", url, "HEAD"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git ls-remote: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GroveError::git(format!("git ls-remote failed: {}", stderr)));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Format: "<sha>\tHEAD"
    stdout
        .split_whitespace()
        .next()
        .map(|s| s.to_string())
        .ok_or_else(|| GroveError::git("empty ls-remote output"))
}

// ============================================================================
// Discover SKILL.md files
// ============================================================================

/// Recursively scan a directory for SKILL.md files and return manifest entries
fn discover_skills(
    base_dir: &Path,
    source_name: &str,
    repo_key: &str,
    subpath: Option<&str>,
) -> Vec<SkillManifestEntry> {
    let mut entries = Vec::new();

    if !base_dir.exists() || !base_dir.is_dir() {
        return entries;
    }

    for entry in walkdir::WalkDir::new(base_dir)
        .min_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_name() != "SKILL.md" || !entry.file_type().is_file() {
            continue;
        }

        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };

        if let Some(parsed) = parse_skill_md(&content) {
            // relative_path = parent directory path relative to base_dir
            let skill_dir = entry.path().parent().unwrap_or(entry.path());
            let relative_path = skill_dir
                .strip_prefix(base_dir)
                .unwrap_or(skill_dir)
                .to_string_lossy()
                .to_string();

            let repo_path = compute_repo_path(subpath, &relative_path);

            entries.push(SkillManifestEntry {
                name: parsed.name,
                description: parsed.description,
                source: source_name.to_string(),
                repo_key: repo_key.to_string(),
                relative_path,
                repo_path,
                license: parsed.license,
                author: parsed.metadata.get("author").cloned(),
            });
        }
    }

    entries
}

/// Resolve the actual scan directory for a source
fn resolve_source_scan_dir(source: &SkillSourceDef) -> Option<PathBuf> {
    match source.source_type.as_str() {
        "git" => {
            if source.repo_key.is_empty() {
                return None;
            }
            let repo_path = repos_dir().join(&source.repo_key);
            if let Some(subpath) = &source.subpath {
                Some(repo_path.join(subpath))
            } else {
                Some(repo_path)
            }
        }
        "local" => {
            let path = expand_tilde(&source.url);
            Some(PathBuf::from(path))
        }
        _ => None,
    }
}

// ============================================================================
// Sync Operations
// ============================================================================

/// Sync a single source: clone/pull git repo, scan SKILL.md files, update manifest
pub fn sync_source(name: &str) -> Result<SkillSourceDef> {
    let mut sources_file = load_sources();
    let source = sources_file
        .sources
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| GroveError::not_found(format!("Source not found: {}", name)))?
        .clone();

    let now = Utc::now();

    match source.source_type.as_str() {
        "git" => {
            if source.repo_key.is_empty() {
                return Err(GroveError::storage("Git source missing repo_key"));
            }
            let repo_key = &source.repo_key;
            let repo_path = repos_dir().join(repo_key);

            // Clone or pull
            if !repo_path.exists() {
                std::fs::create_dir_all(repos_dir())?;
                git_clone(&source.url, &repo_path)?;
            } else {
                git_pull(&repo_path)?;
            }

            // Get HEAD sha
            let head = git_rev_parse_head(&repo_path)?;

            // Update ALL sources sharing this repo_key
            for s in &mut sources_file.sources {
                if s.repo_key == *repo_key {
                    s.local_head = Some(head.clone());
                    s.last_synced = Some(now);
                }
            }
            save_sources(&sources_file)?;

            // Rebuild manifest for all sources sharing this repo_key
            rebuild_manifest_for_repo_key(repo_key, &sources_file)?;
        }
        "local" => {
            // Update last_synced
            for s in &mut sources_file.sources {
                if s.name == name {
                    s.last_synced = Some(now);
                }
            }
            save_sources(&sources_file)?;

            // Rebuild manifest for this local source
            rebuild_manifest_for_source(name)?;
        }
        _ => {
            return Err(GroveError::storage(format!(
                "Unknown source type: {}",
                source.source_type
            )));
        }
    }

    // Return updated source
    let updated = load_sources();
    updated
        .sources
        .into_iter()
        .find(|s| s.name == name)
        .ok_or_else(|| GroveError::not_found("Source disappeared after sync"))
}

/// Sync all sources (deduplicating git pulls by repo_key)
pub fn sync_all_sources() -> Result<Vec<SkillSourceDef>> {
    let sources_file = load_sources();
    let mut synced_repo_keys = std::collections::HashSet::new();

    for source in &sources_file.sources {
        match source.source_type.as_str() {
            "git" => {
                if !source.repo_key.is_empty() && synced_repo_keys.insert(source.repo_key.clone()) {
                    // First source with this repo_key — sync it (pulls for all)
                    let _ = sync_source(&source.name);
                }
            }
            "local" => {
                let _ = sync_source(&source.name);
            }
            _ => {}
        }
    }

    Ok(load_sources().sources)
}

/// Check for remote updates without pulling
pub fn check_source_updates() -> Result<Vec<SourceUpdateInfo>> {
    let sources_file = load_sources();
    let mut results = Vec::new();
    let mut checked_urls = std::collections::HashMap::new();

    for source in &sources_file.sources {
        if source.source_type != "git" {
            results.push(SourceUpdateInfo {
                name: source.name.clone(),
                has_remote_updates: false,
            });
            continue;
        }

        let has_updates = if let Some(cached) = checked_urls.get(&source.url) {
            *cached
        } else {
            let has = match git_ls_remote_head(&source.url) {
                Ok(remote_head) => source
                    .local_head
                    .as_ref()
                    .map(|local| local != &remote_head)
                    .unwrap_or(true),
                Err(_) => false,
            };
            checked_urls.insert(source.url.clone(), has);
            has
        };

        results.push(SourceUpdateInfo {
            name: source.name.clone(),
            has_remote_updates: has_updates,
        });
    }

    Ok(results)
}

pub struct SourceUpdateInfo {
    pub name: String,
    pub has_remote_updates: bool,
}

// ============================================================================
// Manifest Rebuild
// ============================================================================

/// Rebuild manifest entries for all sources sharing a repo_key
fn rebuild_manifest_for_repo_key(
    repo_key: &str,
    sources_file: &crate::storage::skills::SourcesFile,
) -> Result<()> {
    let mut manifest = load_manifest();

    // Remove entries for all sources with this repo_key
    let source_names: Vec<String> = sources_file
        .sources
        .iter()
        .filter(|s| s.repo_key == repo_key)
        .map(|s| s.name.clone())
        .collect();

    manifest
        .skills
        .retain(|e| !source_names.contains(&e.source));

    // Re-scan each source
    for source in &sources_file.sources {
        if source.repo_key != repo_key {
            continue;
        }
        if let Some(scan_dir) = resolve_source_scan_dir(source) {
            let entries = discover_skills(
                &scan_dir,
                &source.name,
                &source.repo_key,
                source.subpath.as_deref(),
            );
            manifest.skills.extend(entries);
        }
    }

    save_manifest(&manifest)
}

/// Rebuild manifest entries for a single source
fn rebuild_manifest_for_source(name: &str) -> Result<()> {
    let sources_file = load_sources();
    let source = sources_file
        .sources
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| GroveError::not_found(format!("Source not found: {}", name)))?;

    let mut manifest = load_manifest();
    manifest.skills.retain(|e| e.source != name);

    if let Some(scan_dir) = resolve_source_scan_dir(source) {
        let entries = discover_skills(&scan_dir, name, &source.repo_key, source.subpath.as_deref());
        manifest.skills.extend(entries);
    }

    save_manifest(&manifest)
}

// ============================================================================
// Install / Uninstall
// ============================================================================

pub struct InstallRequest {
    pub repo_key: String,
    pub source_name: String,
    pub skill_name: String,
    pub repo_path: String,
    pub relative_path: String,
    pub scope: String,
    pub agents: Vec<InstallAgentEntry>,
    pub project_path: Option<String>,
    pub force: bool,
}

/// Error indicating a symlink name conflict with an existing installed skill
#[derive(Debug)]
pub struct SkillConflict {
    pub conflict_source_name: String,
    pub conflict_skill_name: String,
}

/// Result type for install that can indicate a conflict
pub enum InstallResult {
    Ok(InstalledSkillDef),
    Conflict(SkillConflict),
}

pub struct InstallAgentEntry {
    pub agent_id: String,
}

/// Install a skill: create symlinks in agent skill directories.
///
/// Scope-isolated: installing at "global" only touches global_agents,
/// installing at "project" only touches the matching project's entry.
///
/// Returns `InstallResult::Conflict` if a different skill already occupies the
/// same symlink name and `force` is false.
pub fn install_skill(req: &InstallRequest) -> Result<InstallResult> {
    let sources_file = load_sources();
    let source = sources_file
        .sources
        .iter()
        .find(|s| s.name == req.source_name)
        .ok_or_else(|| GroveError::not_found(format!("Source not found: {}", req.source_name)))?;

    let actual_skill_dir = resolve_actual_skill_dir(source, &req.relative_path)?;
    let all_agents = skills::get_all_agents();

    // --- Conflict detection ---
    let mut installed_file = load_installed();
    let is_same_skill = |i: &InstalledSkillDef| -> bool {
        i.repo_key == req.repo_key && i.repo_path == req.repo_path
    };

    // Check symlink name conflict: different skill with same skill_name
    if let Some(conflict) = installed_file
        .installed
        .iter()
        .find(|i| i.skill_name == req.skill_name && !is_same_skill(i))
    {
        if !req.force {
            return Ok(InstallResult::Conflict(SkillConflict {
                conflict_source_name: conflict.source_name.clone(),
                conflict_skill_name: conflict.skill_name.clone(),
            }));
        }
        // Force: uninstall the conflicting skill first
        let key = conflict.repo_key.clone();
        let path = conflict.repo_path.clone();
        uninstall_skill_internal(&mut installed_file, &key, &path);
    }

    // Create symlinks for requested agents, build ScopeAgentRefs
    let mut new_refs = Vec::new();
    for agent_entry in &req.agents {
        let agent = all_agents
            .iter()
            .find(|a| a.id == agent_entry.agent_id)
            .ok_or_else(|| {
                GroveError::not_found(format!("Agent not found: {}", agent_entry.agent_id))
            })?;

        let target_dir = resolve_agent_target_dir(agent, &req.scope, req.project_path.as_deref())?;
        std::fs::create_dir_all(&target_dir)?;

        let symlink_path = target_dir.join(&req.skill_name);

        // Remove existing symlink/directory if present
        if symlink_path.exists() || symlink_path.symlink_metadata().is_ok() {
            if symlink_path.is_dir()
                && !symlink_path
                    .symlink_metadata()
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false)
            {
                std::fs::remove_dir_all(&symlink_path)?;
            } else {
                std::fs::remove_file(&symlink_path)?;
            }
        }

        #[cfg(unix)]
        std::os::unix::fs::symlink(&actual_skill_dir, &symlink_path)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&actual_skill_dir, &symlink_path)?;

        new_refs.push(ScopeAgentRef {
            agent_id: agent_entry.agent_id.clone(),
            symlink_path: Some(symlink_path.to_string_lossy().to_string()),
        });
    }

    // Update installed.toml — scope-isolated merge
    let existing = installed_file
        .installed
        .iter_mut()
        .find(|i| is_same_skill(i));

    match req.scope.as_str() {
        "global" => {
            if let Some(existing) = existing {
                remove_stale_symlinks(&existing.global_agents, &new_refs);
                existing.global_agents = new_refs;
            } else if !new_refs.is_empty() {
                installed_file.installed.push(InstalledSkillDef {
                    repo_key: req.repo_key.clone(),
                    repo_path: req.repo_path.clone(),
                    source_name: req.source_name.clone(),
                    skill_name: req.skill_name.clone(),
                    installed_at: Utc::now(),
                    global_agents: new_refs,
                    project_installs: vec![],
                });
            }
        }
        "project" => {
            let project_path = req
                .project_path
                .as_ref()
                .ok_or_else(|| GroveError::storage("Project path required for project scope"))?
                .clone();

            if let Some(existing) = existing {
                let pi = existing
                    .project_installs
                    .iter_mut()
                    .find(|p| p.project_path == project_path);

                if let Some(pi) = pi {
                    remove_stale_symlinks(&pi.agents, &new_refs);
                    if new_refs.is_empty() {
                        existing
                            .project_installs
                            .retain(|p| p.project_path != project_path);
                    } else {
                        pi.agents = new_refs;
                    }
                } else if !new_refs.is_empty() {
                    existing.project_installs.push(ProjectInstall {
                        project_path,
                        agents: new_refs,
                    });
                }
            } else if !new_refs.is_empty() {
                installed_file.installed.push(InstalledSkillDef {
                    repo_key: req.repo_key.clone(),
                    repo_path: req.repo_path.clone(),
                    source_name: req.source_name.clone(),
                    skill_name: req.skill_name.clone(),
                    installed_at: Utc::now(),
                    global_agents: vec![],
                    project_installs: vec![ProjectInstall {
                        project_path,
                        agents: new_refs,
                    }],
                });
            }
        }
        _ => return Err(GroveError::storage(format!("Unknown scope: {}", req.scope))),
    }

    // Clean up: remove fully uninstalled records
    let rk = req.repo_key.clone();
    let rp = req.repo_path.clone();
    installed_file.installed.retain(|i| {
        !(i.repo_key == rk
            && i.repo_path == rp
            && i.global_agents.is_empty()
            && i.project_installs.is_empty())
    });

    save_installed(&installed_file)?;

    // Return installed record (synthetic empty if fully removed)
    Ok(InstallResult::Ok(
        installed_file
            .installed
            .into_iter()
            .find(|i| i.repo_key == req.repo_key && i.repo_path == req.repo_path)
            .unwrap_or_else(|| InstalledSkillDef {
                repo_key: req.repo_key.clone(),
                repo_path: req.repo_path.clone(),
                source_name: req.source_name.clone(),
                skill_name: req.skill_name.clone(),
                installed_at: Utc::now(),
                global_agents: vec![],
                project_installs: vec![],
            }),
    ))
}

/// Remove symlinks for agents that were in the old set but not in the new set
fn remove_stale_symlinks(old_refs: &[ScopeAgentRef], new_refs: &[ScopeAgentRef]) {
    for old in old_refs {
        if !new_refs.iter().any(|n| n.agent_id == old.agent_id) {
            if let Some(path_str) = &old.symlink_path {
                let path = PathBuf::from(path_str);
                if path.symlink_metadata().is_ok() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// Internal: remove symlinks and record for a skill (mutates installed_file in place)
fn uninstall_skill_internal(
    installed_file: &mut crate::storage::skills::InstalledFile,
    repo_key: &str,
    repo_path: &str,
) {
    if let Some(record) = installed_file
        .installed
        .iter()
        .find(|i| i.repo_key == repo_key && i.repo_path == repo_path)
        .cloned()
    {
        for agent_ref in &record.global_agents {
            if let Some(path_str) = &agent_ref.symlink_path {
                let path = PathBuf::from(path_str);
                if path.symlink_metadata().is_ok() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        for pi in &record.project_installs {
            for agent_ref in &pi.agents {
                if let Some(path_str) = &agent_ref.symlink_path {
                    let path = PathBuf::from(path_str);
                    if path.symlink_metadata().is_ok() {
                        let _ = std::fs::remove_file(&path);
                    }
                }
            }
        }
        installed_file
            .installed
            .retain(|i| !(i.repo_key == repo_key && i.repo_path == repo_path));
    }
}

/// Uninstall a skill completely: remove all symlinks (global + all projects) and installed record
pub fn uninstall_skill(repo_key: &str, repo_path: &str) -> Result<()> {
    let mut installed_file = load_installed();
    if !installed_file
        .installed
        .iter()
        .any(|i| i.repo_key == repo_key && i.repo_path == repo_path)
    {
        return Err(GroveError::not_found("Skill not installed"));
    }
    uninstall_skill_internal(&mut installed_file, repo_key, repo_path);
    save_installed(&installed_file)
}

/// Delete a source: uninstall all its skills, remove manifest entries, optionally remove repo
pub fn delete_source(name: &str) -> Result<()> {
    let sources_file = load_sources();
    let source = sources_file
        .sources
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| GroveError::not_found(format!("Source not found: {}", name)))?
        .clone();

    // Uninstall all skills belonging to this source
    let manifest = load_manifest();
    for skill in manifest.skills.iter().filter(|s| s.source == name) {
        let _ = uninstall_skill(&skill.repo_key, &skill.repo_path);
    }

    // Remove manifest entries
    let mut manifest = load_manifest();
    manifest.skills.retain(|e| e.source != name);
    save_manifest(&manifest)?;

    // Remove from sources.toml
    let mut sources_file = load_sources();
    sources_file.sources.retain(|s| s.name != name);
    save_sources(&sources_file)?;

    // Check if any other source shares the same repo_key
    let repo_key = &source.repo_key;
    if !repo_key.is_empty() {
        let still_used = sources_file.sources.iter().any(|s| s.repo_key == *repo_key);

        if !still_used {
            let repo_dir = repos_dir().join(repo_key);
            if repo_dir.exists() {
                std::fs::remove_dir_all(&repo_dir)?;
            }
        }
    }

    Ok(())
}

// ============================================================================
// Helpers
// ============================================================================

fn resolve_actual_skill_dir(source: &SkillSourceDef, relative_path: &str) -> Result<PathBuf> {
    match source.source_type.as_str() {
        "git" => {
            if source.repo_key.is_empty() {
                return Err(GroveError::storage("Git source missing repo_key"));
            }
            let mut path = repos_dir().join(&source.repo_key);
            if let Some(subpath) = &source.subpath {
                path = path.join(subpath);
            }
            path = path.join(relative_path);
            Ok(path)
        }
        "local" => {
            let base = expand_tilde(&source.url);
            Ok(PathBuf::from(base).join(relative_path))
        }
        _ => Err(GroveError::storage(format!(
            "Unknown source type: {}",
            source.source_type
        ))),
    }
}

fn resolve_agent_target_dir(
    agent: &skills::AgentDef,
    scope: &str,
    project_path: Option<&str>,
) -> Result<PathBuf> {
    match scope {
        "global" => Ok(PathBuf::from(expand_tilde(&agent.global_skills_dir))),
        "project" => {
            let project = project_path
                .ok_or_else(|| GroveError::storage("Project path required for project scope"))?;
            Ok(PathBuf::from(project).join(&agent.project_skills_dir))
        }
        _ => Err(GroveError::storage(format!("Unknown scope: {}", scope))),
    }
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return format!("{}/{}", home.display(), rest);
        }
    }
    path.to_string()
}

/// Get the SKILL.md content for a specific skill
pub fn get_skill_md_content(source_name: &str, skill_relative_path: &str) -> Result<String> {
    let sources_file = load_sources();
    let source = sources_file
        .sources
        .iter()
        .find(|s| s.name == source_name)
        .ok_or_else(|| GroveError::not_found(format!("Source not found: {}", source_name)))?;

    let skill_dir = resolve_actual_skill_dir(source, skill_relative_path)?;
    let skill_md_path = skill_dir.join("SKILL.md");

    std::fs::read_to_string(&skill_md_path)
        .map_err(|e| GroveError::storage(format!("Failed to read SKILL.md: {}", e)))
}
