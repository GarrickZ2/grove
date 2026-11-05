//! Plugin approval — a plugin only takes effect once the user has reviewed it.
//!
//! Approval covers the plugin as it stands: for an installed copy, a digest of
//! every file in it; for a dev folder, a digest of the manifest's
//! security-relevant parts (permissions, processes, lifecycle, and what it
//! contributes to agents or exposes to the outside), so code can change freely
//! during development but a manifest that asks for more falls back to review.
//! A plugin is active only while its current digest matches the approved one.

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::storage::plugins::Plugin;

/// Permissions that read or write user data, shown together in the review.
const DATA_PERMISSIONS: [&str; 14] = [
    "view:list",
    "memory:read",
    "memory:write",
    "notes:read",
    "notes:write",
    "review:read",
    "project:read",
    "project:write",
    "chat:read",
    "storage:read",
    "storage:write",
    "workspace:read",
    "sessions:read",
    "buddies:read",
];

fn read_manifest(dir: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("plugin.json")).ok()?).ok()
}

fn permissions(manifest: &Value) -> BTreeSet<String> {
    manifest
        .get("permissions")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn contribution<'a>(manifest: &'a Value, key: &str) -> Option<&'a Value> {
    manifest.get("contributes").and_then(|c| c.get(key))
}

/// Digest of a manifest's security-relevant parts. serde_json maps are sorted,
/// so key order in plugin.json does not change the result.
fn digest_of(manifest: &Value, dir: &Path) -> String {
    let process = |key| {
        contribution(manifest, key).map(
            |d| json!({ "command": d.get("command"), "args": d.get("args"), "env": d.get("env") }),
        )
    };
    let mut material = json!({
        "permissions": permissions(manifest),
        "backend": process("backend"),
        "mcp": process("mcp"),
        "promptMiddleware": contribution(manifest, "promptMiddleware"),
        "connectProviders": contribution(manifest, "connectProviders"),
        "skills": dir.join("skills").is_dir(),
    });
    // Added only when declared, so plugins without them keep their approval.
    for key in ["lifetime", "activation", "restart", "listeners"] {
        if let Some(value) = contribution(manifest, "backend").and_then(|b| b.get(key)) {
            material[key] = value.clone();
        }
    }
    if let Some(value) = contribution(manifest, "metaTypes") {
        material["metaTypes"] = value.clone();
    }
    hex::encode(Sha256::digest(material.to_string().as_bytes()))
}

/// Current security digest of the plugin folder, or None if it has no
/// readable manifest (such a plugin can never be active).
pub fn security_digest(local_path: &str) -> Option<String> {
    let dir = Path::new(local_path);
    read_manifest(dir).map(|manifest| digest_of(&manifest, dir))
}

/// Files whose digest is reused while their size and modification time stay
/// the same. A plugin's digest is checked on every permission lookup.
type FileStamp = (u64, std::time::SystemTime);
static FILE_DIGESTS: Lazy<Mutex<HashMap<std::path::PathBuf, (FileStamp, String)>>> =
    Lazy::new(Default::default);

fn file_digest(path: &Path, stamp: FileStamp) -> Option<String> {
    if let Some((known, digest)) = FILE_DIGESTS.lock().unwrap().get(path) {
        if *known == stamp {
            return Some(digest.clone());
        }
    }
    let digest = hex::encode(Sha256::digest(std::fs::read(path).ok()?));
    FILE_DIGESTS
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (stamp, digest.clone()));
    Some(digest)
}

/// Every regular file under `dir` as (relative path, digest), sorted.
pub fn package_files(dir: &Path) -> Vec<(String, String)> {
    let mut files: Vec<(String, String)> = walkdir::WalkDir::new(dir)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.file_name() != ".git")
        .flatten()
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            let stamp = (metadata.len(), metadata.modified().ok()?);
            let digest = file_digest(entry.path(), stamp)?;
            let relative = entry.path().strip_prefix(dir).ok()?;
            Some((relative.to_string_lossy().replace('\\', "/"), digest))
        })
        .collect();
    files.sort();
    files
}

/// Digest of a plugin folder's manifest and every file in it.
pub fn package_digest(local_path: &str) -> Option<String> {
    let security = security_digest(local_path)?;
    let files = package_files(Path::new(local_path));
    let material = json!({ "security": security, "files": files });
    Some(hex::encode(Sha256::digest(material.to_string().as_bytes())))
}

/// What approval covers for this plugin today.
pub fn current_digest(plugin: &Plugin) -> Option<String> {
    if plugin.source == "dev" {
        security_digest(&plugin.local_path)
    } else {
        package_digest(&plugin.local_path)
    }
}

/// Whether the plugin is approved for exactly what is on disk today.
pub fn is_active(plugin: &Plugin) -> bool {
    plugin
        .approved_digest
        .as_deref()
        .is_some_and(|approved| current_digest(plugin).as_deref() == Some(approved))
}

/// Carry approvals made before they covered whole packages. An installed
/// plugin whose manifest still matches was approved for what it asks today, so
/// it keeps running; from here on any change to its files needs a new review.
pub fn migrate_approvals() {
    for plugin in crate::storage::plugins::list().unwrap_or_default() {
        let upgraded = plugin.source != "dev"
            && plugin.approved_digest.is_some()
            && plugin.approved_digest == security_digest(&plugin.local_path);
        if upgraded {
            if let Some(digest) = package_digest(&plugin.local_path) {
                let _ = crate::storage::plugins::set_approved_digest(&plugin.id, Some(&digest));
            }
        }
    }
}

/// `active`, `pending` (never approved) or `changed` (asks for something new).
pub fn status(plugin: &Plugin) -> &'static str {
    match plugin.approved_digest {
        None => "pending",
        Some(_) if is_active(plugin) => "active",
        Some(_) => "changed",
    }
}

/// Registered plugins that may take effect.
pub fn active_plugins() -> crate::error::Result<Vec<Plugin>> {
    Ok(crate::storage::plugins::list()?
        .into_iter()
        .filter(is_active)
        .collect())
}

/// What the user is asked to approve, grouped by risk for the review screen.
pub fn review(plugin: &Plugin) -> Value {
    let local_path = plugin.local_path.as_str();
    let dir = Path::new(local_path);
    let Some(manifest) = read_manifest(dir) else {
        return Value::Null;
    };
    let perms = permissions(&manifest);
    let lifecycle = super::lifecycle::policy(local_path);
    let processes: Vec<Value> = ["backend", "mcp"]
        .into_iter()
        .filter_map(|kind| {
            let decl = contribution(&manifest, kind)?;
            let command = decl.get("command").and_then(Value::as_str)?;
            Some(json!({
                "kind": kind,
                "command": command,
                "args": decl.get("args").cloned().unwrap_or_else(|| json!([])),
                "sandboxed": !perms.contains("exec")
                    && super::runtime::is_sandboxable_node(command, dir),
            }))
        })
        .collect();
    let full_trust = perms.contains("exec") || processes.iter().any(|p| p["sandboxed"] == false);
    json!({
        "digest": current_digest(plugin),
        "permissions": perms,
        "full_trust": full_trust,
        "network": !processes.is_empty(),
        "processes": processes,
        "agent": {
            "skills": dir.join("skills").is_dir(),
            "mcp": contribution(&manifest, "mcp").is_some(),
            "prompt_middleware": contribution(&manifest, "promptMiddleware").is_some(),
            "chat_write": perms.contains("chat:write"),
            "sessions_write": perms.contains("sessions:write"),
            "buddies_write": perms.contains("buddies:write"),
            "ui_interact": perms.contains("ui:interact"),
        },
        "data": DATA_PERMISSIONS.iter().filter(|p| perms.contains(**p)).collect::<Vec<_>>(),
        "connect_provider": contribution(&manifest, "connectProviders").is_some(),
        "service": lifecycle.service,
        "activation": {
            "on_startup": lifecycle.on_startup,
            "schedules": lifecycle.schedules,
            "unknown": lifecycle.unknown_activation,
        },
        "listeners": lifecycle.listeners,
        "meta_types": contribution(&manifest, "metaTypes")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    })
}

/// A readable, stable skill-source name for a plugin: `plugin:<name>` with the
/// name sanitized to safe chars. The `plugin:` prefix marks it plugin-owned
/// (the UI forbids manual deletion); the suffix is the plugin's display name so
/// the Skills view shows e.g. `plugin:my-plugin` rather than `plugin:pl-<uuid>`.
pub fn skill_source_name(name: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "plugin:unnamed".to_string()
    } else {
        format!("plugin:{}", slug)
    }
}

/// Mount an active plugin's `skills/` folder as a Grove skill source named
/// `plugin:<name>`, and unmount it otherwise: skills reach every agent, so a
/// plugin under review must not contribute them. Best-effort — a skills
/// failure must not block plugin ops. Also removes the legacy `plugin:<id>`
/// source so older installs migrate to the readable name on the next sync.
pub fn sync_skills(plugin: &Plugin) {
    let source_name = skill_source_name(&plugin.name);
    let legacy = format!("plugin:{}", plugin.id);
    if legacy != source_name {
        let _ = crate::operations::skills::remove_local_source(&legacy);
    }
    let skills_dir = Path::new(&plugin.local_path).join("skills");
    if skills_dir.is_dir() && is_active(plugin) {
        let _ = crate::operations::skills::add_local_source(
            &source_name,
            &skills_dir.display().to_string(),
        );
    } else {
        let _ = crate::operations::skills::remove_local_source(&source_name);
    }
}

/// Re-apply every plugin's skill mount, e.g. at startup after a manifest
/// changed while Grove was not running.
pub fn sync_all_skills() {
    for plugin in crate::storage::plugins::list().unwrap_or_default() {
        sync_skills(&plugin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin_dir(manifest: Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("plugin.json"), manifest.to_string()).unwrap();
        dir
    }

    fn plugin(dir: &Path, approved: Option<String>) -> Plugin {
        Plugin {
            id: "pl-test".into(),
            name: "Test".into(),
            version: "1.0.0".into(),
            source: "dev".into(),
            local_path: dir.display().to_string(),
            git_url: None,
            subpath: None,
            approved_digest: approved,
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
        }
    }

    #[test]
    fn unapproved_plugins_are_pending() {
        let dir = plugin_dir(json!({"name": "a", "permissions": ["storage:read"]}));
        let p = plugin(dir.path(), None);
        assert!(!is_active(&p));
        assert_eq!(status(&p), "pending");
    }

    #[test]
    fn approval_survives_non_security_changes_only() {
        let dir = plugin_dir(json!({
            "name": "a", "version": "1.0.0", "permissions": ["storage:read"],
            "contributes": {"panel": {"entry": "dist/index.html"}, "backend": {"command": "node", "args": ["dist/b.js"]}}
        }));
        let digest = security_digest(&dir.path().display().to_string());
        let p = plugin(dir.path(), digest);
        assert_eq!(status(&p), "active");

        // Version, UI entry and key order do not need a new review.
        std::fs::write(
            dir.path().join("plugin.json"),
            json!({
                "contributes": {"backend": {"args": ["dist/b.js"], "command": "node"}, "panel": {"entry": "dist/v2.html"}},
                "permissions": ["storage:read"], "version": "1.1.0", "name": "a"
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(status(&p), "active");

        // A new permission does.
        std::fs::write(
            dir.path().join("plugin.json"),
            json!({"name": "a", "permissions": ["storage:read", "exec"],
                   "contributes": {"backend": {"command": "node", "args": ["dist/b.js"]}}})
            .to_string(),
        )
        .unwrap();
        assert_eq!(status(&p), "changed");
    }

    #[test]
    fn adding_skills_requires_a_new_review() {
        let dir = plugin_dir(json!({"name": "a"}));
        let p = plugin(
            dir.path(),
            security_digest(&dir.path().display().to_string()),
        );
        assert!(is_active(&p));
        std::fs::create_dir(dir.path().join("skills")).unwrap();
        assert!(!is_active(&p));
    }

    #[test]
    fn review_groups_capabilities_by_risk() {
        let dir = plugin_dir(json!({
            "name": "a",
            "permissions": ["project:read", "chat:write", "prompt:middleware"],
            "contributes": {
                "backend": {"command": "node", "args": ["dist/b.js"]},
                "promptMiddleware": ["submit"]
            }
        }));
        let r = review(&plugin(dir.path(), None));
        assert_eq!(r["full_trust"], false);
        assert_eq!(r["network"], true);
        assert_eq!(r["processes"][0]["sandboxed"], true);
        assert_eq!(r["agent"]["prompt_middleware"], true);
        assert_eq!(r["agent"]["chat_write"], true);
        assert_eq!(r["data"], json!(["project:read"]));

        let exec = plugin_dir(json!({"name": "b", "permissions": ["exec"],
            "contributes": {"mcp": {"command": "python3"}}}));
        let r = review(&plugin(exec.path(), None));
        assert_eq!(r["full_trust"], true);
        assert_eq!(r["processes"][0]["sandboxed"], false);
    }

    fn installed(dir: &Path) -> Plugin {
        let mut plugin = plugin(dir, None);
        plugin.source = "local".into();
        plugin.approved_digest = current_digest(&plugin);
        plugin
    }

    #[test]
    fn any_file_change_needs_a_new_review_for_an_installed_plugin() {
        let dir = plugin_dir(json!({"name": "a"}));
        std::fs::create_dir(dir.path().join("dist")).unwrap();
        std::fs::write(dir.path().join("dist/index.js"), "one").unwrap();
        let p = installed(dir.path());
        assert!(is_active(&p));

        std::fs::write(dir.path().join("dist/index.js"), "two!").unwrap();
        assert_eq!(status(&p), "changed");
        std::fs::write(dir.path().join("dist/index.js"), "one").unwrap();
        assert!(is_active(&p));
        std::fs::write(dir.path().join("dist/extra.js"), "x").unwrap();
        assert!(!is_active(&p));
        std::fs::remove_file(dir.path().join("dist/extra.js")).unwrap();
        assert!(is_active(&p));
        std::fs::remove_file(dir.path().join("dist/index.js")).unwrap();
        assert!(!is_active(&p));
    }

    #[test]
    fn a_same_size_edit_with_a_new_mtime_is_noticed() {
        let dir = plugin_dir(json!({"name": "a"}));
        let file = dir.path().join("code.js");
        std::fs::write(&file, "aaaa").unwrap();
        let p = installed(dir.path());
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&file, "bbbb").unwrap();
        assert!(!is_active(&p));
    }

    #[test]
    fn git_metadata_does_not_affect_approval() {
        let dir = plugin_dir(json!({"name": "a"}));
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let p = installed(dir.path());
        std::fs::write(dir.path().join(".git/HEAD"), "ref").unwrap();
        assert!(is_active(&p));
    }

    #[test]
    fn a_dev_plugin_keeps_its_approval_across_code_changes() {
        let dir = plugin_dir(json!({"name": "a"}));
        let p = plugin(
            dir.path(),
            security_digest(&dir.path().display().to_string()),
        );
        std::fs::write(dir.path().join("code.js"), "new").unwrap();
        assert!(is_active(&p));
    }

    #[test]
    fn lifecycle_changes_need_a_new_review() {
        let dir = plugin_dir(json!({"name": "a", "contributes": {"backend": {"command": "node"}}}));
        let path = dir.path().display().to_string();
        let p = plugin(dir.path(), security_digest(&path));
        std::fs::write(
            dir.path().join("plugin.json"),
            json!({"name": "a", "contributes": {"backend": {"command": "node", "lifetime": "service"}}})
                .to_string(),
        )
        .unwrap();
        assert_eq!(status(&p), "changed");
    }

    #[test]
    fn plugins_without_lifecycle_fields_keep_older_digests() {
        // Pinned: changing this digest would ask every user to re-approve.
        let manifest = json!({"name": "a", "permissions": ["storage:read"]});
        let dir = plugin_dir(manifest.clone());
        let material = json!({
            "permissions": ["storage:read"],
            "backend": null,
            "mcp": null,
            "promptMiddleware": null,
            "connectProviders": null,
            "skills": false,
        });
        assert_eq!(
            digest_of(&manifest, dir.path()),
            hex::encode(Sha256::digest(material.to_string().as_bytes()))
        );
    }
}
