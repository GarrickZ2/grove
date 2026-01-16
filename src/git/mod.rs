use std::path::Path;
use std::process::Command;

/// 创建 git worktree
/// 执行: git worktree add -b {branch} {path} {base}
pub fn create_worktree(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
    base_branch: &str,
) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args([
            "worktree",
            "add",
            "-b",
            branch,
            worktree_path.to_str().unwrap_or_default(),
            base_branch,
        ])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree add failed: {}", stderr.trim()))
    }
}

/// 获取当前分支名
/// 执行: git rev-parse --abbrev-ref HEAD
pub fn current_branch(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout);
        Ok(branch.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rev-parse failed: {}", stderr.trim()))
    }
}

/// 获取仓库根目录
/// 执行: git rev-parse --show-toplevel
pub fn repo_root(path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let root = String::from_utf8_lossy(&output.stdout);
        Ok(root.trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rev-parse failed: {}", stderr.trim()))
    }
}

/// 检查是否在 git 仓库中
pub fn is_git_repo(path: &str) -> bool {
    Command::new("git")
        .current_dir(path)
        .args(["rev-parse", "--git-dir"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 计算 branch 相对于 target 新增的 commit 数
/// 执行: git rev-list --count {target}..{branch}
pub fn commits_behind(worktree_path: &str, branch: &str, target: &str) -> Result<u32, String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["rev-list", "--count", &format!("{}..{}", target, branch)])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let count_str = String::from_utf8_lossy(&output.stdout);
        count_str
            .trim()
            .parse::<u32>()
            .map_err(|e| format!("Failed to parse count: {}", e))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rev-list failed: {}", stderr.trim()))
    }
}

/// 获取文件变更统计 (相对于 target)
/// 执行: git diff --numstat {target}
/// 返回: (additions, deletions)
pub fn file_changes(worktree_path: &str, target: &str) -> Result<(u32, u32), String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["diff", "--numstat", target])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut additions = 0u32;
        let mut deletions = 0u32;

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                // 处理二进制文件 (显示为 "-")
                if let Ok(add) = parts[0].parse::<u32>() {
                    additions += add;
                }
                if let Ok(del) = parts[1].parse::<u32>() {
                    deletions += del;
                }
            }
        }

        Ok((additions, deletions))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git diff failed: {}", stderr.trim()))
    }
}

/// 删除 worktree（保留 branch）
/// 执行: git worktree remove {path} --force
pub fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["worktree", "remove", worktree_path, "--force"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree remove failed: {}", stderr.trim()))
    }
}

/// 从现有分支创建 worktree（不创建新分支）
/// 执行: git worktree add {path} {branch}
pub fn create_worktree_from_branch(
    repo_path: &str,
    branch: &str,
    worktree_path: &Path,
) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args([
            "worktree",
            "add",
            worktree_path.to_str().unwrap_or_default(),
            branch,
        ])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git worktree add failed: {}", stderr.trim()))
    }
}

/// 删除分支
/// 执行: git branch -D {branch}
pub fn delete_branch(repo_path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["branch", "-D", branch])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git branch -D failed: {}", stderr.trim()))
    }
}

/// 检查分支是否存在
pub fn branch_exists(repo_path: &str, branch: &str) -> bool {
    Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", branch])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 列出所有本地分支
pub fn list_branches(repo_path: &str) -> Result<Vec<String>, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["branch", "--format=%(refname:short)"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let branches: Vec<String> = stdout
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Ok(branches)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git branch failed: {}", stderr.trim()))
    }
}

/// 检查分支是否已合并到 target
/// 使用 git merge-base --is-ancestor 检查
pub fn is_merged(repo_path: &str, branch: &str, target: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["merge-base", "--is-ancestor", branch, target])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    // exit code 0 = is ancestor (merged), non-zero = not merged
    Ok(output.status.success())
}

/// 检查是否有未提交的改动
/// 执行: git status --porcelain
pub fn has_uncommitted_changes(path: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .current_dir(path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(!stdout.trim().is_empty())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git status failed: {}", stderr.trim()))
    }
}

/// 执行 rebase
/// 执行: git rebase {target}
pub fn rebase(worktree_path: &str, target: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["rebase", target])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git rebase failed: {}", stderr.trim()))
    }
}

/// 执行 squash merge
/// 执行: git merge --squash {branch}
pub fn merge_squash(repo_path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["merge", "--squash", branch])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git merge --squash failed: {}", stderr.trim()))
    }
}

/// 执行 merge commit（保留历史）
/// 执行: git merge --no-ff {branch} -m {message}
pub fn merge_no_ff(repo_path: &str, branch: &str, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["merge", "--no-ff", branch, "-m", message])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git merge --no-ff failed: {}", stderr.trim()))
    }
}

/// 提交（用于 squash merge 后）
/// 执行: git commit -m {message}
pub fn commit(repo_path: &str, message: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git commit failed: {}", stderr.trim()))
    }
}

/// 获取相对于 origin 的 commits ahead 数量
/// 执行: git rev-list --count origin/{branch}..HEAD
pub fn commits_ahead_of_origin(repo_path: &str) -> Result<Option<u32>, String> {
    // 先获取当前分支
    let branch = current_branch(repo_path)?;

    // 检查 origin/{branch} 是否存在
    let check = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", &format!("origin/{}", branch)])
        .output();

    if check.map(|o| !o.status.success()).unwrap_or(true) {
        // origin 分支不存在，返回 None
        return Ok(None);
    }

    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-list", "--count", &format!("origin/{}..HEAD", branch)])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let count_str = String::from_utf8_lossy(&output.stdout);
        count_str
            .trim()
            .parse::<u32>()
            .map(Some)
            .map_err(|e| format!("Failed to parse count: {}", e))
    } else {
        Ok(None)
    }
}

/// 获取最近提交的相对时间
/// 执行: git log -1 --format=%cr
pub fn last_commit_time(repo_path: &str) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["log", "-1", "--format=%cr"])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let time = String::from_utf8_lossy(&output.stdout);
        Ok(time.trim().to_string())
    } else {
        Ok("unknown".to_string())
    }
}

/// 获取相对于 origin 的文件变更统计
/// 执行: git diff --numstat origin/{branch}
pub fn changes_from_origin(repo_path: &str) -> Result<(u32, u32), String> {
    // 先获取当前分支
    let branch = current_branch(repo_path)?;

    // 检查 origin/{branch} 是否存在
    let check = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", &format!("origin/{}", branch)])
        .output();

    if check.map(|o| !o.status.success()).unwrap_or(true) {
        // origin 分支不存在，返回 0
        return Ok((0, 0));
    }

    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["diff", "--numstat", &format!("origin/{}", branch)])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut additions = 0u32;
        let mut deletions = 0u32;

        for line in stdout.lines() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 2 {
                if let Ok(add) = parts[0].parse::<u32>() {
                    additions += add;
                }
                if let Ok(del) = parts[1].parse::<u32>() {
                    deletions += del;
                }
            }
        }

        Ok((additions, deletions))
    } else {
        Ok((0, 0))
    }
}

/// 检查 worktree 是否 clean（无未提交的改动）
pub fn is_worktree_clean(path: &str) -> Result<bool, String> {
    has_uncommitted_changes(path).map(|has_changes| !has_changes)
}

/// 切换分支
/// 执行: git checkout {branch}
pub fn checkout_branch(worktree_path: &str, branch: &str) -> Result<(), String> {
    let output = Command::new("git")
        .current_dir(worktree_path)
        .args(["checkout", branch])
        .output()
        .map_err(|e| format!("Failed to execute git: {}", e))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("git checkout failed: {}", stderr.trim()))
    }
}

/// 添加所有文件并提交
/// 执行: git add -A && git commit -m {message}
pub fn add_and_commit(worktree_path: &str, message: &str) -> Result<(), String> {
    // 先 add
    let add_output = Command::new("git")
        .current_dir(worktree_path)
        .args(["add", "-A"])
        .output()
        .map_err(|e| format!("Failed to execute git add: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!("git add failed: {}", stderr.trim()));
    }

    // 检查是否有东西要提交
    if !has_uncommitted_changes(worktree_path).unwrap_or(false) {
        return Err("Nothing to commit".to_string());
    }

    // 再 commit
    let commit_output = Command::new("git")
        .current_dir(worktree_path)
        .args(["commit", "-m", message])
        .output()
        .map_err(|e| format!("Failed to execute git commit: {}", e))?;

    if commit_output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&commit_output.stderr);
        Err(format!("git commit failed: {}", stderr.trim()))
    }
}
