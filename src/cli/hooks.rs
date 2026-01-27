//! hooks 子命令实现

use clap::Subcommand;
use std::env;
use std::process::Command;

use crate::hooks::{self, NotificationLevel};

#[derive(Subcommand)]
pub enum HookLevel {
    /// Normal notification (blue) - default: sound only
    Notice {
        #[arg(long, default_value = "Glass")]
        sound: String,
        #[arg(long)]
        banner: bool,
        #[arg(long)]
        no_banner: bool,
    },
    /// Warning notification (yellow) - default: sound + banner
    Warn {
        #[arg(long, default_value = "Purr")]
        sound: String,
        #[arg(long)]
        banner: bool,
        #[arg(long)]
        no_banner: bool,
    },
    /// Critical notification (red) - default: sound + banner
    Critical {
        #[arg(long, default_value = "Sosumi")]
        sound: String,
        #[arg(long)]
        banner: bool,
        #[arg(long)]
        no_banner: bool,
    },
}

impl HookLevel {
    /// 获取通知级别
    fn level(&self) -> NotificationLevel {
        match self {
            HookLevel::Notice { .. } => NotificationLevel::Notice,
            HookLevel::Warn { .. } => NotificationLevel::Warn,
            HookLevel::Critical { .. } => NotificationLevel::Critical,
        }
    }

    /// 获取声音名称
    fn sound(&self) -> &str {
        match self {
            HookLevel::Notice { sound, .. } => sound,
            HookLevel::Warn { sound, .. } => sound,
            HookLevel::Critical { sound, .. } => sound,
        }
    }

    /// 是否显示系统通知横幅
    fn should_banner(&self) -> bool {
        match self {
            HookLevel::Notice {
                banner, no_banner, ..
            } => {
                if *no_banner {
                    false
                } else {
                    *banner // notice 默认不显示
                }
            }
            HookLevel::Warn { no_banner, .. } => {
                // warn 默认显示
                !*no_banner
            }
            HookLevel::Critical { no_banner, .. } => {
                // critical 默认显示
                !*no_banner
            }
        }
    }

    /// 获取级别名称（用于通知标题）
    fn level_name(&self) -> &'static str {
        match self {
            HookLevel::Notice { .. } => "Notice",
            HookLevel::Warn { .. } => "Warning",
            HookLevel::Critical { .. } => "Critical",
        }
    }
}

/// 执行 hook 命令
pub fn execute(level: HookLevel) {
    // 先检查所有必要的环境变量
    let project_path = match env::var("GROVE_PROJECT") {
        Ok(p) => p,
        Err(_) => return, // 缺少环境变量，静默退出
    };
    let task_id = match env::var("GROVE_TASK_ID") {
        Ok(t) => t,
        Err(_) => return,
    };
    let task_name = match env::var("GROVE_TASK_NAME") {
        Ok(n) => n,
        Err(_) => return,
    };
    let project_name = match env::var("GROVE_PROJECT_NAME") {
        Ok(n) => n,
        Err(_) => return,
    };

    // 播放声音
    let sound = level.sound();
    if sound.to_lowercase() != "none" {
        play_sound(sound);
    }

    // 发送系统通知横幅
    if level.should_banner() {
        let title = format!("Grove - {}", level.level_name());
        let message = format!("[{}] {}", project_name, task_name);
        send_banner(&title, &message);
    }

    // 无条件记录到 hooks 文件（当用户 detach 回到 Grove 时会被清除）
    update_hooks_file(&project_path, &task_id, level.level());
}

/// 播放提示音
fn play_sound(sound: &str) {
    let path = format!("/System/Library/Sounds/{}.aiff", sound);
    Command::new("afplay").arg(&path).spawn().ok();
}

/// 发送 macOS 通知横幅
fn send_banner(title: &str, message: &str) {
    // 优先使用 terminal-notifier（点击后不会打开脚本编辑器）
    let result = Command::new("terminal-notifier")
        .args(["-title", title, "-message", message])
        .spawn();

    if result.is_err() {
        // fallback 到 osascript
        let script = format!(
            r#"display notification "{}" with title "{}""#,
            message.replace('"', "\\\""),
            title.replace('"', "\\\"")
        );
        Command::new("osascript").args(["-e", &script]).spawn().ok();
    }
}

/// 更新 hooks.toml 文件
fn update_hooks_file(project_path: &str, task_id: &str, level: NotificationLevel) {
    use crate::storage::workspace::project_hash;

    let project_key = project_hash(project_path);

    let mut hooks_file = hooks::load_hooks(&project_key);
    hooks_file.update(task_id, level);
    let _ = hooks::save_hooks(&project_key, &hooks_file);
}
