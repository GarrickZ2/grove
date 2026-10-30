use std::path::Path;
use std::process::{Command, Output};

fn register(home: &Path) -> Output {
    let project = home.join("project");
    std::fs::create_dir_all(&project).unwrap();
    Command::new(env!("CARGO_BIN_EXE_grove"))
        .env("HOME", home)
        .env("RUST_BACKTRACE", "1")
        .args(["register", project.to_str().unwrap()])
        .output()
        .unwrap()
}

fn assert_storage_error(output: &Output, database: &Path) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert_eq!(output.status.code(), Some(1), "{stderr}");
    assert!(stderr.contains("Failed to register project:"), "{stderr}");
    assert!(stderr.contains(&database.display().to_string()), "{stderr}");
    assert!(!stderr.contains("panicked"), "{stderr}");
    assert!(!stderr.contains("stack backtrace"), "{stderr}");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Registered project:"));
    stderr
}

#[test]
fn register_reports_an_unusable_database_path_without_panicking() {
    let home = tempfile::tempdir().unwrap();
    let database = home.path().join(".grove/grove.db");
    std::fs::create_dir_all(&database).unwrap();

    assert_storage_error(&register(home.path()), &database);
}

#[test]
fn register_succeeds_with_writable_storage() {
    let home = tempfile::tempdir().unwrap();
    let output = register(home.path());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("Registered project:"));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    struct RestorePermissions(PathBuf, std::fs::Permissions);

    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            std::fs::set_permissions(&self.0, self.1.clone()).unwrap();
        }
    }

    fn readonly_storage(parent_readonly: bool) {
        // Root can bypass Unix mode bits, so these fixtures cannot enforce
        // read-only access under that account. The path-error test still runs.
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("Skipping Unix permission fixture when running as root");
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let grove_dir = home.path().join(".grove");
        std::fs::create_dir_all(&grove_dir).unwrap();
        let database = grove_dir.join("grove.db");
        let conn = rusqlite::Connection::open(&database).unwrap();
        conn.execute_batch("CREATE TABLE sentinel (value TEXT);")
            .unwrap();
        drop(conn);

        let target = if parent_readonly {
            &grove_dir
        } else {
            &database
        };
        let _restore = RestorePermissions(target.clone(), target.metadata().unwrap().permissions());
        std::fs::set_permissions(
            target,
            std::fs::Permissions::from_mode(if parent_readonly { 0o555 } else { 0o444 }),
        )
        .unwrap();

        let stderr = assert_storage_error(&register(home.path()), &database);
        assert!(stderr.contains("readonly"), "{stderr}");
        assert!(stderr.contains("Check write access"), "{stderr}");
    }

    #[test]
    fn register_reports_a_readonly_database_without_panicking() {
        readonly_storage(false);
    }

    #[test]
    fn register_reports_a_readonly_parent_directory_without_panicking() {
        readonly_storage(true);
    }
}
