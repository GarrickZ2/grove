//! Unified catalog records for non-Skill extensions and standalone MCP bindings.

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::error::Result;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionArtifact {
    pub repo_key: String,
    pub repo_path: String,
    pub source_name: String,
    /// `plugin` | `mcp`
    pub kind: String,
    pub name: String,
    pub version: Option<String>,
    pub description: String,
    pub relative_path: String,
    pub manifest: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpInstallation {
    pub repo_key: String,
    pub repo_path: String,
    pub source_name: String,
    pub agent_id: String,
    pub scope: String,
    pub project_path: String,
    pub runtime: serde_json::Value,
    pub values: serde_json::Value,
    pub enabled: bool,
    pub installed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedMcpConfig {
    pub name: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub env: std::collections::HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub headers: std::collections::HashMap<String, String>,
}

pub fn replace_source_artifacts(source_name: &str, artifacts: &[ExtensionArtifact]) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM extension_artifacts WHERE source_name = ?1",
        params![source_name],
    )?;
    for artifact in artifacts {
        tx.execute(
            "INSERT INTO extension_artifacts
             (repo_key, repo_path, source_name, kind, name, version, description, relative_path, manifest_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                artifact.repo_key,
                artifact.repo_path,
                artifact.source_name,
                artifact.kind,
                artifact.name,
                artifact.version,
                artifact.description,
                artifact.relative_path,
                artifact.manifest.to_string(),
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn remove_source_artifacts(source_name: &str) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM mcp_display_names WHERE (repo_key, repo_path) IN
         (SELECT repo_key, repo_path FROM extension_artifacts WHERE source_name=?1 AND kind='mcp')",
        params![source_name],
    )?;
    tx.execute(
        "DELETE FROM extension_artifacts WHERE source_name=?1",
        params![source_name],
    )?;
    tx.commit()?;
    Ok(())
}

/// Display-only overrides. Keep these separate from both source manifests and
/// resolved Agent configurations so renaming cannot change connection identity.
pub fn mcp_display_names() -> Result<std::collections::HashMap<(String, String), String>> {
    let conn = crate::storage::database::connection();
    let mut stmt =
        conn.prepare("SELECT repo_key, repo_path, display_name FROM mcp_display_names")?;
    let rows = stmt.query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))?;
    rows.collect::<std::result::Result<_, _>>()
        .map_err(Into::into)
}

pub fn save_mcp_display_name(repo_key: &str, repo_path: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 200 || name.chars().any(char::is_control) {
        return Err(crate::error::GroveError::config(
            "Enter a display name of 1–200 characters without control characters.",
        ));
    }
    let conn = crate::storage::database::connection();
    conn.execute(
        "INSERT INTO mcp_display_names (repo_key, repo_path, display_name) VALUES (?1, ?2, ?3)
         ON CONFLICT (repo_key, repo_path) DO UPDATE SET display_name=excluded.display_name",
        params![repo_key, repo_path, name],
    )?;
    Ok(())
}

pub fn list_artifacts() -> Result<Vec<ExtensionArtifact>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT repo_key, repo_path, source_name, kind, name, version, description,
                relative_path, manifest_json
         FROM extension_artifacts ORDER BY lower(name), kind",
    )?;
    let rows = stmt.query_map([], |row| {
        let raw: String = row.get(8)?;
        Ok(ExtensionArtifact {
            repo_key: row.get(0)?,
            repo_path: row.get(1)?,
            source_name: row.get(2)?,
            kind: row.get(3)?,
            name: row.get(4)?,
            version: row.get(5)?,
            description: row.get(6)?,
            relative_path: row.get(7)?,
            manifest: serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null),
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub fn get_artifact(
    repo_key: &str,
    repo_path: &str,
    kind: &str,
) -> Result<Option<ExtensionArtifact>> {
    let conn = crate::storage::database::connection();
    conn.query_row(
        "SELECT repo_key, repo_path, source_name, kind, name, version, description,
                relative_path, manifest_json
         FROM extension_artifacts WHERE repo_key=?1 AND repo_path=?2 AND kind=?3",
        params![repo_key, repo_path, kind],
        |row| {
            let raw: String = row.get(8)?;
            Ok(ExtensionArtifact {
                repo_key: row.get(0)?,
                repo_path: row.get(1)?,
                source_name: row.get(2)?,
                kind: row.get(3)?,
                name: row.get(4)?,
                version: row.get(5)?,
                description: row.get(6)?,
                relative_path: row.get(7)?,
                manifest: serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null),
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

#[allow(clippy::too_many_arguments)]
pub fn save_mcp_installations(
    repo_key: &str,
    repo_path: &str,
    source_name: &str,
    scope: &str,
    project_path: &str,
    agent_ids: &[String],
    runtime: &serde_json::Value,
    values: &serde_json::Value,
) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM mcp_installations
         WHERE repo_key=?1 AND repo_path=?2 AND scope=?3 AND project_path=?4",
        params![repo_key, repo_path, scope, project_path],
    )?;
    let now = Utc::now().to_rfc3339();
    for agent_id in agent_ids {
        tx.execute(
            "INSERT INTO mcp_installations
             (repo_key, repo_path, source_name, agent_id, scope, project_path,
              runtime_json, values_json, enabled, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9)",
            params![
                repo_key,
                repo_path,
                source_name,
                agent_id,
                scope,
                project_path,
                runtime.to_string(),
                values.to_string(),
                now
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_mcp_installations() -> Result<Vec<McpInstallation>> {
    let conn = crate::storage::database::connection();
    let mut stmt = conn.prepare(
        "SELECT repo_key, repo_path, source_name, agent_id, scope, project_path,
                runtime_json, values_json, enabled, installed_at
         FROM mcp_installations ORDER BY installed_at",
    )?;
    let rows = stmt.query_map([], |row| {
        let runtime: String = row.get(6)?;
        let values: String = row.get(7)?;
        let installed_at: String = row.get(9)?;
        Ok(McpInstallation {
            repo_key: row.get(0)?,
            repo_path: row.get(1)?,
            source_name: row.get(2)?,
            agent_id: row.get(3)?,
            scope: row.get(4)?,
            project_path: row.get(5)?,
            runtime: serde_json::from_str(&runtime).unwrap_or_default(),
            values: serde_json::from_str(&values).unwrap_or_default(),
            enabled: row.get::<_, i64>(8)? != 0,
            installed_at: DateTime::parse_from_rfc3339(&installed_at)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or_else(|_| Utc::now()),
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

pub fn effective_mcp_installations(
    agent_id: &str,
    project_path: Option<&str>,
) -> Result<Vec<McpInstallation>> {
    Ok(list_mcp_installations()?
        .into_iter()
        .filter(|i| i.enabled && i.agent_id == agent_id)
        .filter(|i| {
            i.scope == "global"
                || (i.scope == "project" && project_path == Some(i.project_path.as_str()))
        })
        .collect())
}

fn value_map(value: &serde_json::Value) -> std::collections::HashMap<String, String> {
    value
        .as_object()
        .map(|object| {
            object
                .iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn apply_variables(
    mut input: String,
    values: &std::collections::HashMap<String, String>,
) -> String {
    for (name, value) in values {
        input = input.replace(&format!("{{{name}}}"), value);
    }
    input
}

/// Resolve official server.json package/remote variants into the transport
/// shape consumed by ACP and terminal-agent config generators.
pub fn resolve_effective_mcp_configs(
    agent_id: &str,
    project_path: Option<&str>,
) -> Result<Vec<ResolvedMcpConfig>> {
    resolve_effective_mcp_configs_for_transports(agent_id, project_path, None)
}

pub fn resolve_effective_mcp_configs_for_transports(
    agent_id: &str,
    project_path: Option<&str>,
    allowed: Option<(bool, bool)>,
) -> Result<Vec<ResolvedMcpConfig>> {
    let mut out = Vec::new();
    for installation in effective_mcp_installations(agent_id, project_path)? {
        let selected_kind = installation.runtime.get("kind").and_then(|v| v.as_str());
        if let Some((stdio, http)) = allowed {
            if (selected_kind == Some("remote") && !http)
                || (selected_kind == Some("package") && !stdio)
            {
                continue;
            }
        }
        let Some(artifact) = get_artifact(&installation.repo_key, &installation.repo_path, "mcp")?
        else {
            continue;
        };
        let values = value_map(&installation.values);
        let selected_index = installation
            .runtime
            .get("index")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let remotes = artifact
            .manifest
            .get("remotes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let packages = artifact
            .manifest
            .get("packages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let choose_remote =
            selected_kind == Some("remote") || (selected_kind.is_none() && !remotes.is_empty());
        if choose_remote {
            if allowed.is_some_and(|(_, http)| !http) {
                continue;
            }
            let Some(remote) = remotes.get(selected_index).or_else(|| remotes.first()) else {
                continue;
            };
            if allowed.is_some()
                && !matches!(
                    remote
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("streamable-http"),
                    "http" | "streamable-http"
                )
            {
                continue;
            }
            let Some(url) = remote.get("url").and_then(|v| v.as_str()) else {
                continue;
            };
            let mut headers = std::collections::HashMap::new();
            if let Some(definitions) = remote.get("headers").and_then(|v| v.as_array()) {
                for definition in definitions {
                    if let Some(name) = definition.get("name").and_then(|v| v.as_str()) {
                        if let Some(value) = values.get(name) {
                            headers.insert(name.to_string(), value.clone());
                        }
                    }
                }
            }
            out.push(ResolvedMcpConfig {
                name: artifact.name,
                transport: remote
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("streamable-http")
                    .to_string(),
                command: None,
                args: Vec::new(),
                env: Default::default(),
                url: Some(apply_variables(url.to_string(), &values)),
                headers,
            });
            continue;
        }
        if allowed.is_some_and(|(stdio, _)| !stdio) {
            continue;
        }
        let Some(package) = packages.get(selected_index).or_else(|| packages.first()) else {
            continue;
        };
        let mut config = resolve_package_mcp_config(package, &values)?;
        config.name = artifact.name;
        out.push(config);
    }
    Ok(out)
}

/// Resolve the same package launcher for discovery and subsequent Agent sessions.
pub fn resolve_package_mcp_config(
    package: &serde_json::Value,
    values: &std::collections::HashMap<String, String>,
) -> Result<ResolvedMcpConfig> {
    let registry = package
        .get("registryType")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let Some(identifier) = package
        .get("identifier")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty() && !v.starts_with('-') && !v.chars().any(char::is_whitespace))
    else {
        return Err(crate::error::GroveError::config(
            "The package must declare its executable name.",
        ));
    };
    let version = package
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if identifier.contains('\0')
        || version.contains('\0')
        || version.chars().any(char::is_whitespace)
    {
        return Err(crate::error::GroveError::config(
            "Enter a valid package name and version.",
        ));
    }
    let (command, mut args) = match registry {
        "npm" => (
            "npx".to_string(),
            vec![
                "-y".to_string(),
                if version.is_empty() {
                    identifier.to_string()
                } else {
                    format!("{identifier}@{version}")
                },
            ],
        ),
        "pypi" => (
            "uvx".to_string(),
            vec![if version.is_empty() {
                identifier.to_string()
            } else {
                format!("{identifier}=={version}")
            }],
        ),
        "oci" => (
            "docker".to_string(),
            vec![
                "run".to_string(),
                "--rm".to_string(),
                "-i".to_string(),
                if version.is_empty() {
                    identifier.to_string()
                } else {
                    format!("{identifier}:{version}")
                },
            ],
        ),
        _ => {
            return Err(crate::error::GroveError::config(
                "Choose NPM, PyPI, or OCI.",
            ))
        }
    };
    if let Some(arguments) = package.get("runtimeArguments").and_then(|v| v.as_array()) {
        args.extend(
            arguments
                .iter()
                .filter_map(|v| v.get("value").or(Some(v)).and_then(|v| v.as_str()))
                .map(String::from),
        );
    }
    if let Some(arguments) = package.get("packageArguments").and_then(|v| v.as_array()) {
        args.extend(
            arguments
                .iter()
                .filter_map(|v| v.get("value").or(Some(v)).and_then(|v| v.as_str()))
                .map(String::from),
        );
    }
    let mut env = std::collections::HashMap::new();
    if let Some(definitions) = package
        .get("environmentVariables")
        .and_then(|v| v.as_array())
    {
        for definition in definitions {
            if let Some(name) = definition.get("name").and_then(|v| v.as_str()) {
                if definition.get("isRequired").and_then(|v| v.as_bool()) == Some(true)
                    && values.get(name).is_none_or(|value| value.trim().is_empty())
                {
                    return Err(crate::error::GroveError::config(format!(
                        "{name} is required before connecting."
                    )));
                }
                if let Some(value) = values.get(name) {
                    env.insert(name.to_string(), value.clone());
                }
            }
        }
    }

    if env
        .iter()
        .any(|(name, value)| name.is_empty() || name.contains(['=', '\0']) || value.contains('\0'))
    {
        return Err(crate::error::GroveError::config(
            "Enter valid environment variable names and values.",
        ));
    }
    if registry == "oci" {
        let mut names = env.keys().cloned().collect::<Vec<String>>();
        names.sort();
        args.splice(3..3, names.into_iter().flat_map(|name| ["-e".into(), name]));
    }
    Ok(ResolvedMcpConfig {
        name: String::new(),
        transport: "stdio".into(),
        command: Some(command),
        args,
        env,
        url: None,
        headers: Default::default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct GroveDirGuard;

    impl Drop for GroveDirGuard {
        fn drop(&mut self) {
            crate::storage::set_grove_dir_override(None);
        }
    }

    #[test]
    fn package_probe_and_agent_launchers_use_the_same_runtime_and_container_environment() {
        let values =
            std::collections::HashMap::from([("API_KEY".to_string(), "private-value".to_string())]);
        for (registry, command, identifier) in [
            ("npm", "npx", "@company/server"),
            ("pypi", "uvx", "mcp-server"),
            ("oci", "docker", "ghcr.io/company/server"),
        ] {
            let package = serde_json::json!({"registryType":registry,"identifier":identifier,"version":"1.2.3","environmentVariables":[{"name":"API_KEY"}],"packageArguments":[{"value":"--stdio"}]});
            let config = resolve_package_mcp_config(&package, &values).unwrap();
            assert_eq!(config.command.as_deref(), Some(command));
            assert_eq!(config.env["API_KEY"], "private-value");
            assert_eq!(config.args.last().map(String::as_str), Some("--stdio"));
            assert!(!config.args.iter().any(|arg| arg.contains("private-value")));
            if registry == "oci" {
                assert_eq!(config.args[3..5], ["-e", "API_KEY"]);
            }
        }
        for identifier in ["", "--help", "package name"] {
            assert!(resolve_package_mcp_config(
                &serde_json::json!({"registryType":"npm","identifier":identifier}),
                &values
            )
            .is_err());
        }
    }

    #[test]
    fn resolves_remote_and_package_variants_for_the_bound_agent() {
        let _lock = crate::storage::database::test_lock().blocking_lock();
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let _guard = GroveDirGuard;

        let remote = ExtensionArtifact {
            repo_key: "remote-repo".into(),
            repo_path: "servers/remote".into(),
            source_name: "test-source".into(),
            kind: "mcp".into(),
            name: "remote-server".into(),
            version: Some("1.0.0".into()),
            description: String::new(),
            relative_path: "servers/remote".into(),
            manifest: serde_json::json!({
                "name": "remote-server",
                "remotes": [{
                    "type": "streamable-http",
                    "url": "https://{host}/mcp",
                    "headers": [{"name": "Authorization", "isSecret": true}]
                }]
            }),
        };
        let package = ExtensionArtifact {
            repo_key: "package-repo".into(),
            repo_path: "servers/package".into(),
            source_name: "test-source".into(),
            kind: "mcp".into(),
            name: "package-server".into(),
            version: Some("1.0.0".into()),
            description: String::new(),
            relative_path: "servers/package".into(),
            manifest: serde_json::json!({
                "name": "package-server",
                "packages": [{
                    "registryType": "npm",
                    "identifier": "@example/mcp",
                    "version": "2.3.4",
                    "environmentVariables": [{"name": "TOKEN", "isSecret": true}],
                    "packageArguments": [{"value": "--stdio"}]
                }]
            }),
        };
        let artifacts = [remote, package];
        replace_source_artifacts("test-source", &artifacts).unwrap();
        save_mcp_display_name("remote-repo", "servers/remote", " TradingView ").unwrap();
        save_mcp_display_name("package-repo", "servers/package", "Local tools").unwrap();
        assert!(save_mcp_display_name("remote-repo", "servers/remote", "  ").is_err());
        assert!(save_mcp_display_name("remote-repo", "servers/remote", "bad\nname").is_err());
        assert!(save_mcp_display_name("remote-repo", "servers/remote", &"a".repeat(201)).is_err());
        // A source sync replaces catalog rows but must preserve local aliases.
        replace_source_artifacts("test-source", &artifacts).unwrap();
        assert_eq!(
            mcp_display_names().unwrap()[&("remote-repo".into(), "servers/remote".into())],
            "TradingView"
        );
        save_mcp_installations(
            "remote-repo",
            "servers/remote",
            "test-source",
            "global",
            "",
            &["claude-acp".into()],
            &serde_json::json!({"kind": "remote", "index": 0}),
            &serde_json::json!({"host": "example.com", "Authorization": "Bearer secret"}),
        )
        .unwrap();
        save_mcp_installations(
            "package-repo",
            "servers/package",
            "test-source",
            "project",
            "/project",
            &["claude-acp".into()],
            &serde_json::json!({"kind": "package", "index": 0}),
            &serde_json::json!({"TOKEN": "secret"}),
        )
        .unwrap();

        let global = resolve_effective_mcp_configs("claude-acp", None).unwrap();
        assert_eq!(global.len(), 1);
        assert_eq!(global[0].name, "remote-server");
        assert_eq!(global[0].url.as_deref(), Some("https://example.com/mcp"));
        assert_eq!(
            global[0].headers.get("Authorization").map(String::as_str),
            Some("Bearer secret")
        );

        let project = resolve_effective_mcp_configs("claude-acp", Some("/project")).unwrap();
        assert_eq!(project.len(), 2);
        let package = project
            .iter()
            .find(|config| config.name == "package-server")
            .unwrap();
        assert_eq!(package.command.as_deref(), Some("npx"));
        assert_eq!(package.args, ["-y", "@example/mcp@2.3.4", "--stdio"]);
        assert_eq!(package.env.get("TOKEN").map(String::as_str), Some("secret"));

        assert!(
            resolve_effective_mcp_configs("other-agent", Some("/project"))
                .unwrap()
                .is_empty()
        );
        remove_source_artifacts("test-source").unwrap();
        assert!(mcp_display_names().unwrap().is_empty());
    }
}
