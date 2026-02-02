use std::process::Command;
use std::sync::mpsc::Sender;

/// difit 可用性状态
pub enum DifitAvailability {
    /// 全局安装的 difit
    Global,
    /// 通过 npx 可用
    Npx,
    /// 不可用
    NotAvailable,
}

/// 检测 difit 是否可用（优先全局，其次 npx）
pub fn check_available() -> DifitAvailability {
    if Command::new("difit")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
    {
        return DifitAvailability::Global;
    }

    if Command::new("npx")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
    {
        return DifitAvailability::Npx;
    }

    DifitAvailability::NotAvailable
}

/// spawn 后的句柄，持有子进程和临时文件路径
pub struct DifitHandle {
    pub child_pid: u32,
    pub temp_file_path: String,
    child: std::process::Child,
    temp_path: std::path::PathBuf,
}

/// 启动 difit 子进程，立即返回句柄
pub fn spawn_difit(
    worktree_path: &str,
    target_branch: &str,
    availability: &DifitAvailability,
) -> std::io::Result<DifitHandle> {
    let temp_path = std::env::temp_dir().join(format!("grove_difit_{}.txt", std::process::id()));
    let temp_str = temp_path.to_string_lossy().to_string();

    let difit_cmd = match availability {
        DifitAvailability::Global => format!("difit . {} --include-untracked", target_branch),
        DifitAvailability::Npx => format!("npx -y difit . {} --include-untracked", target_branch),
        DifitAvailability::NotAvailable => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "difit not available",
            ));
        }
    };

    let shell_cmd = format!("{} > {} 2>&1", difit_cmd, temp_str);

    let child = Command::new("sh")
        .args(["-c", &shell_cmd])
        .current_dir(worktree_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;

    let child_pid = child.id();

    Ok(DifitHandle {
        child_pid,
        temp_file_path: temp_str,
        child,
        temp_path,
    })
}

/// 等待 difit 进程完成，轮询输出文件。
///
/// 检测到 URL 时通过 `url_tx` 发送（仅发送一次）。
/// 检测到 "No differences found" 时主动终止进程。
/// 返回捕获的完整输出。
pub fn wait_for_completion(
    handle: &mut DifitHandle,
    url_tx: Option<Sender<String>>,
) -> std::io::Result<String> {
    let mut url_sent = false;

    loop {
        if let Some(_status) = handle.child.try_wait()? {
            break;
        }

        if let Ok(content) = std::fs::read_to_string(&handle.temp_path) {
            // 检测 URL
            if !url_sent {
                if let Some(url) = parse_url(&content) {
                    if let Some(ref tx) = url_tx {
                        let _ = tx.send(url);
                    }
                    url_sent = true;
                }
            }

            // 检测 no-diff
            if content.contains("No differences found") {
                let _ = handle.child.kill();
                let _ = handle.child.wait();
                break;
            }
        }

        std::thread::sleep(std::time::Duration::from_millis(500));
    }

    let output = std::fs::read_to_string(&handle.temp_path).unwrap_or_default();
    let _ = std::fs::remove_file(&handle.temp_path);

    Ok(output)
}

/// 从 difit 输出中解析 server URL
///
/// 匹配形如 `http://localhost:4968` 的 URL
pub fn parse_url(output: &str) -> Option<String> {
    for line in output.lines() {
        if let Some(pos) = line.find("http://localhost:") {
            return Some(line[pos..].trim().to_string());
        }
        if let Some(pos) = line.find("http://127.0.0.1:") {
            return Some(line[pos..].trim().to_string());
        }
    }
    None
}

/// 从 difit stdout 中解析 review comments
///
/// difit 关闭时输出格式：
/// ```text
/// 📝 Comments from review session:
/// ==================================================
/// file.go:L54
/// comment text
/// =====
/// another.go:L30
/// another comment
/// ==================================================
/// Total comments: N
/// ```
///
/// 返回 (comments 原始文本, comment 数量)
pub fn parse_comments(output: &str) -> (String, usize) {
    let start_marker = "📝 Comments from review session:";
    let boundary = "==================================================";

    let Some(start_pos) = output.find(start_marker) else {
        return (String::new(), 0);
    };

    let after_start = &output[start_pos..];

    // 找到第一个 boundary（开始标记后）
    let Some(first_boundary) = after_start.find(boundary) else {
        return (String::new(), 0);
    };
    let after_first = &after_start[first_boundary + boundary.len()..];

    // 找到第二个 boundary（结束标记）
    let Some(second_boundary) = after_first.find(boundary) else {
        return (String::new(), 0);
    };

    let comments_section = after_first[..second_boundary].trim();

    if comments_section.is_empty() {
        return (String::new(), 0);
    }

    // 按 "=====" 独立分隔行计数 comments
    // 每个 comment 之间用 "=====" 分隔，所以 comment 数 = 分隔符数 + 1
    let count = comments_section
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            trimmed == "====="
        })
        .count()
        + 1; // N separators = N+1 comments

    (comments_section.to_string(), count)
}
