//! Plugin approval — a plugin only takes effect once the user has reviewed it.
//!
//! Approval records a digest of the manifest's security-relevant parts:
//! permissions, the processes it launches (command / args / env), and what it
//! contributes to agents (skills, MCP, prompt middleware) or exposes to the
//! outside (connect providers). A plugin is active only while its current
//! digest matches the approved one, so a manifest that later asks for more —
//! say a dev folder an agent can write to — falls back to pending review.
//! Code, UI and version changes leave the digest alone.

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::storage::plugins::Plugin;

/// Permissions that read or write user data, shown together in the review.
const DATA_PERMISSIONS: [&str; 5] = [
    "project:read",
    "project:write",
    "chat:read",
    "storage:read",
    "storage:write",
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
    let material = json!({
        "permissions": permissions(manifest),
        "backend": process("backend"),
        "mcp": process("mcp"),
        "promptMiddleware": contribution(manifest, "promptMiddleware"),
        "connectProviders": contribution(manifest, "connectProviders"),
        "skills": dir.join("skills").is_dir(),
    });
    hex::encode(Sha256::digest(material.to_string().as_bytes()))
}

/// Current security digest of the plugin folder, or None if it has no
/// readable manifest (such a plugin can never be active).
pub fn security_digest(local_path: &str) -> Option<String> {
    let dir = Path::new(local_path);
    read_manifest(dir).map(|manifest| digest_of(&manifest, dir))
}

/// Whether the plugin is approved for exactly what its manifest asks today.
pub fn is_active(plugin: &Plugin) -> bool {
    plugin
        .approved_digest
        .as_deref()
        .is_some_and(|approved| security_digest(&plugin.local_path).as_deref() == Some(approved))
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
pub fn review(local_path: &str) -> Value {
    let dir = Path::new(local_path);
    let Some(manifest) = read_manifest(dir) else {
        return Value::Null;
    };
    let perms = permissions(&manifest);
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
        "digest": digest_of(&manifest, dir),
        "permissions": perms,
        "full_trust": full_trust,
        "network": !processes.is_empty(),
        "processes": processes,
        "agent": {
            "skills": dir.join("skills").is_dir(),
            "mcp": contribution(&manifest, "mcp").is_some(),
            "prompt_middleware": contribution(&manifest, "promptMiddleware").is_some(),
            "chat_write": perms.contains("chat:write"),
        },
        "data": DATA_PERMISSIONS.iter().filter(|p| perms.contains(**p)).collect::<Vec<_>>(),
        "connect_provider": contribution(&manifest, "connectProviders").is_some(),
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
            source: "local".into(),
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
        let r = review(&dir.path().display().to_string());
        assert_eq!(r["full_trust"], false);
        assert_eq!(r["network"], true);
        assert_eq!(r["processes"][0]["sandboxed"], true);
        assert_eq!(r["agent"]["prompt_middleware"], true);
        assert_eq!(r["agent"]["chat_write"], true);
        assert_eq!(r["data"], json!(["project:read"]));

        let exec = plugin_dir(json!({"name": "b", "permissions": ["exec"],
            "contributes": {"mcp": {"command": "python3"}}}));
        let r = review(&exec.path().display().to_string());
        assert_eq!(r["full_trust"], true);
        assert_eq!(r["processes"][0]["sandboxed"], false);
    }
}
