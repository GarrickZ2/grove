//! Moves installed Registry channels to the Registry's version after the
//! background refresh. Upgrading only rewrites the stored version (and, for
//! binaries, the extracted install): running Sessions keep what they started
//! with and new connections read the new version. A channel that fails keeps
//! its record and is tried again after the next refresh.

use super::agent_install;
use super::agent_registry::{BinaryTarget, RegistryAgent, RegistryDocument};
use super::installed_agents::{self, InstallMethod, InstallStatus, InstalledAgent};
use crate::error::Result;

#[derive(Debug)]
struct Upgrade {
    method: InstallMethod,
    from: String,
    to: String,
    /// What to fetch first. Package channels only need the record changed.
    binary: Option<BinaryTarget>,
}

fn plan(agent: &InstalledAgent, registry: &RegistryAgent, platform: &str) -> Vec<Upgrade> {
    if registry.version.is_empty() {
        return Vec::new();
    }
    agent
        .installations
        .iter()
        // An empty version is deliberately unpinned.
        .filter(|install| {
            install.status == InstallStatus::Installed
                && !install.version.is_empty()
                && install.version != registry.version
        })
        .filter_map(|install| {
            let binary = match install.method {
                InstallMethod::External => return None,
                InstallMethod::Npx => {
                    registry.distribution.npx.as_ref()?;
                    None
                }
                InstallMethod::Uvx => {
                    registry.distribution.uvx.as_ref()?;
                    None
                }
                InstallMethod::Binary => {
                    let target = registry.distribution.binary.get(platform)?;
                    if target.archive.is_empty() {
                        return None;
                    }
                    Some(target.clone())
                }
            };
            Some(Upgrade {
                method: install.method,
                from: install.version.clone(),
                to: registry.version.clone(),
                binary,
            })
        })
        .collect()
}

async fn apply(id: &str, upgrade: Upgrade) -> Result<()> {
    let install_path = match &upgrade.binary {
        Some(target) => {
            let path = agent_install::download_and_extract(id, &upgrade.to, target).await?;
            Some(path.to_string_lossy().into_owned())
        }
        None => None,
    };
    let updated = installed_agents::update_installation_version(
        id,
        upgrade.method,
        &upgrade.from,
        &upgrade.to,
        install_path,
    )?;
    if !updated {
        eprintln!(
            "[auto_update] {id} {} changed during the upgrade, leaving it",
            upgrade.method.as_str()
        );
    }
    Ok(())
}

/// Upgrade every Agent that has auto update on.
pub async fn run(registry: &RegistryDocument) {
    let agents = match installed_agents::list() {
        Ok(agents) => agents,
        Err(e) => {
            eprintln!("[auto_update] listing installed agents failed: {e}");
            return;
        }
    };
    let platform = agent_install::current_platform_key();
    for agent in agents {
        if !installed_agents::get_auto_update(&agent.id).unwrap_or(false) {
            continue;
        }
        let Some(entry) = registry.agents.iter().find(|entry| entry.id == agent.id) else {
            continue;
        };
        for upgrade in plan(&agent, entry, platform) {
            let (method, to) = (upgrade.method, upgrade.to.clone());
            if let Err(e) = apply(&agent.id, upgrade).await {
                eprintln!(
                    "[auto_update] {} {} to {to} failed: {e}",
                    agent.id,
                    method.as_str()
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::agent_registry::{Distribution, NpxDistribution, UvxDistribution};
    use crate::storage::installed_agents::{get, set_auto_update, upsert, Installation};
    use chrono::Utc;
    use std::collections::HashMap;
    use std::io::Write;
    use std::path::Path;

    const OLD: &str = "1.0.0";
    const NEW: &str = "2.0.0";

    fn install(method: InstallMethod, version: &str) -> Installation {
        Installation {
            method,
            version: version.to_string(),
            install_path: None,
            status: InstallStatus::Installed,
            failure_reason: None,
            installed_at: Utc::now(),
        }
    }

    fn agent(installations: Vec<Installation>) -> InstalledAgent {
        InstalledAgent {
            id: "agent".to_string(),
            selected_install_method: installations[0].method,
            installations,
            args_override: Vec::new(),
            env_override: HashMap::new(),
            hidden: false,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn target(archive: &str) -> BinaryTarget {
        BinaryTarget {
            archive: archive.to_string(),
            cmd: "./bin/agent".to_string(),
            args: Vec::new(),
            env: HashMap::new(),
        }
    }

    fn entry(version: &str, archive: &str) -> RegistryAgent {
        RegistryAgent {
            id: "agent".to_string(),
            name: "Agent".to_string(),
            version: version.to_string(),
            description: String::new(),
            repository: None,
            website: None,
            authors: Vec::new(),
            license: None,
            icon: None,
            distribution: Distribution {
                npx: Some(NpxDistribution {
                    package: "agent".to_string(),
                    args: Vec::new(),
                    env: HashMap::new(),
                }),
                uvx: Some(UvxDistribution {
                    package: "agent".to_string(),
                    args: Vec::new(),
                    env: HashMap::new(),
                }),
                binary: HashMap::from([(
                    agent_install::current_platform_key().to_string(),
                    target(archive),
                )]),
                local: None,
            },
        }
    }

    fn document(agents: Vec<RegistryAgent>) -> RegistryDocument {
        RegistryDocument {
            version: "1".to_string(),
            agents,
        }
    }

    fn planned(installed: &InstalledAgent, registry: &RegistryAgent) -> Vec<InstallMethod> {
        plan(installed, registry, agent_install::current_platform_key())
            .into_iter()
            .map(|upgrade| upgrade.method)
            .collect()
    }

    fn version_of(method: InstallMethod) -> String {
        get("agent")
            .unwrap()
            .unwrap()
            .installations
            .into_iter()
            .find(|install| install.method == method)
            .unwrap()
            .version
    }

    fn archive_with_agent() -> Vec<u8> {
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        {
            let mut tar = tar::Builder::new(&mut gz);
            let body = b"#!/bin/sh\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, "bin/agent", &body[..])
                .unwrap();
            tar.finish().unwrap();
        }
        gz.flush().unwrap();
        gz.finish().unwrap()
    }

    /// Serves `body` at `/agent.tar.gz` and 404s anything else.
    async fn serve(body: Vec<u8>) -> String {
        let app = axum::Router::new().route(
            "/agent.tar.gz",
            axum::routing::get(move || {
                let body = body.clone();
                async move { body }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn binary_install(path: &Path) -> Installation {
        Installation {
            install_path: Some(path.to_string_lossy().into_owned()),
            ..install(InstallMethod::Binary, OLD)
        }
    }

    /// An installed binary at the old version, on disk and in the record.
    fn seed_binary() -> std::path::PathBuf {
        let dir = agent_install::install_dir("agent", OLD).join("bin");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent");
        std::fs::write(&path, "old").unwrap();
        upsert(&agent(vec![binary_install(&path)])).unwrap();
        path
    }

    #[test]
    fn plans_every_outdated_package_and_binary_channel() {
        let installed = agent(vec![
            install(InstallMethod::Npx, OLD),
            install(InstallMethod::Uvx, OLD),
            install(InstallMethod::Binary, OLD),
        ]);
        assert_eq!(
            planned(&installed, &entry(NEW, "https://example.com/a.tar.gz")),
            [
                InstallMethod::Npx,
                InstallMethod::Uvx,
                InstallMethod::Binary
            ]
        );
    }

    #[test]
    fn skips_channels_it_must_leave_alone() {
        let registry = entry(NEW, "https://example.com/a.tar.gz");
        let failed = Installation {
            status: InstallStatus::Failed,
            ..install(InstallMethod::Npx, OLD)
        };
        for skipped in [
            install(InstallMethod::External, OLD),
            install(InstallMethod::Npx, ""),
            install(InstallMethod::Npx, NEW),
            failed,
        ] {
            assert!(planned(&agent(vec![skipped]), &registry).is_empty());
        }
    }

    #[test]
    fn skips_what_the_registry_no_longer_offers() {
        let installed = agent(vec![
            install(InstallMethod::Npx, OLD),
            install(InstallMethod::Uvx, OLD),
            install(InstallMethod::Binary, OLD),
        ]);
        assert!(planned(&installed, &entry("", "https://example.com/a.tar.gz")).is_empty());

        let mut registry = entry(NEW, "");
        registry.distribution.npx = None;
        registry.distribution.uvx = None;
        assert!(planned(&installed, &registry).is_empty());
        registry.distribution.binary.clear();
        assert!(planned(&installed, &registry).is_empty());
    }

    #[tokio::test]
    async fn enabled_agents_upgrade_and_disabled_ones_stay() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        upsert(&agent(vec![
            install(InstallMethod::Npx, OLD),
            install(InstallMethod::Uvx, OLD),
        ]))
        .unwrap();
        let registry = document(vec![entry(NEW, "")]);

        set_auto_update("agent", false).unwrap();
        run(&registry).await;
        assert_eq!(version_of(InstallMethod::Npx), OLD);

        set_auto_update("agent", true).unwrap();
        run(&registry).await;
        assert_eq!(version_of(InstallMethod::Npx), NEW);
        assert_eq!(version_of(InstallMethod::Uvx), NEW);

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn auto_update_defaults_on() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        upsert(&agent(vec![install(InstallMethod::Npx, OLD)])).unwrap();
        assert!(installed_agents::get_auto_update("agent").unwrap());

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn a_channel_changed_meanwhile_is_not_overwritten() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));

        upsert(&agent(vec![install(InstallMethod::Npx, "1.5.0")])).unwrap();
        let upgrade = Upgrade {
            method: InstallMethod::Npx,
            from: OLD.to_string(),
            to: NEW.to_string(),
            binary: None,
        };
        apply("agent", upgrade).await.unwrap();
        assert_eq!(version_of(InstallMethod::Npx), "1.5.0");

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn a_failed_binary_download_changes_nothing() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let binary = seed_binary();
        let base = serve(archive_with_agent()).await;

        run(&document(vec![entry(
            NEW,
            &format!("{base}/missing.tar.gz"),
        )]))
        .await;

        let record = get("agent").unwrap().unwrap();
        assert_eq!(record.installations[0].version, OLD);
        assert_eq!(
            record.installations[0].install_path.as_deref(),
            binary.to_str()
        );
        assert_eq!(std::fs::read_to_string(&binary).unwrap(), "old");
        assert!(!agent_install::install_dir("agent", NEW).exists());

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn a_failed_reinstall_keeps_the_existing_install() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let binary = seed_binary();
        // Downloads fine, but isn't the archive it claims to be.
        let base = serve(b"not an archive".to_vec()).await;
        let broken = target(&format!("{base}/agent.tar.gz"));

        assert!(agent_install::download_and_extract("agent", OLD, &broken)
            .await
            .is_err());

        assert_eq!(std::fs::read_to_string(&binary).unwrap(), "old");
        let leftovers = std::fs::read_dir(temp.path().join("agents/agent"))
            .unwrap()
            .count();
        assert_eq!(leftovers, 1);

        crate::storage::set_grove_dir_override(None);
    }

    #[tokio::test]
    async fn a_binary_is_recorded_only_after_it_is_in_place() {
        let _l = crate::storage::database::test_lock().lock().await;
        let temp = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(temp.path().to_path_buf()));
        let old_binary = seed_binary();
        let base = serve(archive_with_agent()).await;

        run(&document(vec![entry(NEW, &format!("{base}/agent.tar.gz"))])).await;

        let record = get("agent").unwrap().unwrap();
        let install = &record.installations[0];
        assert_eq!(install.version, NEW);
        let path = install.install_path.as_deref().unwrap();
        assert_eq!(
            Path::new(path),
            agent_install::install_dir("agent", NEW).join("bin/agent")
        );
        assert!(Path::new(path).is_file());
        // The running version's files stay where its Sessions expect them.
        assert!(old_binary.is_file());

        crate::storage::set_grove_dir_override(None);
    }
}
