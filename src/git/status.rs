//! Worktree status helpers: ahead/behind against a ref and the uncommitted
//! (staged / unstaged / untracked) changes of a worktree. Local refs only —
//! nothing here touches the network.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

use super::{git_cmd, git_cmd_raw};
use crate::error::{GroveError, Result};

/// Untracked files larger than this are listed without a line count.
const UNTRACKED_COUNT_MAX_BYTES: u64 = 1024 * 1024;
/// At most this many untracked files get a line count per call.
const UNTRACKED_COUNT_MAX_FILES: usize = 200;
/// Bytes sniffed for a NUL to decide an untracked file is binary.
const BINARY_SNIFF_BYTES: usize = 8000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
    Conflicted,
}

impl WorktreeChangeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Modified => "modified",
            Self::Added => "added",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Copied => "copied",
            Self::TypeChanged => "typechange",
            Self::Untracked => "untracked",
            Self::Conflicted => "conflicted",
        }
    }

    fn from_code(code: u8) -> Option<Self> {
        match code {
            b'M' => Some(Self::Modified),
            b'A' => Some(Self::Added),
            b'D' => Some(Self::Deleted),
            b'R' => Some(Self::Renamed),
            b'C' => Some(Self::Copied),
            b'T' => Some(Self::TypeChanged),
            _ => None,
        }
    }
}

/// One uncommitted change. A file that is both staged and modified again in
/// the worktree (`MM`) yields two entries, one per side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeChange {
    pub path: String,
    pub old_path: Option<String>,
    pub kind: WorktreeChangeKind,
    pub staged: bool,
    /// `None` for binary files, or untracked files too large / too many to count.
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Commits `HEAD` has that `base` doesn't (ahead) and vice versa (behind).
/// Executes: git rev-list --left-right --count HEAD...{base}
pub fn ahead_behind(worktree_path: &str, base: &str) -> Result<(u32, u32)> {
    let spec = format!("HEAD...{}", base);
    let output = git_cmd(
        worktree_path,
        &["rev-list", "--left-right", "--count", &spec, "--"],
    )?;
    let mut parts = output.split_whitespace();
    let parse = |s: Option<&str>| {
        s.and_then(|v| v.parse::<u32>().ok())
            .ok_or_else(|| GroveError::git(format!("Unexpected rev-list output: {output}")))
    };
    let ahead = parse(parts.next())?;
    let behind = parse(parts.next())?;
    Ok((ahead, behind))
}

fn is_conflict(x: u8, y: u8) -> bool {
    matches!(
        (x, y),
        (b'D', b'D')
            | (b'A', b'U')
            | (b'U', b'D')
            | (b'U', b'A')
            | (b'D', b'U')
            | (b'A', b'A')
            | (b'U', b'U')
    )
}

/// Parse `git status --porcelain=v1 -z` output into change entries (without
/// line counts).
pub(crate) fn parse_porcelain_z(output: &str) -> Vec<WorktreeChange> {
    let mut changes = Vec::new();
    let mut fields = output.split('\0');
    while let Some(record) = fields.next() {
        let bytes = record.as_bytes();
        if bytes.len() < 4 {
            continue;
        }
        let (x, y) = (bytes[0], bytes[1]);
        let path = record[3..].to_string();
        // Renames and copies carry the original path in the next field.
        let old_path = if x == b'R' || x == b'C' || y == b'R' || y == b'C' {
            fields.next().map(str::to_string)
        } else {
            None
        };
        if x == b'?' && y == b'?' {
            changes.push(WorktreeChange {
                path,
                old_path: None,
                kind: WorktreeChangeKind::Untracked,
                staged: false,
                additions: None,
                deletions: None,
            });
            continue;
        }
        if x == b'!' {
            continue;
        }
        if is_conflict(x, y) {
            changes.push(WorktreeChange {
                path,
                old_path: None,
                kind: WorktreeChangeKind::Conflicted,
                staged: false,
                additions: None,
                deletions: None,
            });
            continue;
        }
        if let Some(kind) = WorktreeChangeKind::from_code(x) {
            changes.push(WorktreeChange {
                path: path.clone(),
                old_path: if matches!(x, b'R' | b'C') {
                    old_path.clone()
                } else {
                    None
                },
                kind,
                staged: true,
                additions: None,
                deletions: None,
            });
        }
        if let Some(kind) = WorktreeChangeKind::from_code(y) {
            changes.push(WorktreeChange {
                path,
                old_path: if matches!(y, b'R' | b'C') {
                    old_path
                } else {
                    None
                },
                kind,
                staged: false,
                additions: None,
                deletions: None,
            });
        }
    }
    changes
}

/// Parse `git diff --numstat -z` output into `path → (additions, deletions)`;
/// binary files map to `None`. Renames are keyed by their new path.
pub(crate) fn parse_numstat_z(output: &str) -> HashMap<String, Option<(u32, u32)>> {
    let mut map = HashMap::new();
    let mut fields = output.split('\0');
    while let Some(record) = fields.next() {
        let record = record.trim_start_matches('\n');
        if record.is_empty() {
            continue;
        }
        let mut parts = record.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let path = if path.is_empty() {
            // Rename: `add\tdel\t\0old\0new\0`.
            let _old = fields.next();
            match fields.next() {
                Some(new) => new.to_string(),
                None => continue,
            }
        } else {
            path.to_string()
        };
        let counts = match (add.parse::<u32>(), del.parse::<u32>()) {
            (Ok(a), Ok(d)) => Some((a, d)),
            _ => None,
        };
        map.insert(path, counts);
    }
    map
}

/// Line count of a small text file; `None` when it is binary, too large or unreadable.
fn count_text_lines(path: &Path) -> Option<u32> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > UNTRACKED_COUNT_MAX_BYTES {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut buf).ok()?;
    if buf[..buf.len().min(BINARY_SNIFF_BYTES)].contains(&0) {
        return None;
    }
    if buf.is_empty() {
        return Some(0);
    }
    let newlines = buf.iter().filter(|&&b| b == b'\n').count() as u32;
    Some(if buf.last() == Some(&b'\n') {
        newlines
    } else {
        newlines + 1
    })
}

/// Uncommitted changes in a worktree: staged, unstaged and untracked (each
/// untracked file listed individually), with +/− line counts where cheap.
/// Executes: git status --porcelain=v1 -z --untracked-files=all,
///           git diff --numstat -z (unstaged) and git diff --cached --numstat -z (staged)
pub fn worktree_status(worktree_path: &str) -> Result<Vec<WorktreeChange>> {
    let porcelain = git_cmd_raw(
        worktree_path,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut changes = parse_porcelain_z(&porcelain);
    if changes.is_empty() {
        return Ok(changes);
    }

    let has_staged = changes.iter().any(|c| c.staged);
    let has_unstaged = changes
        .iter()
        .any(|c| !c.staged && c.kind != WorktreeChangeKind::Untracked);
    // A repo without commits has no HEAD to diff the index against.
    let staged_stats = if has_staged {
        git_cmd_raw(worktree_path, &["diff", "--cached", "--numstat", "-z"])
            .map(|out| parse_numstat_z(&out))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    let unstaged_stats = if has_unstaged {
        git_cmd_raw(worktree_path, &["diff", "--numstat", "-z"])
            .map(|out| parse_numstat_z(&out))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };

    let root = Path::new(worktree_path);
    let mut counted = 0usize;
    for change in &mut changes {
        let counts = match change.kind {
            WorktreeChangeKind::Conflicted => None,
            WorktreeChangeKind::Untracked => {
                if counted >= UNTRACKED_COUNT_MAX_FILES {
                    None
                } else {
                    counted += 1;
                    count_text_lines(&root.join(&change.path)).map(|lines| (lines, 0))
                }
            }
            _ => {
                let stats = if change.staged {
                    &staged_stats
                } else {
                    &unstaged_stats
                };
                stats.get(&change.path).copied().flatten()
            }
        };
        if let Some((additions, deletions)) = counts {
            change.additions = Some(additions);
            change.deletions = Some(deletions);
        }
    }
    Ok(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        git_cmd(path, &["init", "-b", "main"]).unwrap();
        git_cmd(path, &["config", "user.email", "test@example.com"]).unwrap();
        git_cmd(path, &["config", "user.name", "test"]).unwrap();
        git_cmd(path, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    fn commit_file(dir: &Path, name: &str, content: &str, message: &str) {
        let path = dir.to_str().unwrap();
        std::fs::write(dir.join(name), content).unwrap();
        git_cmd(path, &["add", name]).unwrap();
        git_cmd(path, &["commit", "-m", message]).unwrap();
    }

    #[test]
    fn parses_porcelain_records() {
        let out = " M src/a.rs\0MM both.txt\0A  new.txt\0R  new name.txt\0old name.txt\0?? dir/u.txt\0UU c.txt\0D  gone.txt\0";
        let changes = parse_porcelain_z(out);
        let summary: Vec<_> = changes
            .iter()
            .map(|c| (c.path.as_str(), c.kind, c.staged, c.old_path.as_deref()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("src/a.rs", WorktreeChangeKind::Modified, false, None),
                ("both.txt", WorktreeChangeKind::Modified, true, None),
                ("both.txt", WorktreeChangeKind::Modified, false, None),
                ("new.txt", WorktreeChangeKind::Added, true, None),
                (
                    "new name.txt",
                    WorktreeChangeKind::Renamed,
                    true,
                    Some("old name.txt")
                ),
                ("dir/u.txt", WorktreeChangeKind::Untracked, false, None),
                ("c.txt", WorktreeChangeKind::Conflicted, false, None),
                ("gone.txt", WorktreeChangeKind::Deleted, true, None),
            ]
        );
    }

    #[test]
    fn parses_numstat_records_including_renames_and_binary() {
        let out = "3\t1\tsrc/a.rs\0-\t-\timg.png\x002\t0\t\0old.txt\0new.txt\0";
        let map = parse_numstat_z(out);
        assert_eq!(map.get("src/a.rs"), Some(&Some((3, 1))));
        assert_eq!(map.get("img.png"), Some(&None));
        assert_eq!(map.get("new.txt"), Some(&Some((2, 0))));
        assert!(!map.contains_key("old.txt"));
    }

    #[test]
    fn worktree_status_reports_staged_unstaged_and_untracked() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        commit_file(dir.path(), "a.txt", "one\ntwo\n", "base");
        commit_file(dir.path(), "b.txt", "keep\n", "b");

        // Staged edit, then a further unstaged edit on top.
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git_cmd(path, &["add", "a.txt"]).unwrap();
        std::fs::write(dir.path().join("a.txt"), "uno\ntwo\nthree\n").unwrap();
        // Unstaged deletion.
        std::fs::remove_file(dir.path().join("b.txt")).unwrap();
        // Untracked file inside an untracked directory, plus a leading-space name.
        std::fs::create_dir(dir.path().join("notes")).unwrap();
        std::fs::write(dir.path().join("notes/todo.md"), "a\nb\nc").unwrap();
        std::fs::write(dir.path().join(" lead.txt"), "x\n").unwrap();

        let changes = worktree_status(path).unwrap();
        let find = |p: &str, staged: bool| {
            changes
                .iter()
                .find(|c| c.path == p && c.staged == staged)
                .unwrap_or_else(|| panic!("missing {p} staged={staged}: {changes:?}"))
        };
        let a_staged = find("a.txt", true);
        assert_eq!(a_staged.kind, WorktreeChangeKind::Modified);
        assert_eq!((a_staged.additions, a_staged.deletions), (Some(1), Some(0)));
        let a_unstaged = find("a.txt", false);
        assert_eq!(
            (a_unstaged.additions, a_unstaged.deletions),
            (Some(1), Some(1))
        );
        let b = find("b.txt", false);
        assert_eq!(b.kind, WorktreeChangeKind::Deleted);
        assert_eq!((b.additions, b.deletions), (Some(0), Some(1)));
        let todo = find("notes/todo.md", false);
        assert_eq!(todo.kind, WorktreeChangeKind::Untracked);
        assert_eq!(todo.additions, Some(3));
        assert_eq!(find(" lead.txt", false).kind, WorktreeChangeKind::Untracked);
        assert_eq!(changes.len(), 5);
    }

    #[test]
    fn worktree_status_is_empty_when_clean() {
        let dir = init_repo();
        commit_file(dir.path(), "a.txt", "one\n", "base");
        assert!(worktree_status(dir.path().to_str().unwrap())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn ahead_behind_counts_both_sides_against_local_ref() {
        let dir = init_repo();
        let path = dir.path().to_str().unwrap();
        commit_file(dir.path(), "a.txt", "one\n", "base");
        git_cmd(path, &["checkout", "-b", "task"]).unwrap();
        commit_file(dir.path(), "t1.txt", "1\n", "t1");
        commit_file(dir.path(), "t2.txt", "2\n", "t2");
        git_cmd(path, &["checkout", "main"]).unwrap();
        commit_file(dir.path(), "m1.txt", "1\n", "m1");
        git_cmd(path, &["checkout", "task"]).unwrap();
        assert_eq!(ahead_behind(path, "main").unwrap(), (2, 1));
        assert!(ahead_behind(path, "does-not-exist").is_err());
    }
}
