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

/// 获取默认分支 (main/master)
/// 尝试顺序: origin/HEAD -> main -> master
pub fn default_branch(repo_path: &str) -> Result<String, String> {
    // 尝试从 origin/HEAD 获取
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["symbolic-ref", "refs/remotes/origin/HEAD"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            let ref_str = String::from_utf8_lossy(&output.stdout);
            // refs/remotes/origin/main -> main
            if let Some(branch) = ref_str.trim().strip_prefix("refs/remotes/origin/") {
                return Ok(branch.to_string());
            }
        }
    }

    // fallback: 检查 main 是否存在
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", "main"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            return Ok("main".to_string());
        }
    }

    // fallback: 检查 master 是否存在
    let output = Command::new("git")
        .current_dir(repo_path)
        .args(["rev-parse", "--verify", "master"])
        .output();

    if let Ok(output) = output {
        if output.status.success() {
            return Ok("master".to_string());
        }
    }

    // 最终 fallback
    Ok("main".to_string())
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
