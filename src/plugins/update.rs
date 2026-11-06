//! Updating an installed plugin. A new version is staged beside the running
//! one and changes nothing until the user has seen what differs and agreed.
//! The old version keeps running meanwhile, and comes back if the new one
//! fails to start.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::approval;
use crate::error::{GroveError, Result};
use crate::storage::plugins::{self, Plugin};

/// How long a service gets to reach `running` before it counts as failed.
const START_GRACE: Duration = Duration::from_secs(3);

fn update_root(plugin_id: &str) -> PathBuf {
    crate::storage::grove_dir()
        .join("plugin-updates")
        .join(plugin_id)
}

fn staged_dir(plugin_id: &str) -> PathBuf {
    update_root(plugin_id).join("next")
}

fn previous_dir(plugin_id: &str) -> PathBuf {
    update_root(plugin_id).join("previous")
}

fn copy_tree(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let (from, to) = (entry.path(), dst.join(entry.file_name()));
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else if kind.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// The installed plugin a package with this name would replace.
pub fn installed_named(name: &str) -> Result<Option<Plugin>> {
    Ok(plugins::list()?
        .into_iter()
        .find(|plugin| plugin.source != "dev" && plugin.name == name))
}

/// Stage `source` as the next version of `plugin`, replacing any staged one.
pub fn stage(plugin: &Plugin, source: &Path) -> Result<()> {
    let staged = staged_dir(&plugin.id);
    if staged.exists() {
        std::fs::remove_dir_all(&staged)?;
    }
    copy_tree(source, &staged)?;
    Ok(())
}

fn manifest(dir: &Path) -> Value {
    std::fs::read_to_string(dir.join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

fn string_set(value: Option<&Value>) -> BTreeSet<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.as_str().map(String::from))
        .collect()
}

/// What a reviewer needs to compare between two versions.
fn compare(current: &Path, next: &Path) -> Value {
    let (old, new) = (manifest(current), manifest(next));
    let (old_perms, new_perms) = (
        string_set(old.get("permissions")),
        string_set(new.get("permissions")),
    );
    let empty = serde_json::Map::new();
    let contributions = |m: &Value| {
        m.get("contributes")
            .and_then(Value::as_object)
            .unwrap_or(&empty)
            .clone()
    };
    let (old_parts, new_parts) = (contributions(&old), contributions(&new));
    let changed_parts: Vec<&String> = old_parts
        .iter()
        .filter(|(key, value)| new_parts.get(*key).is_some_and(|next| next != *value))
        .map(|(key, _)| key)
        .collect();
    let files = |dir: &Path| -> BTreeMap<String, String> {
        approval::package_files(dir).into_iter().collect()
    };
    let (old_files, new_files) = (files(current), files(next));
    let added_files = new_files
        .keys()
        .filter(|name| !old_files.contains_key(*name))
        .count();
    let removed_files = old_files
        .keys()
        .filter(|name| !new_files.contains_key(*name))
        .count();
    let changed_files = new_files
        .iter()
        .filter(|(name, digest)| old_files.get(*name).is_some_and(|old| old != *digest))
        .count();
    json!({
        "permissions_added": new_perms.difference(&old_perms).collect::<Vec<_>>(),
        "permissions_removed": old_perms.difference(&new_perms).collect::<Vec<_>>(),
        "contributions_added": new_parts.keys().filter(|k| !old_parts.contains_key(*k)).collect::<Vec<_>>(),
        "contributions_removed": old_parts.keys().filter(|k| !new_parts.contains_key(*k)).collect::<Vec<_>>(),
        "contributions_changed": changed_parts,
        "files": { "added": added_files, "removed": removed_files, "changed": changed_files },
    })
}

/// The staged update of `plugin`, for review, if there is one.
pub fn pending(plugin: &Plugin) -> Option<Value> {
    let staged = staged_dir(&plugin.id);
    let manifest = manifest(&staged);
    if manifest.is_null() {
        return None;
    }
    let candidate = Plugin {
        local_path: staged.display().to_string(),
        ..plugin.clone()
    };
    Some(json!({
        "from": plugin.version,
        "to": manifest.get("version").and_then(Value::as_str).unwrap_or("0.0.0"),
        "digest": approval::current_digest(&candidate),
        "review": approval::review(&candidate),
        "changes": compare(Path::new(&plugin.local_path), &staged),
    }))
}

pub fn discard(plugin_id: &str) -> Result<()> {
    let root = update_root(plugin_id);
    if root.exists() {
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}

async fn started(plugin: &Plugin) -> bool {
    if !super::lifecycle::policy(&plugin.local_path).service {
        return true;
    }
    tokio::time::sleep(START_GRACE).await;
    matches!(
        super::lifecycle::snapshot(&plugin.id)["state"].as_str(),
        Some("running" | "elsewhere")
    )
}

async fn activate(plugin: &Plugin) {
    approval::sync_skills(plugin);
    super::backend::registered(plugin).await;
}

/// Replace `plugin_id` with its staged version, which the user reviewed as
/// `digest`. Returns the new record, or the old one if the update was undone.
pub async fn apply(plugin_id: &str, digest: &str) -> Result<Plugin> {
    let plugin = plugins::get(plugin_id)?
        .ok_or_else(|| GroveError::not_found(format!("plugin not found: {plugin_id}")))?;
    let staged = staged_dir(plugin_id);
    let candidate = Plugin {
        local_path: staged.display().to_string(),
        ..plugin.clone()
    };
    let reviewed = approval::current_digest(&candidate)
        .ok_or_else(|| GroveError::not_found("no staged update for this plugin"))?;
    if reviewed != digest {
        return Err(GroveError::invalid_data(
            "the update changed since it was reviewed; review it again",
        ));
    }
    let next = manifest(&staged);
    let name = next
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(&plugin.name);
    let version = next
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");

    super::backend::shutdown_plugin(plugin_id).await;
    let previous = previous_dir(plugin_id);
    if previous.exists() {
        std::fs::remove_dir_all(&previous)?;
    }
    let current = Path::new(&plugin.local_path);
    std::fs::rename(current, &previous)?;
    std::fs::rename(&staged, current)?;

    let update = |name: &str, version: &str, digest: Option<&str>| -> Result<Plugin> {
        plugins::upsert(
            plugin_id,
            name,
            version,
            &plugin.source,
            &plugin.local_path,
            plugin.git_url.as_deref(),
            plugin.subpath.as_deref(),
        )?;
        plugins::set_approved_digest(plugin_id, digest)?;
        plugins::get(plugin_id)?
            .ok_or_else(|| GroveError::not_found(format!("plugin not found: {plugin_id}")))
    };
    let updated = update(name, version, Some(digest))?;
    activate(&updated).await;
    if started(&updated).await {
        discard(plugin_id)?;
        return Ok(updated);
    }

    // The new version does not run: restore what the user had.
    let reason = super::lifecycle::snapshot(plugin_id)["lastError"]
        .as_str()
        .unwrap_or("it did not start")
        .to_owned();
    super::backend::shutdown_plugin(plugin_id).await;
    std::fs::remove_dir_all(current)?;
    std::fs::rename(&previous, current)?;
    let restored = update(
        &plugin.name,
        &plugin.version,
        plugin.approved_digest.as_deref(),
    )?;
    super::lifecycle::reset_failures(plugin_id);
    activate(&restored).await;
    discard(plugin_id)?;
    Err(GroveError::invalid_data(format!(
        "update rolled back: {reason}"
    )))
}
