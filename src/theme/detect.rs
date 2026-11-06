//! 系统主题检测

use std::process::Command;

/// Windows keeps the app theme in a registry value: 0 means dark.
#[cfg(windows)]
pub fn detect_system_theme() -> bool {
    Command::new("reg")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "AppsUseLightTheme",
        ])
        .output()
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("0x0")
        })
        .unwrap_or(false)
}

/// 检测 macOS 系统主题
///
/// 返回 `true` 表示深色模式，`false` 表示浅色模式
#[cfg(not(windows))]
pub fn detect_system_theme() -> bool {
    // macOS 使用 defaults 命令读取系统设置
    // 如果 AppleInterfaceStyle 存在且为 "Dark"，则为深色模式
    // 如果不存在（命令失败），则为浅色模式
    Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .eq_ignore_ascii_case("dark")
        })
        .unwrap_or(false) // 默认浅色模式（或非 macOS 系统）
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_system_theme() {
        // 只是确保函数不会 panic
        let _is_dark = detect_system_theme();
    }
}
