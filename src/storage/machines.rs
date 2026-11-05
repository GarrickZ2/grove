//! This machine's identity and the Grove servers it is paired with.
//!
//! Kept in `machines.toml` rather than the database: it holds device signing
//! keys, so it stays private (0600) and outside data export.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// How a machine presents itself to people and to Buddies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
}

/// A paired machine. Both sides keep one; only the side that added the pair
/// has a `url` and a device key, and that side keeps the connection open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Peer {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Outgoing: our device on the peer. Incoming: the peer's device here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_key: Option<String>,
    /// Stable, so the window's per-origin storage survives a restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_port: Option<u16>,
    /// Sent on every request, for a front door such as an access proxy.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    pub profile: Profile,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct MachinesFile {
    #[serde(default, rename = "self", skip_serializing_if = "Option::is_none")]
    this: Option<Profile>,
    #[serde(default, rename = "peer")]
    peers: Vec<Peer>,
}

static WRITES: Mutex<()> = Mutex::new(());

fn path() -> PathBuf {
    super::grove_dir().join("machines.toml")
}

fn load() -> Result<MachinesFile> {
    match std::fs::read_to_string(path()) {
        Ok(raw) => toml::from_str(&raw)
            .map_err(|e| crate::error::GroveError::storage(format!("machines.toml: {e}"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(MachinesFile::default()),
        Err(error) => Err(error.into()),
    }
}

fn save(file: &MachinesFile) -> Result<()> {
    let path = path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = toml::to_string_pretty(file)
        .map_err(|e| crate::error::GroveError::storage(format!("machines.toml: {e}")))?;
    let temporary = path.with_extension("toml.tmp");
    std::fs::write(&temporary, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn change<T>(run: impl FnOnce(&mut MachinesFile) -> T) -> Result<T> {
    let _guard = WRITES.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load()?;
    let result = run(&mut file);
    save(&file)?;
    Ok(result)
}

/// This machine's profile, created from `fresh` the first time.
pub fn this_or(fresh: impl FnOnce() -> Profile) -> Result<Profile> {
    if let Some(profile) = load()?.this {
        return Ok(profile);
    }
    change(|file| file.this.get_or_insert_with(fresh).clone())
}

pub fn set_this(profile: Profile) -> Result<()> {
    change(|file| file.this = Some(profile))
}

pub fn peers() -> Result<Vec<Peer>> {
    Ok(load()?.peers)
}

pub fn peer(id: &str) -> Result<Option<Peer>> {
    Ok(load()?.peers.into_iter().find(|p| p.profile.id == id))
}

/// Add a peer, or replace the one with the same id.
pub fn save_peer(peer: Peer) -> Result<()> {
    change(|file| {
        match file
            .peers
            .iter_mut()
            .find(|p| p.profile.id == peer.profile.id)
        {
            Some(existing) => *existing = peer,
            None => file.peers.push(peer),
        }
    })
}

/// Change a peer if it exists; returns whether it did.
pub fn update_peer(id: &str, update: impl FnOnce(&mut Peer)) -> Result<bool> {
    change(
        |file| match file.peers.iter_mut().find(|p| p.profile.id == id) {
            Some(peer) => {
                update(peer);
                true
            }
            None => false,
        },
    )
}

pub fn remove_peer(id: &str) -> Result<Option<Peer>> {
    change(|file| {
        let index = file.peers.iter().position(|p| p.profile.id == id)?;
        Some(file.peers.remove(index))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: format!("{id} name"),
            description: "does things".into(),
            icon: "server".into(),
        }
    }

    fn peer_with(id: &str) -> Peer {
        Peer {
            url: Some("http://devbox:3900".into()),
            device_id: Some("device".into()),
            device_key: Some("key".into()),
            proxy_port: Some(4100),
            headers: BTreeMap::from([("CF-Access-Client-Id".into(), "abc".into())]),
            profile: profile(id),
        }
    }

    #[test]
    fn peers_round_trip_privately_and_replace_by_id() {
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        let first = this_or(|| profile("me")).unwrap();
        assert_eq!(this_or(|| profile("other")).unwrap(), first);

        save_peer(peer_with("b")).unwrap();
        let mut renamed = peer_with("b");
        renamed.profile.name = "Dev box".into();
        save_peer(renamed.clone()).unwrap();
        assert_eq!(peers().unwrap(), vec![renamed]);
        assert_eq!(peer("b").unwrap().unwrap().headers.len(), 1);

        assert!(update_peer("b", |p| p.proxy_port = Some(4200)).unwrap());
        assert!(!update_peer("missing", |_| {}).unwrap());
        assert_eq!(peer("b").unwrap().unwrap().proxy_port, Some(4200));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(remove_peer("b").unwrap().is_some());
        assert!(remove_peer("b").unwrap().is_none());
        crate::storage::set_grove_dir_override(None);
    }
}
