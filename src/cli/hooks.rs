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

    // 无条件记录到通知存储（当用户 detach 回到 Grove 时会被清除）；
    // update_hook 会广播 HookAdded 让 grove server 上的前端立即刷新。
    // GROVE_CHAT_ID 是可选的:在 chat 上下文(ACP/agent spawn)启动的 session
    // 才会注入,纯 task-level shell 没有 → 前端跳转 fallback 只到 task。
    let project_key = crate::storage::workspace::project_hash(&project_path);
    let chat_id = env::var("GROVE_CHAT_ID").ok().filter(|s| !s.is_empty());

    // 发送系统通知横幅
    if level.should_banner() {
        let title = format!("Grove - {}", level.level_name());
        let banner_msg = if let Some(ref msg) = message {
            format!("[{}] {} - {}", project_name, task_name, msg)
        } else {
            format!("[{}] {}", project_name, task_name)
        };
        hooks::send_banner(
            &title,
            &banner_msg,
            &project_key,
            &task_id,
            chat_id.as_deref(),
            false,
            None,
            None,
        );
    }

    // Hand the attention fact to the live Grove server first: this process is
    // short-lived, so a radio publish here would die unheard — the server's
    // publish is what reaches attached frontends. Fall back to writing the
    // record ourselves when no server answers (badge still lands on disk).
    let fact = hooks::HookFact {
        kind: hooks::HookKind::External,
        label: Some(level.level_name().to_string()),
        level: Some(level.level()),
        message,
        chat_id: chat_id.clone(),
        permission: None,
    };
    if !report_hook_to_server(&project_key, &task_id, &fact) {
        if let Err(e) = hooks::update_hook(&project_key, &task_id, fact) {
            eprintln!("grove hooks: failed to persist notification locally: {e}");
        }
    }
}

/// Best-effort POST of a hook fact to the running Grove server. Returns true
/// only when the server acknowledged the report.
fn report_hook_to_server(project_key: &str, task_id: &str, fact: &hooks::HookFact) -> bool {
    let base = hooks::get_server_base_url();
    let url = format!("{}/api/v1/hooks/report", base.trim_end_matches('/'));
    let token = std::fs::read_to_string(crate::storage::grove_dir().join("local_report_token"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let body = serde_json::json!({
        "project_id": project_key,
        "task_id": task_id,
        "level": hooks::level_to_str(fact.level.unwrap_or(hooks::NotificationLevel::Notice)),
        "message": fact.message,
        "chat_id": fact.chat_id,
    });

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(_) => return false,
    };
    runtime.block_on(async {
        // TLS-mode servers use a self-signed cert; the report is loopback and
        // authenticated by the per-boot token, so cert validation is waived.
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(1500))
            .danger_accept_invalid_certs(true)
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        let mut request = client.post(&url).json(&body);
        if let Some(t) = token.as_deref() {
            request = request.header("x-grove-local-token", t);
        }
        matches!(request.send().await, Ok(resp) if resp.status().is_success())
    })
}
