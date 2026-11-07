//! Project export / import: move one Project's data between Grove installs.
//!
//! `tables` declares what is exported and encodes rows as JSON, `archive`
//! reads and writes the tar.gz.

pub(crate) mod archive;
pub(crate) mod tables;

pub(crate) mod export;
pub(crate) mod import;

use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

/// `manifest.json` of a project archive.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Manifest {
    pub format_version: u32,
    pub grove_version: String,
    pub exported_at: String,
    pub grove_dir: String,
    /// Host name of the exporting machine; empty if the archive lacks it.
    #[serde(default)]
    pub source_host: String,
    pub project: ManifestProject,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ManifestProject {
    pub hash: String,
    pub name: String,
    pub path: String,
    /// "repo" | "studio"
    pub project_type: String,
    pub is_git_repo: bool,
}

pub use export::{default_export_file_name, export_project, resolve_project, ExportSummary};
pub use import::{import_project, ImportOptions, ImportReport};

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::Path;

    use flate2::write::GzEncoder;
    use flate2::Compression;

    use crate::storage::{database, set_grove_dir_override};

    /// Holds the DB test lock and points the Grove dir into a tempdir until
    /// dropped.
    pub(crate) struct TestGrove {
        pub root: tempfile::TempDir,
        _lock: tokio::sync::MutexGuard<'static, ()>,
    }

    impl TestGrove {
        /// Grove dir at `<root>/grove`.
        pub fn new() -> TestGrove {
            let lock = database::test_lock().blocking_lock();
            let grove = TestGrove {
                root: tempfile::tempdir().unwrap(),
                _lock: lock,
            };
            grove.use_dir("grove");
            grove
        }

        /// Switch the Grove dir to `<root>/<name>` (another "machine").
        pub fn use_dir(&self, name: &str) {
            set_grove_dir_override(Some(self.root.path().join(name)));
        }
    }

    impl Drop for TestGrove {
        fn drop(&mut self) {
            set_grove_dir_override(None);
        }
    }

    /// A tar.gz built entry by entry, for archives `write_archive` never writes.
    pub(crate) fn hostile_tar(
        path: &Path,
        build: impl FnOnce(&mut tar::Builder<GzEncoder<fs::File>>),
    ) {
        let gz = GzEncoder::new(fs::File::create(path).unwrap(), Compression::default());
        let mut b = tar::Builder::new(gz);
        build(&mut b);
        b.into_inner().unwrap().finish().unwrap();
    }

    /// Header with `name` written raw, bypassing the tar crate's path checks.
    pub(crate) fn raw_file_header(name: &[u8], ty: tar::EntryType, size: u64) -> tar::Header {
        let mut h = tar::Header::new_gnu();
        h.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
        h.set_entry_type(ty);
        h.set_size(size);
        h.set_mode(0o644);
        h.set_cksum();
        h
    }
}
