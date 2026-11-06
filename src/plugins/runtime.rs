//! Launching a plugin's node processes (MCP server, backend), normally under
//! the **Node Permission Model** (`node --permission`).
//!
//! Grove requires node >= 24 — where the model is stable — for any plugin that
//! ships a node process. Older node is refused (the process is not launched) so
//! a declared permission is never silently left unenforced.
//!
//! Permission → flag mapping (everything is enforced by node itself, below the
//! plugin's JS, so it can't be monkey-patched away):
//!   - `storage:read`  → `--allow-fs-read`  of the plugin's data dir (all scopes)
//!   - `storage:write` → `--allow-fs-write` of the plugin's data dir
//!   - `project:read`  → `--allow-fs-read`  of the current task worktree
//!   - `project:write` → `--allow-fs-write` of the current task worktree
//!   - `exec` → no Node Permission Model. Child-process access is already
//!     effectively full trust, and Node 24.4+ propagates the parent's permission
//!     flags to spawned Node/shebang CLIs via `NODE_OPTIONS`. Keeping the model
//!     enabled would therefore break ordinary installed CLIs unless every
//!     global package path were granted explicitly.
//!
//! Network is intentionally absent: Node's model has no `--allow-net`, so a
//! `network` permission could not be enforced and Grove does not pretend it can.

use crate::platform::CanonicalPath;
use std::collections::HashSet;
use std::path::Path;

/// Minimum Node major version with a stable Permission Model.
pub const MIN_NODE_MAJOR: u32 = 24;

/// True if a command's basename is the node runtime (`node` / `node.exe`).
pub fn is_node_command(command: &str) -> bool {
    Path::new(command)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case("node"))
        .unwrap_or(false)
}

/// Detect the major version of a node command (on PATH or absolute). Returns
/// None if node isn't found or `--version` can't be parsed.
pub fn node_major_version(command: &str) -> Option<u32> {
    let out = std::process::Command::new(command)
        .arg("--version")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // e.g. "v24.1.0" → 24
    String::from_utf8_lossy(&out.stdout)
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// Whether this node command satisfies Grove's minimum for running plugin
/// processes under enforced permissions.
pub fn node_supports_permissions(command: &str) -> bool {
    node_major_version(command).is_some_and(|v| v >= MIN_NODE_MAJOR)
}

/// True if `command` is a node runtime from outside the plugin's own folder.
/// A plugin may ship a file named `node`; that is the plugin's code, not the
/// runtime, and must not be mistaken for something the sandbox can contain.
pub fn is_sandboxable_node(command: &str, plugin_dir: &Path) -> bool {
    if !is_node_command(command) {
        return false;
    }
    let path = Path::new(command);
    if !path.is_absolute() {
        return !plugin_dir.join(path).exists();
    }
    match (path.canonical(), plugin_dir.canonical()) {
        (Ok(path), Ok(dir)) => !path.starts_with(dir),
        (Err(_), _) => true,
        (Ok(_), Err(_)) => !path.starts_with(plugin_dir),
    }
}

/// Why a plugin process may not launch with these permissions, if it may not.
///
/// Only node processes can be sandboxed. Any other executable (a shell,
/// python, `env node`, a bundled binary) runs with the user's full rights, so
/// it is allowed only for plugins that already declare the full-trust `exec`.
pub fn launch_refusal(command: &str, plugin_dir: &Path, perms: &HashSet<String>) -> Option<String> {
    if is_sandboxable_node(command, plugin_dir) {
        return (!node_supports_permissions(command)).then(|| {
            format!("node >= {MIN_NODE_MAJOR} is required for enforced permissions (check `node --version`)")
        });
    }
    (!perms.contains("exec")).then(|| {
        format!(
            "'{command}' is not node, so its permissions cannot be enforced; \
             the plugin must declare the \"exec\" permission to run it"
        )
    })
}

/// Environment variables a manifest may not set for a plugin process. They
/// decide which executable runs or how the runtime loads code, so they can
/// lift the Node Permission Model (`NODE_OPTIONS=--allow-fs-read=*` does).
pub fn is_reserved_env(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(key.as_str(), "NODE_OPTIONS" | "NODE_PATH" | "PATH")
        || key.starts_with("DYLD_")
        || key.starts_with("LD_")
}

/// Grant a directory path for an fs flag: both the dir entry itself and its
/// contents (node's trailing-`*` is a recursive prefix match).
fn grant(kind: &str, dir: &str, out: &mut Vec<String>) {
    out.push(format!("--allow-fs-{}={}", kind, dir));
    out.push(format!(
        "--allow-fs-{}={}{}*",
        kind,
        dir,
        std::path::MAIN_SEPARATOR
    ));
}

/// Build the `--permission …` flags for a node process, granting fs/exec scopes
/// exactly matching the plugin's declared permissions.
///
/// Returns no flags when `exec` is declared. That permission already lets the
/// plugin run an unrestricted OS process (and thus bypass any parent fs grant),
/// so retaining Node's model would add no security boundary. Since Node 24.4 it
/// would, however, propagate the parent's restrictions to Node-based external
/// CLIs and prevent them from reading their own installation files.
///
/// - `install_dir` is always granted read (node must load the plugin's own
///   code / node_modules to start).
/// - `storage_root` is the plugin's whole data dir (covers global/project/task
///   scopes) — granted per `storage:read` / `storage:write`.
/// - `project_dir` is the current task worktree (None for app-scoped backends)
///   — granted per `project:read` / `project:write`.
pub fn node_permission_flags(
    perms: &HashSet<String>,
    install_dir: &str,
    storage_root: &str,
    project_dir: Option<&str>,
) -> Vec<String> {
    if perms.contains("exec") {
        return Vec::new();
    }
    let mut flags = vec!["--permission".to_string()];
    // Node must read its own code; worker threads inherit the same perms.
    grant("read", install_dir, &mut flags);
    flags.push("--allow-worker".to_string());
    if perms.contains("storage:read") {
        grant("read", storage_root, &mut flags);
    }
    if perms.contains("storage:write") {
        grant("write", storage_root, &mut flags);
    }
    if let Some(proj) = project_dir {
        if perms.contains("project:read") {
            grant("read", proj, &mut flags);
        }
        if perms.contains("project:write") {
            grant("write", proj, &mut flags);
        }
    }
    flags
}

#[cfg(test)]
mod tests {
    use super::*;

    fn perms(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn node_command_detection() {
        assert!(is_node_command("node"));
        assert!(is_node_command("/usr/local/bin/node"));
        assert!(is_node_command("node.exe"));
        assert!(!is_node_command("python"));
        assert!(!is_node_command("/opt/deno"));
    }

    #[test]
    fn flags_always_include_permission_and_own_code() {
        let f = node_permission_flags(&perms(&[]), "/plug", "/data", None);
        assert_eq!(f[0], "--permission");
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/plug")));
        assert!(f.iter().any(|x| x == "--allow-worker"));
        // No storage/project/exec grants when nothing is declared.
        assert!(!f.iter().any(|x| x.contains("/data")));
        assert!(!f.iter().any(|x| x == "--allow-child-process"));
    }

    #[test]
    fn flags_map_each_scoped_permission() {
        let f = node_permission_flags(
            &perms(&["storage:read", "storage:write", "project:read"]),
            "/plug",
            "/data",
            Some("/work"),
        );
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/data")));
        assert!(f.iter().any(|x| x.contains("--allow-fs-write=/data")));
        assert!(f.iter().any(|x| x.contains("--allow-fs-read=/work")));
        assert!(!f.iter().any(|x| x.contains("--allow-fs-write=/work")));
    }

    #[test]
    fn non_node_commands_need_exec() {
        let dir = tempfile::tempdir().unwrap();
        for command in [
            "sh",
            "/bin/bash",
            "python3",
            "env",
            "/opt/deno",
            "./dist/server",
        ] {
            assert!(launch_refusal(command, dir.path(), &perms(&["storage:read"])).is_some());
            assert!(launch_refusal(command, dir.path(), &perms(&["exec"])).is_none());
        }
    }

    #[test]
    fn a_bundled_file_named_node_is_not_the_runtime() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("bin")).unwrap();
        std::fs::write(dir.path().join("node"), "#!/bin/sh").unwrap();
        std::fs::write(dir.path().join("bin/node"), "#!/bin/sh").unwrap();
        let bundled = dir.path().join("node").display().to_string();
        for command in ["node", "bin/node", bundled.as_str()] {
            assert!(!is_sandboxable_node(command, dir.path()), "{command}");
        }
        let other = tempfile::tempdir().unwrap();
        assert!(is_sandboxable_node("node", other.path()));
        assert!(is_sandboxable_node("/usr/local/bin/node", other.path()));
    }

    #[test]
    fn reserved_env_covers_loader_and_lookup_variables() {
        for key in [
            "NODE_OPTIONS",
            "node_options",
            "NODE_PATH",
            "PATH",
            "DYLD_INSERT_LIBRARIES",
            "LD_PRELOAD",
        ] {
            assert!(is_reserved_env(key), "{key}");
        }
        for key in ["NODE_ENV", "API_BASE", "DEBUG", "PATHNAME"] {
            assert!(!is_reserved_env(key), "{key}");
        }
    }

    #[test]
    fn exec_disables_the_permission_model() {
        let f = node_permission_flags(
            &perms(&["storage:read", "project:read", "exec"]),
            "/plug",
            "/data",
            Some("/work"),
        );
        assert!(f.is_empty());
    }
}
