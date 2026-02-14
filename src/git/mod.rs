use std::path::Path;
use std::process::{Command, Stdio};

use crate::error::{GroveError, Result};

pub mod cache;

// ============================================================================
// Git 命令执行助手函数
// ============================================================================

/// 执行 git 命令并返回 stdout (trim 后)
pub(crate) fn git_cmd(path: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git: {}", e)))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(GroveError::git(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        )))
    }
}

/// 执行 git 命令，仅返回成功/失败
fn git_cmd_unit(path: &str, args: &[&str]) -> Result<()> {
    git_cmd(path, args).map(|_| ())
}

/// 执行 git 命令，仅检查是否成功 (用于 bool 检查)
fn git_cmd_check(path: &str, args: &[&str]) -> bool {
    git_cmd(path, args).is_ok()
}

/// 解析 git diff --numstat 输出为 (additions, deletions, files_changed)
fn parse_numstat(output: &str) -> (u32, u32, u32) {
    output
        .lines()
        .filter(|l| !l.is_empty())
        .fold((0, 0, 0), |(add, del, count), line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                let a = parts[0].parse::<u32>().unwrap_or(0);
                let d = parts[1].parse::<u32>().unwrap_or(0);
                (add + a, del + d, count + 1)
            } else {
                (add, del, count)
            }
        })
}

/// Get `git config user.name` from the given repo path.
pub fn git_user_name(path: &str) -> Option<String> {
    git_cmd(path, &["config", "user.name"])
        .ok()
        .filter(|s| !s.is_empty())
}

// ============================================================================
// Git 公开 API
// ============================================================================

/// 创建 git worktree
/// 执行: git worktree add -b {branch} {path} {base}
pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
    base_branch: &str,
) -> Result<()> {
    git_cmd_unit(
        repo_path,
        &[
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path.to_str().unwrap_or_default(),
            base_branch,
        ],
    )
}

/// 获取当前分支名
/// 执行: git rev-parse --abbrev-ref HEAD
pub fn current_branch(repo_path: &str) -> Result<String> {
    git_cmd(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// 获取仓库根目录
/// 执行: git rev-parse --show-toplevel
pub fn repo_root(path: &str) -> Result<String> {
    git_cmd(path, &["rev-parse", "--show-toplevel"])
}

/// 检查是否在 git 仓库中
pub fn is_git_repo(path: &str) -> bool {
    git_cmd_check(path, &["rev-parse", "--git-dir"])
}

/// 检查当前路径是否是一个 worktree (而不是主 repo)
/// Worktree 的特征:git-dir 和 git-common-dir 不同
pub fn is_worktree(path: &str) -> bool {
    let git_dir = git_cmd(path, &["rev-parse", "--git-dir"]);
    let common_dir = git_cmd(path, &["rev-parse", "--git-common-dir"]);

    if let (Ok(gdir), Ok(cdir)) = (git_dir, common_dir) {
        // 规范化路径以进行比较
        let gdir_abs = Path::new(path).join(&gdir);
        let cdir_abs = Path::new(path).join(&cdir);

        // 如果两个目录不同,说明是 worktree
        match (gdir_abs.canonicalize(), cdir_abs.canonicalize()) {
            (Ok(g), Ok(c)) => g != c,
            _ => false,
        }
    } else {
        false
    }
}

/// 获取主 repo 路径 (对于 worktree,返回主 repo;对于主 repo,返回自身)
/// 使用 git-common-dir 来定位主 repo
pub fn get_main_repo_path(path: &str) -> Result<String> {
    if is_worktree(path) {
        // 对于 worktree,git-common-dir 指向主 repo 的 .git 目录
        let common_dir = git_cmd(path, &["rev-parse", "--git-common-dir"])?;
        let common_abs = Path::new(path).join(&common_dir);

        // 主 repo 的 .git 目录的父目录就是主 repo 路径
        if let Some(parent) = common_abs.parent() {
            parent
                .canonicalize()
                .map_err(|e| GroveError::git(format!("Failed to canonicalize path: {}", e)))
                .and_then(|p| {
                    p.to_str()
                        .map(|s| s.to_string())
                        .ok_or_else(|| GroveError::git("Invalid path encoding"))
                })
        } else {
            Err(GroveError::git("Failed to find main repo path"))
        }
    } else {
        // 对于主 repo,返回自身
        repo_root(path)
    }
}

/// 计算 branch 相对于 target 新增的 commit 数
/// 执行: git rev-list --count {target}..{branch}
pub fn commits_behind(worktree_path: &str, branch: &str, target: &str) -> Result<u32> {
    let range = format!("{}..{}", target, branch);
    git_cmd(worktree_path, &["rev-list", "--count", &range])?
        .parse::<u32>()
        .map_err(|e| GroveError::git(format!("Failed to parse count: {}", e)))
}

/// 获取文件变更统计 (相对于 target)
/// 执行: git diff --numstat {target}
/// 返回: (additions, deletions, files_changed)
pub fn file_changes(worktree_path: &str, target: &str) -> Result<(u32, u32, u32)> {
    git_cmd(worktree_path, &["diff", "--numstat", target]).map(|output| parse_numstat(&output))
}

/// 删除 worktree（保留 branch）
/// 执行: git worktree remove {path} --force
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["worktree", "remove", worktree_path, "--force"])
}

/// 从现有分支创建 worktree（不创建新分支）
/// 执行: git worktree add {path} {branch}
pub fn create_worktree_from_branch(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
) -> Result<()> {
    git_cmd_unit(
        repo_path,
        &[
            "worktree",
            "add",
            worktree_path.to_str().unwrap_or_default(),
            branch,
        ],
    )
}

/// 删除分支
/// 执行: git branch -D {branch}
pub fn delete_branch(repo_path: &str, branch: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["branch", "-D", branch])
}

/// 检查分支是否存在
pub fn branch_exists(repo_path: &str, branch: &str) -> bool {
    git_cmd_check(repo_path, &["rev-parse", "--verify", branch])
}

/// 列出所有本地分支
pub fn list_branches(repo_path: &str) -> Result<Vec<String>> {
    git_cmd(repo_path, &["branch", "--format=%(refname:short)"]).map(|output| {
        output
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            // Filter out detached HEAD states like "(HEAD detached at origin/master)"
            .filter(|s| !s.starts_with('('))
            .collect()
    })
}

/// 列出所有远端
/// 执行: git remote
pub fn list_remotes(repo_path: &str) -> Result<Vec<String>> {
    git_cmd(repo_path, &["remote"]).map(|output| {
        output
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

/// 检查分支是否已合并到 target
/// 使用 git merge-base --is-ancestor 检查
pub fn is_merged(repo_path: &str, branch: &str, target: &str) -> Result<bool> {
    // exit code 0 = is ancestor (merged), non-zero = not merged
    Ok(git_cmd_check(
        repo_path,
        &["merge-base", "--is-ancestor", branch, target],
    ))
}

/// 检查是否有未提交的改动
/// 执行: git status --porcelain
pub fn has_uncommitted_changes(path: &str) -> Result<bool> {
    git_cmd(path, &["status", "--porcelain"]).map(|output| !output.is_empty())
}

/// 检查是否有未解决的冲突（merge/rebase 中间状态）
/// 执行: git status --porcelain 检查 UU/AA/DD 等冲突标记
pub fn has_conflicts(path: &str) -> bool {
    git_cmd(path, &["status", "--porcelain"])
        .map(|output| {
            output.lines().any(|line| {
                // 冲突状态: UU, AA, DD, AU, UA, DU, UD
                let bytes = line.as_bytes();
                if bytes.len() >= 2 {
                    let x = bytes[0];
                    let y = bytes[1];
                    matches!((x, y), (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D'))
                } else {
                    false
                }
            })
        })
        .unwrap_or(false)
}

/// 获取正在 merge 中的 commit hash（如果仓库处于 merge 冲突状态）
pub fn merging_commit(repo_path: &str) -> Option<String> {
    // 先检查是否有冲突
    if !has_conflicts(repo_path) {
        return None;
    }

    // 读取 MERGE_HEAD 获取被 merge 的 commit
    git_cmd(repo_path, &["rev-parse", "MERGE_HEAD"]).ok()
}

/// 检查某个分支的 HEAD 是否等于指定的 commit
pub fn branch_head_equals(repo_path: &str, branch: &str, commit: &str) -> bool {
    git_cmd(repo_path, &["rev-parse", branch])
        .map(|head| head.starts_with(commit) || commit.starts_with(&head))
        .unwrap_or(false)
}

/// 执行 rebase
/// 执行: git rebase {target}
pub fn rebase(worktree_path: &str, target: &str) -> Result<()> {
    git_cmd_unit(worktree_path, &["rebase", target])
}

/// Fetch origin 分支
/// 执行: git fetch origin {branch}
pub fn fetch_origin(repo_path: &str, branch: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["fetch", "origin", branch])
}

/// 中止 rebase
/// 执行: git rebase --abort
pub fn abort_rebase(repo_path: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["rebase", "--abort"])
}

/// 获取冲突文件列表
/// 执行: git diff --name-only --diff-filter=U
pub fn get_conflict_files(repo_path: &str) -> Result<Vec<String>> {
    let output = git_cmd(repo_path, &["diff", "--name-only", "--diff-filter=U"])?;
    Ok(output.lines().map(|s| s.to_string()).collect())
}

/// 切换分支
/// 执行: git checkout {branch}
pub fn checkout(repo_path: &str, branch: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["checkout", branch])
}

/// 获取最新 commit hash (短格式)
/// 执行: git rev-parse --short HEAD
pub fn get_head_short(repo_path: &str) -> Result<String> {
    git_cmd(repo_path, &["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string())
}

/// 通用 merge 命令执行函数 (带 merge 错误格式化)
fn git_merge_cmd(repo_path: &str, args: &[&str]) -> Result<()> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git: {}", e)))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(GroveError::git(format_merge_error(&stdout, &stderr)))
    }
}

/// 执行 squash merge
/// 执行: git merge --squash {branch}
pub fn merge_squash(repo_path: &str, branch: &str) -> Result<()> {
    git_merge_cmd(repo_path, &["merge", "--squash", branch])
}

/// 执行 merge commit（保留历史）
/// 执行: git merge --no-ff {branch} -m {message}
pub fn merge_no_ff(repo_path: &str, branch: &str, message: &str) -> Result<()> {
    git_merge_cmd(repo_path, &["merge", "--no-ff", branch, "-m", message])
}

/// 格式化 merge 错误信息
fn format_merge_error(stdout: &str, stderr: &str) -> String {
    // 检查是否有冲突
    let combined = format!("{}\n{}", stdout, stderr);
    if combined.contains("CONFLICT") || combined.contains("conflict") {
        // 提取冲突文件数量
        let conflict_count = combined
            .lines()
            .filter(|line| line.contains("CONFLICT"))
            .count();

        // 返回友好的 conflict 提示，建议用户先 sync
        if conflict_count == 0 {
            "Merge conflict detected. Please use Sync to resolve conflicts locally first, then try Merge again.".to_string()
        } else if conflict_count == 1 {
            "1 conflict detected. Please use Sync to resolve conflicts locally first, then try Merge again.".to_string()
        } else {
            format!("{} conflicts detected. Please use Sync to resolve conflicts locally first, then try Merge again.", conflict_count)
        }
    } else if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        "Merge failed".to_string()
    }
}

/// 回滚 merge 状态（用于 squash merge 后 commit 失败时回滚）
/// 执行: git reset --merge
/// 比 reset --hard 更安全：只回退 merge 引入的变更，保留之前已有的未提交改动
pub fn reset_merge(repo_path: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["reset", "--merge"])
}

/// 提交（用于 squash merge 后）
/// 执行: git commit -m {message}
pub fn commit(repo_path: &str, message: &str) -> Result<()> {
    git_cmd_unit(repo_path, &["commit", "-m", message])
}

/// 构建包含 notes 的 commit message
/// 如果 notes 为空或 None，返回原始标题
pub fn build_commit_message(title: &str, notes: Option<&str>) -> String {
    match notes {
        Some(n) if !n.trim().is_empty() => {
            format!("{}\n\n## Notes\n\n{}", title, n.trim())
        }
        _ => title.to_string(),
    }
}

/// 获取 git 跟踪的文件列表
/// 执行: git ls-files
pub fn list_files(repo_path: &str) -> Result<Vec<String>> {
    // List tracked files
    let tracked = git_cmd(repo_path, &["ls-files"])?;

    // List untracked files (excluding ignored files)
    let untracked =
        git_cmd(repo_path, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();

    // Combine and deduplicate
    let mut all_files: Vec<String> = tracked
        .lines()
        .chain(untracked.lines())
        .map(|s| s.to_string())
        .collect();

    // Remove duplicates (shouldn't happen, but just in case)
    all_files.sort();
    all_files.dedup();

    // Filter out files that don't actually exist in the filesystem
    // (e.g., files that were git-added but then deleted without git rm)
    let repo_path_base = Path::new(repo_path);
    all_files.retain(|file| {
        let full_path = repo_path_base.join(file);
        full_path.exists()
    });

    Ok(all_files)
}

/// 读取指定 git ref 上的文件内容
///
/// 执行: `git show {ref}:{file_path}`
pub fn show_file(repo_path: &str, git_ref: &str, file_path: &str) -> Result<String> {
    let object = format!("{}:{}", git_ref, file_path);
    git_cmd(repo_path, &["show", &object])
}

/// 读取 worktree 中的文件内容
/// 包含路径穿越保护
pub fn read_file(repo_path: &str, file_path: &str) -> Result<String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid repo path: {}", e)))?;
    let full = base
        .join(file_path)
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid file path: {}", e)))?;

    if !full.starts_with(&base) {
        return Err(GroveError::git("Path traversal detected"));
    }

    std::fs::read_to_string(&full)
        .map_err(|e| GroveError::git(format!("Failed to read file: {}", e)))
}

/// 写入 worktree 中的文件
/// 包含路径穿越保护
pub fn write_file(repo_path: &str, file_path: &str, content: &str) -> Result<()> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid repo path: {}", e)))?;
    // For write, the file might not exist yet, so canonicalize the parent
    let target = base.join(file_path);
    let parent = target
        .parent()
        .ok_or_else(|| GroveError::git("Invalid file path"))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid parent path: {}", e)))?;

    if !parent_canonical.starts_with(&base) {
        return Err(GroveError::git("Path traversal detected"));
    }

    // Reconstruct the full path using canonical parent + filename
    let file_name = target
        .file_name()
        .ok_or_else(|| GroveError::git("Invalid file name"))?;
    let final_path = parent_canonical.join(file_name);

    std::fs::write(&final_path, content)
        .map_err(|e| GroveError::git(format!("Failed to write file: {}", e)))
}

/// 获取相对于 origin 的 commits ahead 数量
/// 执行: git rev-list --count origin/{branch}..HEAD
pub fn commits_ahead_of_origin(repo_path: &str) -> Result<Option<u32>> {
    let branch = current_branch(repo_path)?;
    let origin_ref = format!("origin/{}", branch);

    // 检查 origin/{branch} 是否存在
    if !git_cmd_check(repo_path, &["rev-parse", "--verify", &origin_ref]) {
        return Ok(None);
    }

    let range = format!("{}..HEAD", origin_ref);
    git_cmd(repo_path, &["rev-list", "--count", &range])
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .map_or(Ok(None), |n| Ok(Some(n)))
}

/// 获取最近提交的相对时间
/// 执行: git log -1 --format=%cr
pub fn last_commit_time(repo_path: &str) -> Result<String> {
    git_cmd(repo_path, &["log", "-1", "--format=%cr"]).or_else(|_| Ok("unknown".to_string()))
}

/// 获取相对于 origin 的文件变更统计
/// 执行: git diff --numstat origin/{branch}
pub fn changes_from_origin(repo_path: &str) -> Result<(u32, u32)> {
    let branch = current_branch(repo_path)?;
    let origin_ref = format!("origin/{}", branch);

    // 检查 origin/{branch} 是否存在
    if !git_cmd_check(repo_path, &["rev-parse", "--verify", &origin_ref]) {
        return Ok((0, 0));
    }

    git_cmd(repo_path, &["diff", "--numstat", &origin_ref])
        .map(|output| {
            let (add, del, _) = parse_numstat(&output);
            (add, del)
        })
        .or(Ok((0, 0)))
}

/// 切换分支
/// 执行: git checkout {branch}
pub fn checkout_branch(worktree_path: &str, branch: &str) -> Result<()> {
    git_cmd_unit(worktree_path, &["checkout", branch])
}

/// 添加所有文件并提交
/// 执行: git add -A && git commit -m {message}
/// Commit log entry
#[derive(Debug, Clone)]
pub struct LogEntry {
    pub hash: String,
    pub time_ago: String,
    pub message: String,
}

/// 获取最近的 commit 日志
/// 执行: git log --format="%H\t%cr\t%s" -n {count} {target}..HEAD
pub fn recent_log(worktree_path: &str, target: &str, count: usize) -> Result<Vec<LogEntry>> {
    let range = format!("{}..HEAD", target);
    let n = format!("-{}", count);
    let output = git_cmd(worktree_path, &["log", "--format=%H\t%cr\t%s", &n, &range])?;
    Ok(output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() == 3 {
                LogEntry {
                    hash: parts[0].to_string(),
                    time_ago: parts[1].to_string(),
                    message: parts[2].to_string(),
                }
            } else {
                LogEntry {
                    hash: String::new(),
                    time_ago: String::new(),
                    message: line.to_string(),
                }
            }
        })
        .collect())
}

/// 变更文件条目
#[derive(Debug, Clone)]
pub struct DiffStatEntry {
    pub status: char,
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

/// 获取相对于 target 的变更文件列表（带统计）
/// 执行: git diff --numstat --diff-filter=ACDMRT {target}
pub fn diff_stat(worktree_path: &str, target: &str) -> Result<Vec<DiffStatEntry>> {
    // intent-to-add 未跟踪文件，让 diff 能看到新文件
    let untracked = git_cmd(
        worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    )?;
    let has_untracked = !untracked.trim().is_empty();
    if has_untracked {
        let _ = git_cmd_unit(worktree_path, &["add", "--intent-to-add", "--all"]);
    }

    // 先获取 numstat（additions/deletions）
    let numstat = git_cmd(worktree_path, &["diff", "--numstat", target])?;
    // 再获取 name-status（状态字母）
    let name_status = git_cmd(worktree_path, &["diff", "--name-status", target])?;

    // 撤销 intent-to-add
    if has_untracked {
        for path in untracked.lines() {
            let path = path.trim();
            if !path.is_empty() {
                let _ = git_cmd_unit(worktree_path, &["reset", "HEAD", "--", path]);
            }
        }
    }

    let status_map: std::collections::HashMap<&str, char> = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                Some((parts[1], parts[0].chars().next().unwrap_or('M')))
            } else {
                None
            }
        })
        .collect();

    Ok(numstat
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let path = parts[2].to_string();
                let status = status_map.get(path.as_str()).copied().unwrap_or('M');
                DiffStatEntry {
                    status,
                    path,
                    additions: parts[0].parse().unwrap_or(0),
                    deletions: parts[1].parse().unwrap_or(0),
                }
            } else {
                DiffStatEntry {
                    status: '?',
                    path: line.to_string(),
                    additions: 0,
                    deletions: 0,
                }
            }
        })
        .collect())
}

/// 获取完整的 unified diff 输出（用于 diff review UI）
///
/// 包含所有变更：已提交 + 已暂存 + 未暂存 + 未跟踪文件，相对于 target branch。
/// 实现方式：先 `git add --intent-to-add` 未跟踪文件，执行 diff，再撤销 intent-to-add。
pub fn get_raw_diff(worktree_path: &str, target: &str) -> Result<String> {
    // 1. 找出未跟踪文件
    let untracked = git_cmd(
        worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    )?;
    let has_untracked = !untracked.trim().is_empty();

    // 2. 如果有未跟踪文件，用 intent-to-add 让 git diff 能看到它们
    if has_untracked {
        let _ = git_cmd_unit(worktree_path, &["add", "--intent-to-add", "--all"]);
    }

    // 3. 执行 diff
    let result = git_cmd(worktree_path, &["diff", "-U3", target]);

    // 4. 撤销 intent-to-add（恢复未跟踪状态）
    if has_untracked {
        // git reset 只影响 index，不影响工作区
        // 只 reset 那些是 intent-to-add 的文件（即之前 untracked 的）
        for path in untracked.lines() {
            let path = path.trim();
            if !path.is_empty() {
                let _ = git_cmd_unit(worktree_path, &["reset", "HEAD", "--", path]);
            }
        }
    }

    result
}

/// 获取指定 ref 的 tree hash
/// 执行: git rev-parse {ref}^{tree}
pub fn tree_hash(repo_path: &str, git_ref: &str) -> Result<String> {
    let spec = format!("{}^{{tree}}", git_ref);
    git_cmd(repo_path, &["rev-parse", &spec])
}

/// 获取指定范围的 unified diff
///
/// `to_ref=None` 表示 working tree（含 untracked），否则 commit 间 diff。
pub fn get_raw_diff_range(
    worktree_path: &str,
    from_ref: &str,
    to_ref: Option<&str>,
) -> Result<String> {
    match to_ref {
        Some(to) => {
            let range = format!("{}..{}", from_ref, to);
            git_cmd(worktree_path, &["diff", "-U3", &range])
        }
        None => get_raw_diff(worktree_path, from_ref),
    }
}

/// 获取未提交文件数量
/// 执行: git status --porcelain
pub fn uncommitted_count(path: &str) -> Result<usize> {
    git_cmd(path, &["status", "--porcelain"])
        .map(|output| output.lines().filter(|l| !l.trim().is_empty()).count())
}

/// 获取 stash 数量
pub fn stash_count(path: &str) -> Result<usize> {
    git_cmd(path, &["stash", "list"])
        .map(|output| output.lines().filter(|l| !l.trim().is_empty()).count())
}

pub fn add_and_commit(worktree_path: &str, message: &str) -> Result<()> {
    // 先 add
    git_cmd_unit(worktree_path, &["add", "-A"])?;

    // 检查是否有东西要提交
    if !has_uncommitted_changes(worktree_path).unwrap_or(false) {
        return Err(GroveError::git("Nothing to commit"));
    }

    // 再 commit
    git_cmd_unit(worktree_path, &["commit", "-m", message])
}

// ============================================================================
// AutoLink: 软链接管理
// ============================================================================

/// 检查路径是否被 git ignore
///
/// # Arguments
/// * `repo_path` - 仓库根目录
/// * `file_path` - 相对于仓库根目录的路径
///
/// # Returns
/// * `Ok(true)` - 路径被 gitignore
/// * `Ok(false)` - 路径被 git 追踪
/// * `Err(_)` - git 命令执行失败
#[allow(dead_code)]
pub fn is_gitignored(repo_path: &str, file_path: &str) -> Result<bool> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["check-ignore", "-q", file_path])
        .output()
        .map_err(|e| GroveError::git(format!("git check-ignore failed: {}", e)))?;

    // 退出码：0 = ignored, 1 = not ignored, 128 = error
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(GroveError::git(format!(
                "git check-ignore error: {}",
                stderr
            )))
        }
    }
}

/// 为 worktree 创建软链接
///
/// # Arguments
/// * `worktree_path` - 新创建的 worktree 路径
/// * `main_repo_path` - 主仓库路径
/// * `patterns` - Glob 模式列表（支持 **, *, ? 等）
/// * `check_gitignore` - 是否检查 git ignore 状态
///
/// # Returns
/// 成功创建的软链接路径列表（相对于主仓库根目录）
pub fn create_worktree_symlinks(
    worktree_path: &Path,
    main_repo_path: &Path,
    patterns: &[String],
    _check_gitignore: bool,
) -> Result<Vec<String>> {
    use globset::{Glob, GlobSetBuilder};
    use std::collections::HashSet;
    use std::process::Command;

    if patterns.is_empty() {
        return Ok(Vec::new());
    }

    // 1. 使用 git 命令获取所有被 ignore 的路径(极快!)
    let output = Command::new("git")
        .arg("ls-files")
        .arg("--others")
        .arg("--ignored")
        .arg("--exclude-standard")
        .arg("--directory")
        .current_dir(main_repo_path)
        .output()
        .map_err(|e| GroveError::git(format!("Failed to run git ls-files: {}", e)))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(GroveError::git(format!("git ls-files failed: {}", stderr)));
    }

    // 解析 git 输出,获取所有被 ignore 的路径
    let ignored_paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|s| s.trim_end_matches('/').to_string()) // 去除末尾的 /
        .filter(|s| !s.is_empty())
        .collect();

    // 2. 构建 globset 匹配器
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let glob = Glob::new(pattern).map_err(|e| {
            GroveError::config(format!("Invalid glob pattern '{}': {}", pattern, e))
        })?;
        builder.add(glob);
    }
    let globset = builder
        .build()
        .map_err(|e| GroveError::config(format!("Failed to build globset: {}", e)))?;

    // 3. 匹配路径并创建符号链接
    let mut created_links = Vec::new();
    let mut linked_paths: HashSet<String> = HashSet::new();

    for path_str in ignored_paths {
        // 检查是否匹配 glob
        if !globset.is_match(&path_str) {
            continue;
        }

        // 检查是否已经链接过
        if linked_paths.contains(&path_str) {
            continue;
        }

        // 检查是否是已链接路径的子项
        let is_under_linked = linked_paths.iter().any(|linked| {
            path_str.starts_with(linked.as_str())
                && path_str.len() > linked.len()
                && path_str.as_bytes().get(linked.len()) == Some(&b'/')
        });
        if is_under_linked {
            continue;
        }

        // 构建完整路径
        let source = main_repo_path.join(&path_str);
        let target = worktree_path.join(&path_str);

        // 跳过不存在的路径
        if !source.exists() {
            continue;
        }

        // 跳过已存在的目标路径
        if target.exists() || target.is_symlink() {
            continue;
        }

        // 创建父目录
        if let Some(parent) = target.parent() {
            if !parent.exists() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    eprintln!(
                        "Warning: Failed to create parent dir for '{}': {}",
                        path_str, e
                    );
                    continue;
                }
            }
        }

        // 创建符号链接
        let result = {
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&source, &target)
            }
            #[cfg(windows)]
            {
                let is_dir = source.is_dir();
                if is_dir {
                    std::os::windows::fs::symlink_dir(&source, &target)
                } else {
                    std::os::windows::fs::symlink_file(&source, &target)
                }
            }
        };

        match result {
            Ok(_) => {
                created_links.push(path_str.clone());
                linked_paths.insert(path_str);
            }
            Err(e) => {
                eprintln!(
                    "Warning: Failed to create symlink for '{}': {}",
                    path_str, e
                );
            }
        }
    }

    Ok(created_links)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_commit_message_with_notes() {
        let msg = build_commit_message("Add feature", Some("This is a note\nWith multiple lines"));
        assert_eq!(
            msg,
            "Add feature\n\n## Notes\n\nThis is a note\nWith multiple lines"
        );
    }

    #[test]
    fn test_build_commit_message_no_notes() {
        assert_eq!(build_commit_message("Add feature", None), "Add feature");
    }

    #[test]
    fn test_build_commit_message_empty_notes() {
        assert_eq!(build_commit_message("Add feature", Some("")), "Add feature");
        assert_eq!(
            build_commit_message("Add feature", Some("  \n  ")),
            "Add feature"
        );
    }

    #[test]
    fn test_build_commit_message_trims_notes() {
        let msg = build_commit_message("Title", Some("\n  content here  \n\n"));
        assert_eq!(msg, "Title\n\n## Notes\n\ncontent here");
    }
}
