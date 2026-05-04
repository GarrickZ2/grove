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

/// 执行 git 命令，允许 exit code 1（如 `git diff --no-index` 在文件不同时返回 1）
pub(crate) fn git_cmd_allow_exit1(path: &str, args: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| GroveError::git(format!("Failed to execute git: {}", e)))?;

    if output.status.success() || output.status.code() == Some(1) {
        String::from_utf8(output.stdout)
            .map(|s| s.trim().to_string())
            .map_err(|e| GroveError::git(format!("UTF-8 error: {}", e)))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(GroveError::git(format!(
            "git {} failed: {}",
            args.join(" "),
            stderr.trim()
        )))
    }
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

/// gix 版当前分支名(in-process,无 fork)。
/// detached HEAD 时返回 None。
pub fn gix_current_branch(repo: &gix::Repository) -> Option<String> {
    let name = repo.head_name().ok().flatten()?;
    let short = name.shorten().to_string();
    Some(short)
}

/// gix 版「是否配了 origin remote」(in-process,无 fork)。
pub fn gix_has_origin(repo: &gix::Repository) -> bool {
    repo.find_remote("origin").is_ok()
}

/// gix 版 stash 数量(读 refs/stash 的 reflog 条目数)。
/// 没有 stash ref 时返回 0。
pub fn gix_stash_count(repo: &gix::Repository) -> usize {
    let Ok(reference) = repo.find_reference("refs/stash") else {
        return 0;
    };
    match reference.log_iter().all() {
        Ok(Some(iter)) => iter.filter_map(|r| r.ok()).count(),
        _ => 0,
    }
}

/// gix log walk 的单条记录。
///
/// 比 `git log --format=...` 多带 `tree_id` —— 调用方可直接用它做 tree
/// 对比(例如 `skip_versions` 检测),避免每个 commit 再发一次 `rev-parse`。
#[derive(Debug, Clone)]
pub struct GixLogEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub time_ago: String,
    pub committer_time: i64,
    pub tree_id: String,
}

fn extract_log_entry(commit: &gix::Commit<'_>) -> Option<GixLogEntry> {
    let hash = commit.id().to_hex().to_string();
    let message = {
        let raw = commit.message_raw_sloppy();
        let bytes: &[u8] = raw.as_ref();
        let line_end = bytes
            .iter()
            .position(|&b| b == b'\n')
            .unwrap_or(bytes.len());
        String::from_utf8_lossy(&bytes[..line_end]).into_owned()
    };
    let author = commit
        .author()
        .ok()
        .map(|sig| sig.name.to_string())
        .unwrap_or_default();
    let committer_time = commit
        .committer()
        .ok()
        .map(|sig| sig.time.seconds)
        .unwrap_or(0);
    let tree_id = commit.tree_id().ok()?.to_hex().to_string();
    let time_ago = chrono::DateTime::<chrono::Utc>::from_timestamp(committer_time, 0)
        .map(crate::model::format_relative_time)
        .unwrap_or_default();
    Some(GixLogEntry {
        hash,
        message,
        author,
        time_ago,
        committer_time,
        tree_id,
    })
}

/// gix 版 `git log -<count> [--since=<seconds>]`(in-process,无 fork)。
///
/// `min_committer_time`: 仅保留 committer_time >= 该值的 commit;`None` 不过滤。
pub fn gix_recent_log(
    repo: &gix::Repository,
    count: usize,
    min_committer_time: Option<i64>,
) -> Result<Vec<GixLogEntry>> {
    let head_id = repo
        .head_id()
        .map_err(|e| GroveError::git(format!("HEAD not found: {}", e)))?;
    let walk = repo
        .rev_walk([head_id])
        .use_commit_graph(true)
        .all()
        .map_err(|e| GroveError::git(format!("rev_walk failed: {}", e)))?;

    let mut out = Vec::with_capacity(count);
    for info in walk {
        if out.len() >= count {
            break;
        }
        let Ok(info) = info else { continue };

        // Fast path: when commit-graph is in use, `info.commit_time` is set
        // without decoding the commit object. rev_walk yields newest-first,
        // so the first commit older than the cutoff means we're done.
        if let Some(min_t) = min_committer_time {
            if let Some(t) = info.commit_time {
                if t < min_t {
                    break;
                }
            }
        }

        let Ok(object) = repo.find_object(info.id) else {
            continue;
        };
        let Ok(commit) = object.try_into_commit() else {
            continue;
        };
        let Some(entry) = extract_log_entry(&commit) else {
            continue;
        };
        // Belt-and-suspenders: when there's no commit-graph, info.commit_time
        // is None, so we still need this post-decode filter.
        if let Some(min_t) = min_committer_time {
            if entry.committer_time < min_t {
                break;
            }
        }
        out.push(entry);
    }
    Ok(out)
}

/// gix 版 `git log <target>..HEAD -<count>`(in-process,无 fork)。
///
/// 等价于 `git log target..HEAD` = `HEAD ^target`:排除 target 自身及其全部
/// 祖先。先用一次有界的祖先遍历建立排除集,再从 HEAD 走 commit-time 顺序。
pub fn gix_log_target_to_head(
    repo: &gix::Repository,
    target: &str,
    count: usize,
) -> Result<Vec<GixLogEntry>> {
    use gix::bstr::BStr;
    use std::collections::HashSet;

    let head_id = repo
        .head_id()
        .map_err(|e| GroveError::git(format!("HEAD not found: {}", e)))?;
    let target_id = repo
        .rev_parse_single(BStr::new(target.as_bytes()))
        .map_err(|e| GroveError::git(format!("target ref {} not found: {}", target, e)))?
        .detach();

    // Build the exclusion set: target plus its ancestors. Bounded to keep this
    // cheap on huge histories — past the cap we may include a few extra commits
    // that git would have excluded, which is preferable to walking forever.
    const ANCESTOR_CAP: usize = 20_000;
    let mut excluded: HashSet<gix::ObjectId> = HashSet::new();
    excluded.insert(target_id);
    if let Ok(target_walk) = repo.rev_walk([target_id]).use_commit_graph(true).all() {
        for (i, info) in target_walk.enumerate() {
            if i >= ANCESTOR_CAP {
                break;
            }
            if let Ok(info) = info {
                excluded.insert(info.id);
            }
        }
    }

    let excluded_for_filter = excluded.clone();
    let walk = repo
        .rev_walk([head_id])
        .use_commit_graph(true)
        .selected(move |oid| !excluded_for_filter.contains(oid))
        .map_err(|e| GroveError::git(format!("rev_walk failed: {}", e)))?;

    // Hard cap on iterations to prevent runaway when `selected` filter doesn't
    // prune (e.g. excluded commits' parents are still visited then filtered).
    let iter_cap = count.saturating_mul(20).max(2_000);
    let mut out = Vec::with_capacity(count);
    for (i, info) in walk.enumerate() {
        if out.len() >= count || i >= iter_cap {
            break;
        }
        let Ok(info) = info else { continue };
        if excluded.contains(&info.id) {
            continue;
        }
        let Ok(object) = repo.find_object(info.id) else {
            continue;
        };
        let Ok(commit) = object.try_into_commit() else {
            continue;
        };
        if let Some(entry) = extract_log_entry(&commit) {
            out.push(entry);
        }
    }
    Ok(out)
}

/// 获取仓库的 default branch（main/master 等）
/// 优先从 origin/HEAD 推断，fallback 检查 main/master 是否存在
pub fn default_branch(repo_path: &str) -> String {
    // Try origin/HEAD (most reliable when remote exists)
    if let Ok(ref_output) = git_cmd(repo_path, &["symbolic-ref", "refs/remotes/origin/HEAD"]) {
        // "refs/remotes/origin/main" → "main"
        if let Some(branch) = ref_output.strip_prefix("refs/remotes/origin/") {
            return branch.to_string();
        }
    }

    // Fallback: check if "main" or "master" branch exists locally
    if git_cmd_check(repo_path, &["rev-parse", "--verify", "refs/heads/main"]) {
        return "main".to_string();
    }
    if git_cmd_check(repo_path, &["rev-parse", "--verify", "refs/heads/master"]) {
        return "master".to_string();
    }

    // Last resort: use current branch
    current_branch(repo_path).unwrap_or_else(|_| "main".to_string())
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

/// 检查 git 状态是否可用(是 git 仓库且至少有一个 commit)。
///
/// 用 `gix` 进程内实现,不 fork git 子进程:
/// - `gix::open` 成功 → 是 git 仓库 (worktree/submodule 也认)
/// - `head_id()` 成功 → HEAD 解析得到一个 commit (空 repo 这里会失败)
pub fn is_git_usable(path: &str) -> bool {
    match gix::open(path) {
        Ok(repo) => repo.head_id().is_ok(),
        Err(_) => false,
    }
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
/// 复用 diff_stat，保证和 diff API 的计算逻辑完全一致
/// 返回: (additions, deletions, files_changed)
#[allow(dead_code)]
pub fn file_changes(worktree_path: &str, target: &str) -> Result<(u32, u32, u32)> {
    let entries = diff_stat(worktree_path, target)?;
    let additions = entries.iter().map(|e| e.additions).sum();
    let deletions = entries.iter().map(|e| e.deletions).sum();
    let files_changed = entries.len() as u32;
    Ok((additions, deletions, files_changed))
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

/// 检查 branch 和 target 之间是否没有代码差异（用于检测 squash merge）
/// 执行: git diff --quiet branch target
pub fn is_diff_empty(repo_path: &str, branch: &str, target: &str) -> Result<bool> {
    Ok(git_cmd_check(
        repo_path,
        &["diff", "--quiet", branch, target],
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
    Ok(output.lines().map(git_unquote).collect())
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
/// Unquote a git-quoted path.
/// Git wraps paths containing non-ASCII chars in double quotes with octal escapes,
/// e.g. `"docs/\344\276\233\347\273\231.md"` → `docs/供给.md`
pub(crate) fn git_unquote(s: &str) -> String {
    if !(s.starts_with('"') && s.ends_with('"')) {
        return s.to_string();
    }
    let inner = &s[1..s.len() - 1];
    let mut bytes: Vec<u8> = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some(d @ '0'..='3') => {
                    // Octal escape: \NNN (3 digits)
                    let mut val = d as u8 - b'0';
                    for _ in 0..2 {
                        if let Some(od @ '0'..='7') = chars.next() {
                            val = val * 8 + (od as u8 - b'0');
                        }
                    }
                    bytes.push(val);
                }
                Some('\\') => bytes.push(b'\\'),
                Some('n') => bytes.push(b'\n'),
                Some('t') => bytes.push(b'\t'),
                Some('"') => bytes.push(b'"'),
                Some(other) => {
                    bytes.push(b'\\');
                    let mut buf = [0u8; 4];
                    bytes.extend_from_slice(other.encode_utf8(&mut buf).as_bytes());
                }
                None => bytes.push(b'\\'),
            }
        } else {
            let mut buf = [0u8; 4];
            bytes.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
        }
    }
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).to_string())
}

pub fn list_files(repo_path: &str) -> Result<Vec<String>> {
    // List tracked files
    let tracked = git_cmd(repo_path, &["ls-files"])?;

    // List untracked files (excluding ignored files)
    let untracked =
        git_cmd(repo_path, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();

    // Combine and deduplicate, unquoting git's octal-escaped paths
    let mut all_files: Vec<String> = tracked
        .lines()
        .chain(untracked.lines())
        .map(git_unquote)
        .collect();

    // Remove duplicates (shouldn't happen, but just in case)
    all_files.sort();
    all_files.dedup();

    Ok(all_files)
}

/// 读取指定 git ref 上的文件内容
///
/// 执行: `git show {ref}:{file_path}`
pub fn show_file(repo_path: &str, git_ref: &str, file_path: &str) -> Result<String> {
    let object = format!("{}:{}", git_ref, file_path);
    git_cmd(repo_path, &["show", &object])
}

/// 纯逻辑判断路径是否在基础目录内（不解析符号链接）
///
/// 遍历 `path` 相对于 `base` 的各组件，遇到 `..` 时深度 -1，
/// 遇到正常组件时深度 +1。深度一旦 < 0 即判定为路径逃逸。
fn logical_path_within(path: &Path, base: &Path) -> bool {
    use std::path::Component;

    let suffix = match path.strip_prefix(base) {
        Ok(s) => s,
        Err(_) => return false,
    };

    let mut depth: i32 = 0;
    for component in suffix.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            Component::Normal(_) => {
                depth += 1;
            }
            // CurDir (`.`) 不影响深度
            _ => {}
        }
    }
    true
}

/// 读取 worktree 中的文件内容
/// 包含路径穿越保护，支持 autolink 符号链接
pub fn read_file(repo_path: &str, file_path: &str) -> Result<String> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid repo path: {}", e)))?;
    let logical = base.join(file_path);

    // 逻辑路径检查（不解析符号链接，阻止 .. 逃逸）
    if !logical_path_within(&logical, &base) {
        return Err(GroveError::git("Path traversal detected"));
    }

    let full = logical
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid file path: {}", e)))?;

    // 快速路径：解析后仍在 worktree 内
    if full.starts_with(&base) {
        return std::fs::read_to_string(&full)
            .map_err(|e| GroveError::git(format!("Failed to read file: {}", e)));
    }

    // Fallback：autolink 符号链接可能指向主仓库
    if let Ok(main_repo) = get_main_repo_path(repo_path) {
        let main_base = Path::new(&main_repo)
            .canonicalize()
            .map_err(|e| GroveError::git(format!("Invalid main repo path: {}", e)))?;
        if full.starts_with(&main_base) {
            return std::fs::read_to_string(&full)
                .map_err(|e| GroveError::git(format!("Failed to read file: {}", e)));
        }
    }

    Err(GroveError::git("Path traversal detected"))
}

/// 写入 worktree 中的文件
/// 包含路径穿越保护，支持 autolink 符号链接
pub fn write_file(repo_path: &str, file_path: &str, content: &str) -> Result<()> {
    let base = Path::new(repo_path)
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid repo path: {}", e)))?;
    let logical = base.join(file_path);

    // 逻辑路径检查（不解析符号链接，阻止 .. 逃逸）
    if !logical_path_within(&logical, &base) {
        return Err(GroveError::git("Path traversal detected"));
    }

    // For write, the file might not exist yet, so canonicalize the parent
    let parent = logical
        .parent()
        .ok_or_else(|| GroveError::git("Invalid file path"))?;
    let parent_canonical = parent
        .canonicalize()
        .map_err(|e| GroveError::git(format!("Invalid parent path: {}", e)))?;
    let file_name = logical
        .file_name()
        .ok_or_else(|| GroveError::git("Invalid file name"))?;
    let final_path = parent_canonical.join(file_name);

    // 快速路径：父目录在 worktree 内
    if parent_canonical.starts_with(&base) {
        return std::fs::write(&final_path, content)
            .map_err(|e| GroveError::git(format!("Failed to write file: {}", e)));
    }

    // Fallback：autolink 符号链接可能指向主仓库
    if let Ok(main_repo) = get_main_repo_path(repo_path) {
        let main_base = Path::new(&main_repo)
            .canonicalize()
            .map_err(|e| GroveError::git(format!("Invalid main repo path: {}", e)))?;
        if parent_canonical.starts_with(&main_base) {
            return std::fs::write(&final_path, content)
                .map_err(|e| GroveError::git(format!("Failed to write file: {}", e)));
        }
    }

    Err(GroveError::git("Path traversal detected"))
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
    pub time_ago: String,
    pub message: String,
}

/// 获取最近的 commit 日志
/// 执行: git log --format="%cr\t%s" -n {count} {target}..HEAD
pub fn recent_log(worktree_path: &str, target: &str, count: usize) -> Result<Vec<LogEntry>> {
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
    pub is_binary: bool,
}

pub fn diff_stat(worktree_path: &str, target: &str) -> Result<Vec<DiffStatEntry>> {
    let untracked = git_cmd(
        worktree_path,
        &["ls-files", "--others", "--exclude-standard"],
    )?;
    let untracked_set: std::collections::HashSet<String> = untracked
        .lines()
        .map(|l| git_unquote(l.trim()))
        .filter(|p| !p.is_empty())
        .collect();

    let numstat_res = git_cmd(worktree_path, &["diff", "--numstat", target]);
    let name_status_res = git_cmd(worktree_path, &["diff", "--name-status", target]);
    let numstat = numstat_res?;
    let name_status = name_status_res?;

    let status_map: std::collections::HashMap<String, char> = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                Some((
                    git_unquote(parts[1]),
                    parts[0].chars().next().unwrap_or('M'),
                ))
            } else {
                None
            }
        })
        .collect();

    let mut entries: Vec<DiffStatEntry> = numstat
        .lines()
        .filter(|l| !l.is_empty())
        .map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let path = git_unquote(parts[2]);
                let is_binary = parts[0].trim() == "-";
                let status = status_map.get(&path).copied().unwrap_or('M');
                DiffStatEntry {
                    status,
                    path,
                    additions: if is_binary {
                        0
                    } else {
                        parts[0].parse().unwrap_or(0)
                    },
                    deletions: if is_binary {
                        0
                    } else {
                        parts[1].parse().unwrap_or(0)
                    },
                    is_binary,
                }
            } else {
                DiffStatEntry {
                    status: '?',
                    path: line.to_string(),
                    additions: 0,
                    deletions: 0,
                    is_binary: false,
                }
            }
        })
        .collect();

    for path in &untracked_set {
        let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
        let output = git_cmd_allow_exit1(
            worktree_path,
            &["diff", "--no-index", "--numstat", "--", null_device, path],
        );
        if let Ok(numstat_out) = output {
            let parts: Vec<&str> = numstat_out.trim().split('\t').collect();
            if parts.len() >= 2 {
                let is_binary = parts[0].trim() == "-";
                entries.push(DiffStatEntry {
                    status: 'U',
                    path: path.clone(),
                    additions: if is_binary {
                        0
                    } else {
                        parts[0].parse().unwrap_or(0)
                    },
                    deletions: if is_binary {
                        0
                    } else {
                        parts[1].parse().unwrap_or(0)
                    },
                    is_binary,
                });
            }
        } else {
            entries.push(DiffStatEntry {
                status: 'U',
                path: path.clone(),
                additions: 0,
                deletions: 0,
                is_binary: false,
            });
        }
    }

    Ok(entries)
}

/// 获取两个 ref 之间的变更文件统计（不含 working tree）
pub fn diff_stat_range(
    worktree_path: &str,
    from_ref: &str,
    to_ref: &str,
) -> Result<Vec<DiffStatEntry>> {
    let range = format!("{}..{}", from_ref, to_ref);
    let numstat = git_cmd(worktree_path, &["diff", "--numstat", &range])?;
    let name_status = git_cmd(worktree_path, &["diff", "--name-status", &range])?;

    let status_map: std::collections::HashMap<String, char> = name_status
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                Some((
                    git_unquote(parts[1]),
                    parts[0].chars().next().unwrap_or('M'),
                ))
            } else {
                None
            }
        })
        .collect();

    Ok(numstat
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 3 {
                let path = git_unquote(parts[2]);
                let is_binary = parts[0].trim() == "-";
                let status = status_map.get(&path).copied().unwrap_or('M');
                Some(DiffStatEntry {
                    status,
                    path,
                    additions: if is_binary {
                        0
                    } else {
                        parts[0].parse().unwrap_or(0)
                    },
                    deletions: if is_binary {
                        0
                    } else {
                        parts[1].parse().unwrap_or(0)
                    },
                    is_binary,
                })
            } else {
                None
            }
        })
        .collect())
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
        .map(|s| git_unquote(s.trim_end_matches('/'))) // 去除末尾的 / 并解码转义路径
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
        let result = crate::fs_link::create_link(&source, &target);

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

    // 将符号链接写入 worktree 的 git exclude，防止被 git 追踪
    if !created_links.is_empty() {
        if let Err(e) = add_to_worktree_exclude(worktree_path, &created_links) {
            eprintln!("Warning: Failed to update git exclude: {}", e);
        }
    }

    Ok(created_links)
}

/// 将 autolink 创建的符号链接路径写入共享的 git exclude 文件
///
/// 写入 `<git-common-dir>/info/exclude`，该文件不会被提交。
/// 必须使用 `--git-common-dir` 而非 `--git-dir`，因为 git 只从
/// common dir 读取 `info/exclude`，per-worktree 的 `info/exclude` 不生效。
/// 路径不带尾斜线，这样同时匹配文件和目录（即符号链接）。
fn add_to_worktree_exclude(worktree_path: &Path, paths: &[String]) -> Result<()> {
    use std::io::Write;

    if paths.is_empty() {
        return Ok(());
    }

    let wt_str = worktree_path.to_str().unwrap_or_default();

    // git-common-dir 指向主仓库的 .git 目录（所有 worktree 共享）
    // git 只从 common dir 的 info/exclude 读取排除规则
    let git_dir = git_cmd(wt_str, &["rev-parse", "--git-common-dir"])?;
    let git_dir_path = if Path::new(&git_dir).is_absolute() {
        std::path::PathBuf::from(&git_dir)
    } else {
        worktree_path.join(&git_dir)
    };

    let info_dir = git_dir_path.join("info");
    if !info_dir.exists() {
        std::fs::create_dir_all(&info_dir)
            .map_err(|e| GroveError::git(format!("Failed to create info dir: {}", e)))?;
    }

    let exclude_path = info_dir.join("exclude");

    // 读取已有内容，用于去重
    let existing = std::fs::read_to_string(&exclude_path).unwrap_or_default();
    let existing_lines: std::collections::HashSet<&str> = existing.lines().collect();

    // 筛选出需要新增的路径
    let new_entries: Vec<&String> = paths
        .iter()
        .filter(|p| !existing_lines.contains(p.as_str()))
        .collect();

    if new_entries.is_empty() {
        return Ok(());
    }

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&exclude_path)
        .map_err(|e| GroveError::git(format!("Failed to open exclude file: {}", e)))?;

    // 如果文件非空且不以换行结尾，先写一个换行
    if !existing.is_empty() && !existing.ends_with('\n') {
        writeln!(file).map_err(|e| GroveError::git(format!("Failed to write exclude: {}", e)))?;
    }

    // 写入标记注释（仅当之前没有时）
    let marker = "# Grove AutoLink excludes";
    if !existing.contains(marker) {
        writeln!(file, "{}", marker)
            .map_err(|e| GroveError::git(format!("Failed to write exclude: {}", e)))?;
    }

    for path in &new_entries {
        writeln!(file, "{}", path)
            .map_err(|e| GroveError::git(format!("Failed to write exclude: {}", e)))?;
    }

    Ok(())
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

    #[test]
    fn test_git_unquote_plain() {
        assert_eq!(git_unquote("README.md"), "README.md");
    }

    #[test]
    fn test_git_unquote_chinese() {
        // "docs/01-\344\276\233\347\273\231.md" → "docs/01-供给.md"
        assert_eq!(
            git_unquote(r#""docs/01-\344\276\233\347\273\231.md""#),
            "docs/01-供给.md"
        );
    }

    #[test]
    fn test_git_unquote_mixed() {
        // "03-Proxy\345\261\202\350\256\276\350\256\241.md" → "03-Proxy层设计.md"
        assert_eq!(
            git_unquote(r#""03-Proxy\345\261\202\350\256\276\350\256\241.md""#),
            "03-Proxy层设计.md"
        );
    }
}
