use std::process::Command;

/// difit 可用性状态
pub enum DifitAvailability {
    /// 全局安装的 difit
    Global,
    /// 通过 npx 可用
    Npx,
    /// 不可用
    NotAvailable,
}

/// 检测 difit 是否可用
pub fn check_available() -> DifitAvailability {
    // 优先检测全局 difit
    if Command::new("difit")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok()
    {
        return DifitAvailability::Global;
    }

    // 其次检测 npx
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

/// 执行 difit 并返回捕获的输出
///
/// 后台运行模式：将输出重定向到临时文件（无终端交互），
/// 进程结束后从临时文件读取输出以解析 review comments。
pub fn execute(
    worktree_path: &str,
    target_branch: &str,
    availability: &DifitAvailability,
) -> std::io::Result<String> {
    let temp_path = std::env::temp_dir().join(format!("grove_difit_{}.txt", std::process::id()));
    let temp_str = temp_path.to_string_lossy().to_string();

    let difit_cmd = match availability {
        DifitAvailability::Global => format!("difit . {}", target_branch),
        DifitAvailability::Npx => format!("npx -y difit . {}", target_branch),
        DifitAvailability::NotAvailable => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "difit not available",
            ));
        }
    };

    // 后台执行：重定向到文件，不用 tee（tee 会写终端，污染 TUI）
    // 不 null stdin，让 difit 能正常检测终端状态
    let shell_cmd = format!("{} > {} 2>&1", difit_cmd, temp_str);

    let _ = Command::new("sh")
        .args(["-c", &shell_cmd])
        .current_dir(worktree_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();

    // 读取捕获的输出
    let output = std::fs::read_to_string(&temp_path).unwrap_or_default();
    let _ = std::fs::remove_file(&temp_path);

    Ok(output)
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
