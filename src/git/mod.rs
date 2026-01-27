use std::path::Path;
use std::process::{Command, Stdio};

pub mod cache;

// ============================================================================
// Git 命令执行助手函数
// ============================================================================

/// 执行 git 命令并返回 stdout (trim 后)
fn git_cmd(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!(
            "git {} failed: {}",
            args.first().unwrap_or(&""),
            stderr.trim()
        ))
    }
}

/// 执行 git 命令，仅返回成功/失败
fn git_cmd_unit(path: &str, args: &[&str]) -> Result<(), String> {
    git_cmd(path, args).map(|_| ())
}

/// 执行 git 命令，仅检查是否成功 (用于 bool 检查)
fn git_cmd_check(path: &str, args: &[&str]) -> bool {
    Command::new("git")
        .current_dir(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 解析 git diff --numstat 输出为 (additions, deletions)
fn parse_numstat(output: &str) -> (u32, u32) {
    output.lines().fold((0, 0), |(add, del), line| {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            let a = parts[0].parse::<u32>().unwrap_or(0);
            let d = parts[1].parse::<u32>().unwrap_or(0);
            (add + a, del + d)
        } else {
            (add, del)
        }
    })
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
) -> Result<(), String> {
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
pub fn current_branch(repo_path: &str) -> Result<String, String> {
    git_cmd(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"])
}

/// 获取仓库根目录
/// 执行: git rev-parse --show-toplevel
pub fn repo_root(path: &str) -> Result<String, String> {
    git_cmd(path, &["rev-parse", "--show-toplevel"])
}

/// 检查是否在 git 仓库中
pub fn is_git_repo(path: &str) -> bool {
    git_cmd_check(path, &["rev-parse", "--git-dir"])
}

/// 计算 branch 相对于 target 新增的 commit 数
/// 执行: git rev-list --count {target}..{branch}
pub fn commits_behind(worktree_path: &str, branch: &str, target: &str) -> Result<u32, String> {
    let range = format!("{}..{}", target, branch);
    git_cmd(worktree_path, &["rev-list", "--count", &range])?
        .parse::<u32>()
        .map_err(|e| format!("Failed to parse count: {}", e))
}

/// 获取文件变更统计 (相对于 target)
/// 执行: git diff --numstat {target}
/// 返回: (additions, deletions)
pub fn file_changes(worktree_path: &str, target: &str) -> Result<(u32, u32), String> {
    git_cmd(worktree_path, &["diff", "--numstat", target]).map(|output| parse_numstat(&output))
}

/// 删除 worktree（保留 branch）
/// 执行: git worktree remove {path} --force
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    git_cmd_unit(repo_path, &["worktree", "remove", worktree_path, "--force"])
}

/// 从现有分支创建 worktree（不创建新分支）
/// 执行: git worktree add {path} {branch}
pub fn create_worktree_from_branch(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
) -> Result<(), String> {
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
pub fn delete_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    git_cmd_unit(repo_path, &["branch", "-D", branch])
}

/// 检查分支是否存在
pub fn branch_exists(repo_path: &str, branch: &str) -> bool {
    git_cmd_check(repo_path, &["rev-parse", "--verify", branch])
}

/// 列出所有本地分支
pub fn list_branches(repo_path: &str) -> Result<Vec<String>, String> {
    git_cmd(repo_path, &["branch", "--format=%(refname:short)"]).map(|output| {
        output
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    })
}

/// 检查分支是否已合并到 target
/// 使用 git merge-base --is-ancestor 检查
pub fn is_merged(repo_path: &str, branch: &str, target: &str) -> Result<bool, String> {
    // exit code 0 = is ancestor (merged), non-zero = not merged
    Ok(git_cmd_check(
        repo_path,
        &["merge-base", "--is-ancestor", branch, target],
    ))
}

/// 检查是否有未提交的改动
/// 执行: git status --porcelain
pub fn has_uncommitted_changes(path: &str) -> Result<bool, String> {
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
pub fn rebase(worktree_path: &str, target: &str) -> Result<(), String> {
    git_cmd_unit(worktree_path, &["rebase", target])
}

/// 执行 squash merge
/// 执行: git merge --squash {branch}
pub fn merge_squash(repo_path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["merge", "--squash", branch])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format_merge_error(&stdout, &stderr))
    }
}

/// 执行 merge commit（保留历史）
/// 执行: git merge --no-ff {branch} -m {message}
pub fn merge_no_ff(repo_path: &str, branch: &str, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["merge", "--no-ff", branch, "-m", message])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        Err(format_merge_error(&stdout, &stderr))
    }
}

/// 格式化 merge 错误信息
fn format_merge_error(stdout: &str, stderr: &str) -> String {
    // 检查是否有冲突
    let combined = format!("{}\n{}", stdout, stderr);
    if combined.contains("CONFLICT") || combined.contains("conflict") {
        // 提取冲突文件
        let conflicts: Vec<&str> = combined
            .lines()
            .filter(|line| line.contains("CONFLICT"))
            .collect();

        if conflicts.is_empty() {
            "Merge conflict - resolve manually".to_string()
        } else if conflicts.len() == 1 {
            conflicts[0].trim().to_string()
        } else {
            format!("{} conflicts - resolve manually", conflicts.len())
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
pub fn reset_merge(repo_path: &str) -> Result<(), String> {
    git_cmd_unit(repo_path, &["reset", "--merge"])
}

/// 提交（用于 squash merge 后）
/// 执行: git commit -m {message}
pub fn commit(repo_path: &str, message: &str) -> Result<(), String> {
    git_cmd_unit(repo_path, &["commit", "-m", message])
}

/// 获取相对于 origin 的 commits ahead 数量
/// 执行: git rev-list --count origin/{branch}..HEAD
pub fn commits_ahead_of_origin(repo_path: &str) -> Result<Option<u32>, String> {
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
pub fn last_commit_time(repo_path: &str) -> Result<String, String> {
    git_cmd(repo_path, &["log", "-1", "--format=%cr"]).or_else(|_| Ok("unknown".to_string()))
}

/// 获取相对于 origin 的文件变更统计
/// 执行: git diff --numstat origin/{branch}
pub fn changes_from_origin(repo_path: &str) -> Result<(u32, u32), String> {
    let branch = current_branch(repo_path)?;
    let origin_ref = format!("origin/{}", branch);

    // 检查 origin/{branch} 是否存在
    if !git_cmd_check(repo_path, &["rev-parse", "--verify", &origin_ref]) {
        return Ok((0, 0));
    }

    git_cmd(repo_path, &["diff", "--numstat", &origin_ref])
        .map(|output| parse_numstat(&output))
        .or(Ok((0, 0)))
}

/// 切换分支
/// 执行: git checkout {branch}
pub fn checkout_branch(worktree_path: &str, branch: &str) -> Result<(), String> {
    git_cmd_unit(worktree_path, &["checkout", branch])
}

/// 添加所有文件并提交
/// 执行: git add -A && git commit -m {message}
/// Commit log entry
#[derive(Debug, Clone)]
pub struct LogEntry {
    pub time_ago: String,
    pub message: String,
}

/// 获取最近的 commit 日志
/// 执行: git log --oneline --format="%cr\t%s" -n {count} {target}..HEAD
pub fn recent_log(
    worktree_path: &str,
    target: &str,
    count: usize,
) -> Result<Vec<LogEntry>, String> {
    let range = format!("{}..HEAD", target);
    let n = format!("-{}", count);
    let output = git_cmd(worktree_path, &["log", "--format=%cr\t%s", &n, &range])?;
    Ok(output
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.splitn(2, '\t').collect();
            if parts.len() == 2 {
                LogEntry {
                    time_ago: parts[0].to_string(),
                    message: parts[1].to_string(),
                }
            } else {
                LogEntry {
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
pub fn diff_stat(worktree_path: &str, target: &str) -> Result<Vec<DiffStatEntry>, String> {
    // 先获取 numstat（additions/deletions）
    let numstat = git_cmd(worktree_path, &["diff", "--numstat", target])?;
    // 再获取 name-status（状态字母）
    let name_status = git_cmd(worktree_path, &["diff", "--name-status", target])?;

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

/// 获取未提交文件数量
/// 执行: git status --porcelain
pub fn uncommitted_count(path: &str) -> Result<usize, String> {
    git_cmd(path, &["status", "--porcelain"])
        .map(|output| output.lines().filter(|l| !l.trim().is_empty()).count())
}

/// 获取 stash 数量
pub fn stash_count(path: &str) -> Result<usize, String> {
    git_cmd(path, &["stash", "list"])
        .map(|output| output.lines().filter(|l| !l.trim().is_empty()).count())
}

pub fn add_and_commit(worktree_path: &str, message: &str) -> Result<(), String> {
    // 先 add
    git_cmd_unit(worktree_path, &["add", "-A"])?;

    // 检查是否有东西要提交
    if !has_uncommitted_changes(worktree_path).unwrap_or(false) {
        return Err("Nothing to commit".to_string());
    }

    // 再 commit
    git_cmd_unit(worktree_path, &["commit", "-m", message])
}
