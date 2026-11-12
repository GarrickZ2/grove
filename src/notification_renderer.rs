//! In-process OS notification renderer.
//!
//! One of Grove's notification *surfaces*: renders sounds + OS banners for a
//! human sitting at this machine (TUI, `grove web`, local GUI). The backend
//! itself never renders — [`crate::acp`] publishes attention facts on the
//! radio `HookAdded` stream, and each surface decides presentation:
//!
//! - this renderer, for surfaces whose human shares the backend's machine
//! - the frontend notification engine (grove-web), for remote GUI / browser
//! - the `grove hooks` CLI, which renders on its own invocation machine
//!
//! Headless serving (`grove mobile`) disables this via
//! [`hooks::set_os_render_disabled`] — nobody is at that desktop, and the
//! capability bit surfaced at `GET /api/v1/version` flips accordingly so
//! attached frontends know to render instead.

use crate::hooks::{self, HookKind};
use crate::radio::{PermissionInfo, RadioEvent};
use std::sync::Once;

static STARTED: Once = Once::new();

/// Start rendering attention facts for this machine's human. Safe to call
/// from both async and sync contexts; no-ops when OS rendering is disabled.
pub fn spawn() {
    if hooks::os_render_disabled() {
        return;
    }

    // Local Web, local GUI, and TUI can share startup helpers. Keep one
    // subscriber per process so repeated initialization cannot produce
    // duplicate native banners or sounds.
    STARTED.call_once(|| {
        // Register before scheduling the task. If subscription happens inside
        // the future, an ACP event published during startup can beat the
        // first poll and disappear from the Localhost notification path.
        let mut rx = crate::radio::subscribe();
        let run = async move {
            while let Some(event) = rx.recv().await {
                if let RadioEvent::HookAdded { .. } = event {
                    render(&event);
                }
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(run);
            }
            // Sync callers (TUI startup) have no ambient runtime — give the
            // subscriber its own single-threaded one on a background thread.
            Err(_) => {
                std::thread::spawn(move || {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .expect("notification renderer runtime")
                        .block_on(run);
                });
            }
        }
    });
}

fn render(event: &RadioEvent) {
    let RadioEvent::HookAdded {
        project_id,
        task_id,
        message,
        kind,
        label,
        chat_id,
        permission,
        project_name,
        task_name,
        ..
    } = event
    else {
        return;
    };
    let Some(kind) = kind.as_deref().and_then(HookKind::parse) else {
        return;
    };
    // External hooks were already rendered by the `grove hooks` process that
    // fired them — re-rendering here would notify this machine twice.
    if kind == HookKind::External {
        return;
    }

    let cfg = crate::storage::config::load_config();
    let notif = &cfg.notifications;
    if !notif.notification_enabled {
        return;
    }
    let event_enabled = match kind {
        HookKind::TurnComplete => notif.notification_show_done,
        HookKind::PermissionRequired => notif.notification_show_permission,
        HookKind::ElicitationRequired => notif.notification_show_elicitation,
        HookKind::External => false,
        // People on a share link: only the master switch.
        HookKind::Comment => true,
    };
    if !event_enabled {
        return;
    }

    // ── 声音（延续历史策略：完成=Glass 类，权限=Purr 类，elicitation 无声）──
    let hooks_cfg = &cfg.hooks;
    let sound = match kind {
        HookKind::TurnComplete | HookKind::Comment if hooks_cfg.response_sound_enabled => {
            Some(if hooks_cfg.response_sound.is_empty() {
                "Glass"
            } else {
                hooks_cfg.response_sound.as_str()
            })
        }
        HookKind::PermissionRequired if hooks_cfg.permission_sound_enabled => {
            Some(if hooks_cfg.permission_sound.is_empty() {
                "Purr"
            } else {
                hooks_cfg.permission_sound.as_str()
            })
        }
        _ => None,
    };
    if let Some(s) = sound {
        hooks::play_sound(s);
    }

    // ── 系统横幅 ───────────────────────────────────────────────────────────
    let project_label = project_name.clone().unwrap_or_else(|| "Grove".to_string());
    let task_label = task_name.clone().unwrap_or_else(|| task_id.clone());
    let label = label
        .clone()
        .unwrap_or_else(|| default_label(kind).to_string());
    let title = format!("{} - {}", project_label, label);
    let banner_msg = match message {
        Some(m) if !m.is_empty() => format!("{} — {}", task_label, m),
        _ => task_label,
    };
    let (approve_opt, deny_opt) = match permission {
        Some(p) => match_allow_deny(p),
        None => (None, None),
    };
    hooks::send_banner(
        &title,
        &banner_msg,
        project_id,
        task_id,
        chat_id.as_deref(),
        kind == HookKind::PermissionRequired,
        approve_opt.as_deref(),
        deny_opt.as_deref(),
    );
}

/// 只匹配明确的 allow 类型，找不到就不设按钮（不猜测）。
fn match_allow_deny(p: &PermissionInfo) -> (Option<String>, Option<String>) {
    let approve_opt = p
        .options
        .iter()
        .find(|o| o.kind == "allow_once")
        .or_else(|| p.options.iter().find(|o| o.kind == "allow_always"))
        .or_else(|| p.options.iter().find(|o| o.kind.contains("allow")))
        .map(|o| o.option_id.clone());

    let deny_opt = p
        .options
        .iter()
        .find(|o| o.kind == "reject_once")
        .or_else(|| p.options.iter().find(|o| o.kind == "reject_always"))
        .or_else(|| {
            p.options
                .iter()
                .find(|o| o.kind.contains("reject") || o.kind.contains("deny"))
        })
        .map(|o| o.option_id.clone());

    (approve_opt, deny_opt)
}

fn default_label(kind: HookKind) -> &'static str {
    match kind {
        HookKind::TurnComplete => "Task Complete",
        HookKind::PermissionRequired => "Permission Required",
        HookKind::ElicitationRequired => "Input Required",
        HookKind::External => "Notification",
        HookKind::Comment => "Comment",
    }
}

// ── Test notification ──────────────────────────────────────────────────────

/// Title / body of the Settings "Send test" banner. Clearly a test: it names
/// no task and is never persisted to the bell inbox.
pub const TEST_TITLE: &str = "Grove - Test notification";
pub const TEST_BODY: &str = "Notifications are working. This was a test; no task was affected.";

/// What a test notification does on this machine, decided from config only.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TestPlan {
    /// "sent" — rendered here; "disabled" — notifications are switched off;
    /// "client" — this server renders nothing (headless), the client must.
    pub status: &'static str,
    pub banner: bool,
    pub sound: Option<String>,
}

/// Pure policy for the test notification. Mirrors [`render`] for a
/// turn-complete fact (the most common real notification): the master switch
/// gates everything, the response sound plays when enabled. The per-event
/// "show done" switch is deliberately not applied — a test that silently
/// does nothing because one event type is muted would read as broken.
pub fn plan_test(cfg: &crate::storage::config::Config, os_render_disabled: bool) -> TestPlan {
    if os_render_disabled {
        return TestPlan {
            status: "client",
            banner: false,
            sound: None,
        };
    }
    if !cfg.notifications.notification_enabled {
        return TestPlan {
            status: "disabled",
            banner: false,
            sound: None,
        };
    }
    let hooks_cfg = &cfg.hooks;
    let sound = hooks_cfg.response_sound_enabled.then(|| {
        if hooks_cfg.response_sound.is_empty() {
            "Glass".to_string()
        } else {
            hooks_cfg.response_sound.clone()
        }
    });
    TestPlan {
        status: "sent",
        banner: true,
        sound,
    }
}

/// Render one test notification through the same sound + banner primitives
/// real attention facts use. Nothing is persisted or broadcast on the radio,
/// so no task state, inbox entry, plugin or phone sees it. The banner carries
/// no project/task, so clicking it only brings Grove to the front.
pub fn render_test() -> TestPlan {
    let plan = plan_test(
        &crate::storage::config::load_config(),
        hooks::os_render_disabled(),
    );
    if let Some(sound) = plan.sound.as_deref() {
        hooks::play_sound(sound);
    }
    if plan.banner {
        hooks::send_banner(TEST_TITLE, TEST_BODY, "", "", None, false, None, None);
    }
    plan
}

#[cfg(test)]
mod test_notification_tests {
    use super::*;
    use crate::storage::config::Config;

    #[test]
    fn test_plan_follows_master_switch_and_response_sound() {
        let mut cfg = Config::default();
        cfg.notifications.notification_enabled = true;
        cfg.hooks.response_sound_enabled = true;
        cfg.hooks.response_sound = "Ping".into();
        assert_eq!(
            plan_test(&cfg, false),
            TestPlan {
                status: "sent",
                banner: true,
                sound: Some("Ping".into())
            }
        );

        cfg.hooks.response_sound.clear();
        assert_eq!(plan_test(&cfg, false).sound.as_deref(), Some("Glass"));

        cfg.hooks.response_sound_enabled = false;
        let plan = plan_test(&cfg, false);
        assert!(plan.banner);
        assert_eq!(plan.sound, None);

        // Muting one event type doesn't silence the test.
        cfg.notifications.notification_show_done = false;
        assert_eq!(plan_test(&cfg, false).status, "sent");

        cfg.notifications.notification_enabled = false;
        assert_eq!(plan_test(&cfg, false).status, "disabled");
        assert!(!plan_test(&cfg, false).banner);

        // Headless server: the client renders.
        cfg.notifications.notification_enabled = true;
        let plan = plan_test(&cfg, true);
        assert_eq!(plan.status, "client");
        assert!(!plan.banner && plan.sound.is_none());
    }
}
