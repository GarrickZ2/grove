//! hooks 子命令实现

use clap::Subcommand;
use std::env;

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
        #[arg(long, short = 'm')]
        message: Option<String>,
    },
    /// Warning notification (yellow) - default: sound + banner
    Warn {
        #[arg(long, default_value = "Purr")]
        sound: String,
        #[arg(long)]
        banner: bool,
        #[arg(long)]
        no_banner: bool,
        #[arg(long, short = 'm')]
        message: Option<String>,
    },
    /// Critical notification (red) - default: sound + banner
    Critical {
        #[arg(long, default_value = "Sosumi")]
        sound: String,
        #[arg(long)]
        banner: bool,
        #[arg(long)]
        no_banner: bool,
        #[arg(long, short = 'm')]
        message: Option<String>,
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

    /// 获取消息文本
    fn message(&self) -> Option<&str> {
        match self {
            HookLevel::Notice { message, .. } => message.as_deref(),
            HookLevel::Warn { message, .. } => message.as_deref(),
            HookLevel::Critical { message, .. } => message.as_deref(),
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

    let message = level.message().map(|s| s.to_string());

    // 播放声音
    let sound = level.sound();
    if sound.to_lowercase() != "none" {
        hooks::play_sound(sound);
    }

    // 发送系统通知横幅
    if level.should_banner() {
        let title = format!("Grove - {}", level.level_name());
        let banner_msg = if let Some(ref msg) = message {
            format!("[{}] {} - {}", project_name, task_name, msg)
        } else {
            format!("[{}] {}", project_name, task_name)
        };
        hooks::send_banner(&title, &banner_msg);
    }

    // 无条件记录到通知存储（当用户 detach 回到 Grove 时会被清除）；
    // update_hook 会广播 HookAdded 让 grove server 上的前端立即刷新。
    // GROVE_CHAT_ID 是可选的:在 chat 上下文(ACP/agent spawn)启动的 session
    // 才会注入,纯 task-level shell 没有 → 前端跳转 fallback 只到 task。
    let project_key = crate::storage::workspace::project_hash(&project_path);
    let chat_id = env::var("GROVE_CHAT_ID").ok().filter(|s| !s.is_empty());
    hooks::update_hook(&project_key, &task_id, level.level(), message, chat_id);
}
