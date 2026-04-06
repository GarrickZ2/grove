//! Walkie-Talkie WebSocket handler for real-time duplex communication
//! between a mobile phone and the Grove backend.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::{broadcast, mpsc};

use crate::acp;
use crate::storage::{taskgroups, tasks, workspace};

// ─── Radio Client Counter ───────────────────────────────────────────────────

static RADIO_CLIENT_COUNT: Lazy<std::sync::atomic::AtomicUsize> =
    Lazy::new(|| std::sync::atomic::AtomicUsize::new(0));

pub fn radio_client_count() -> usize {
    RADIO_CLIENT_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

pub fn increment_radio_clients() {
    RADIO_CLIENT_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

pub fn decrement_radio_clients() {
    RADIO_CLIENT_COUNT.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
}

// ─── Radio Events Broadcast (Radio → Desktop) ─────────────────────────────

/// Events broadcast from Radio phone to desktop Blitz listeners.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RadioEvent {
    /// Radio user tapped or long-pressed a task — desktop should switch to it.
    FocusTask { project_id: String, task_id: String },
    /// Radio user sent a prompt to a task.
    PromptSent { project_id: String, task_id: String },
    /// A phone connected to the Radio server.
    ClientConnected,
    /// A phone disconnected from the Radio server.
    ClientDisconnected,
    /// Current count of connected Radio clients (sent on desktop events WS connect).
    ClientCount { count: usize },
    /// TaskGroup data changed (Blitz updated groups via REST).
    GroupChanged,
    /// Theme changed on desktop.
    ThemeChanged,
}

/// Global broadcast channel for radio events.
/// Desktop Blitz WS clients subscribe to this.
static RADIO_EVENTS: Lazy<broadcast::Sender<RadioEvent>> = Lazy::new(|| {
    let (tx, _) = broadcast::channel(64);
    tx
});

/// Broadcast a radio event to all desktop listeners.
pub fn broadcast_radio_event(event: RadioEvent) {
    let _ = RADIO_EVENTS.send(event);
}

// ─── Client → Server Messages ───────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    SwitchGroup {
        group_id: String,
    },
    SelectTask {
        group_id: String,
        position: u16,
    },
    SendPrompt {
        group_id: String,
        position: u16,
        text: String,
        #[serde(default)]
        chat_id: Option<String>,
    },
    SwitchChat {
        group_id: String,
        position: u16,
        direction: String,
    },
}

// ─── Server → Client Messages ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMessage {
    Connected {
        groups: Vec<GroupSnapshot>,
        theme: String,
    },
    TaskStatus {
        project_id: String,
        task_id: String,
        agent_status: String,
    },
    PromptSent {
        group_id: String,
        position: u16,
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    ChatInfo {
        position: u16,
        active_chat: Option<ChatRef>,
        available_chats: Vec<ChatRef>,
    },
    GroupUpdated {
        groups: Vec<GroupSnapshot>,
    },
    ThemeChanged {
        theme: String,
    },
}

// ─── Supporting Structs ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct GroupSnapshot {
    #[serde(flatten)]
    group: taskgroups::TaskGroup,
    slot_statuses: HashMap<u16, SlotStatus>,
}

#[derive(Debug, Clone, Serialize)]
struct SlotStatus {
    agent_status: String,
    task_name: String,
    project_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct ChatRef {
    id: String,
    agent: String,
    title: String,
}

/// Per-connection state tracking the user's current focus.
struct WalkieTalkieState {
    current_group_id: Option<String>,
    current_position: Option<u16>,
    /// Maps (project_id, task_id) → currently selected chat_id
    active_chats: HashMap<(String, String), String>,
}

impl WalkieTalkieState {
    fn new() -> Self {
        Self {
            current_group_id: None,
            current_position: None,
            active_chats: HashMap::new(),
        }
    }
}

// ─── Connect Info Handler ──────────────────────────────────────────────────

/// GET /radio/connect-info — returns the Radio connection URL with LAN IP + QR code SVG
pub async fn connect_info() -> axum::response::Json<serde_json::Value> {
    let lan_ip = crate::api::get_lan_ip();
    let host = lan_ip.unwrap_or_else(|| "localhost".to_string());

    // Read port and protocol set by start_server() after binding
    let port = std::env::var("GROVE_PORT").unwrap_or_else(|_| "3000".to_string());
    let protocol = std::env::var("GROVE_PROTOCOL").unwrap_or_else(|_| "http".to_string());

    let base_url = format!("{}://{}:{}", protocol, host, port);
    let radio_url = format!("{}/#page=radio", base_url);

    // Generate QR code as SVG
    let qr_svg = match qrcode::QrCode::new(&radio_url) {
        Ok(code) => {
            let svg = code
                .render::<qrcode::render::svg::Color>()
                .min_dimensions(200, 200)
                .quiet_zone(true)
                .build();
            Some(svg)
        }
        Err(_) => None,
    };

    axum::response::Json(serde_json::json!({
        "url": base_url,
        "radio_url": radio_url,
        "host": host,
        "port": port,
        "qr_svg": qr_svg,
    }))
}

// ─── WebSocket Upgrade Handler ──────────────────────────────────────────────

/// GET /walkie-talkie/ws
pub async fn ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_walkie_talkie_ws_inner)
}

/// Inner WS handler, exposed so the Radio server can reuse it.
pub async fn handle_walkie_talkie_ws_inner(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Channel for sending messages back to the client from background tasks
    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<ServerMessage>();

    // Build initial snapshot and send Connected message
    let snapshot = build_full_snapshot();
    let theme_name = crate::storage::config::load_config().theme.name;
    let connected = ServerMessage::Connected {
        groups: snapshot.clone(),
        theme: theme_name,
    };
    if let Ok(json) = serde_json::to_string(&connected) {
        use futures::SinkExt;
        let _ = ws_tx.send(Message::Text(json.into())).await;
    }

    let mut wt_state = WalkieTalkieState::new();

    // Track last-known statuses for change detection in the poller
    let mut last_statuses: HashMap<(String, String), String> = HashMap::new();
    for gs in &snapshot {
        for slot in &gs.group.slots {
            let status = check_agent_status(&slot.project_id, &slot.task_id);
            last_statuses.insert((slot.project_id.clone(), slot.task_id.clone()), status);
        }
    }

    // Status poll interval
    let mut poll_interval = tokio::time::interval(std::time::Duration::from_secs(2));
    poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Subscribe to radio events (e.g. GroupChanged from Blitz REST calls)
    let mut radio_rx = RADIO_EVENTS.subscribe();

    use futures::{SinkExt, StreamExt};

    loop {
        tokio::select! {
            // Incoming client message
            maybe_msg = ws_rx.next() => {
                match maybe_msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(client_msg) = serde_json::from_str::<ClientMessage>(&text) {
                            handle_client_message(client_msg, &mut wt_state, &msg_tx).await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // Outgoing message from background/handler tasks
            Some(server_msg) = msg_rx.recv() => {
                if let Ok(json) = serde_json::to_string(&server_msg) {
                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }

            // Radio events (GroupChanged, ThemeChanged from Blitz, etc.)
            result = radio_rx.recv() => {
                match result {
                    Ok(RadioEvent::GroupChanged) => {
                        let snapshot = build_full_snapshot();
                        // Refresh last_statuses so the poller tracks new/removed tasks
                        last_statuses.clear();
                        for gs in &snapshot {
                            for slot in &gs.group.slots {
                                let status = check_agent_status(&slot.project_id, &slot.task_id);
                                last_statuses.insert(
                                    (slot.project_id.clone(), slot.task_id.clone()),
                                    status,
                                );
                            }
                        }
                        let _ = msg_tx.send(ServerMessage::GroupUpdated { groups: snapshot });
                    }
                    Ok(RadioEvent::ThemeChanged) => {
                        let theme_name = crate::storage::config::load_config().theme.name;
                        let _ = msg_tx.send(ServerMessage::ThemeChanged { theme: theme_name });
                    }
                    _ => {}
                }
            }

            // Periodic status poll (skip if no tasks are tracked)
            _ = poll_interval.tick() => {
                if !last_statuses.is_empty() {
                    poll_task_statuses(&mut last_statuses, &msg_tx);
                }
            }
        }
    }
}

// ─── Client Message Dispatch ────────────────────────────────────────────────

fn validate_position(position: u16) -> bool {
    position >= 1
}

async fn handle_client_message(
    msg: ClientMessage,
    state: &mut WalkieTalkieState,
    tx: &mpsc::UnboundedSender<ServerMessage>,
) {
    // Validate position for messages that include it
    match &msg {
        ClientMessage::SelectTask { position, .. }
        | ClientMessage::SendPrompt { position, .. }
        | ClientMessage::SwitchChat { position, .. } => {
            if !validate_position(*position) {
                let _ = tx.send(ServerMessage::PromptSent {
                    group_id: String::new(),
                    position: *position,
                    status: "error".to_string(),
                    error: Some("Position must be >= 1".to_string()),
                });
                return;
            }
        }
        _ => {}
    }

    // Load groups once per message to avoid repeated disk reads
    let groups = taskgroups::load_groups().unwrap_or_default();

    match msg {
        ClientMessage::SwitchGroup { group_id } => {
            state.current_group_id = Some(group_id);
            state.current_position = None;
            // Send updated group snapshot
            let snapshot = build_full_snapshot();
            let _ = tx.send(ServerMessage::GroupUpdated { groups: snapshot });
        }
        ClientMessage::SelectTask { group_id, position } => {
            state.current_group_id = Some(group_id.clone());
            state.current_position = Some(position);
            // Broadcast focus event to desktop Blitz listeners
            if let Some(slot) = find_slot_in(&groups, &group_id, position) {
                let _ = RADIO_EVENTS.send(RadioEvent::FocusTask {
                    project_id: slot.project_id.clone(),
                    task_id: slot.task_id.clone(),
                });
            }
            // Send chat info for the selected slot
            if let Some(chat_info) = get_chat_info_for_slot(&group_id, position, state, &groups) {
                let _ = tx.send(chat_info);
            }
        }
        ClientMessage::SendPrompt {
            group_id,
            position,
            text,
            chat_id,
        } => {
            // Broadcast focus event first (desktop switches to this task)
            if let Some(slot) = find_slot_in(&groups, &group_id, position) {
                let _ = RADIO_EVENTS.send(RadioEvent::FocusTask {
                    project_id: slot.project_id.clone(),
                    task_id: slot.task_id.clone(),
                });
            }
            let result =
                send_prompt_to_task(&group_id, position, &text, chat_id.as_deref(), state, &groups).await;
            // Broadcast prompt_sent event after sending
            if let Some(slot) = find_slot_in(&groups, &group_id, position) {
                let _ = RADIO_EVENTS.send(RadioEvent::PromptSent {
                    project_id: slot.project_id.clone(),
                    task_id: slot.task_id.clone(),
                });
            }
            let _ = tx.send(result);
        }
        ClientMessage::SwitchChat {
            group_id,
            position,
            direction,
        } => {
            if let Some(chat_info) = switch_chat(&group_id, position, &direction, state, &groups) {
                let _ = tx.send(chat_info);
            }
        }
    }
}

// ─── Core Functions ─────────────────────────────────────────────────────────

/// Load all groups and build a full snapshot with slot statuses.
/// Excludes _local group (not relevant for Radio control).
fn build_full_snapshot() -> Vec<GroupSnapshot> {
    let groups: Vec<_> = taskgroups::load_groups()
        .unwrap_or_default()
        .into_iter()
        .filter(|g| g.id != taskgroups::LOCAL_GROUP_ID)
        .collect();
    let projects = workspace::load_projects().unwrap_or_default();

    // Build a project-name lookup by project hash
    let project_names: HashMap<String, String> = projects
        .iter()
        .map(|p| (workspace::project_hash(&p.path), p.name.clone()))
        .collect();
    groups
        .into_iter()
        .map(|group| {
            let mut slot_statuses = HashMap::new();
            for slot in &group.slots {
                let agent_status = check_agent_status(&slot.project_id, &slot.task_id);
                let task_name = resolve_task_name(&slot.project_id, &slot.task_id);
                let project_name = project_names
                    .get(&slot.project_id)
                    .cloned()
                    .unwrap_or_else(|| slot.project_id.clone());
                slot_statuses.insert(
                    slot.position,
                    SlotStatus {
                        agent_status,
                        task_name,
                        project_name,
                    },
                );
            }
            GroupSnapshot {
                group,
                slot_statuses,
            }
        })
        .collect()
}

/// Resolve a task's display name from storage.
fn resolve_task_name(project_id: &str, task_id: &str) -> String {
    tasks::load_tasks(project_id)
        .unwrap_or_default()
        .into_iter()
        .find(|t| t.id == task_id)
        .map(|t| t.name)
        .unwrap_or_else(|| task_id.to_string())
}

/// Check agent status for the given task's chats.
/// Returns:
/// - "busy" if at least one chat session is actively processing
/// - "idle" if at least one session is connected but none are busy
/// - "disconnected" if no sessions are connected
fn check_agent_status(project_id: &str, task_id: &str) -> String {
    let chats = tasks::load_chat_sessions(project_id, task_id).unwrap_or_default();
    let mut has_connected_session = false;
    for chat in &chats {
        let session_key = format!("{}:{}:{}", project_id, task_id, chat.id);
        if let Some(handle) = acp::get_session_handle(&session_key) {
            has_connected_session = true;
            if handle.is_busy.load(std::sync::atomic::Ordering::Relaxed) {
                return "busy".to_string();
            }
        }
    }
    if has_connected_session {
        "idle".to_string()
    } else {
        "disconnected".to_string()
    }
}

/// Build ChatInfo for a slot, returning the active chat and all available chats.
fn get_chat_info_for_slot(
    group_id: &str,
    position: u16,
    state: &WalkieTalkieState,
    groups: &[taskgroups::TaskGroup],
) -> Option<ServerMessage> {
    let slot = find_slot_in(groups, group_id, position)?;

    let chats = tasks::load_chat_sessions(&slot.project_id, &slot.task_id).unwrap_or_default();
    let available_chats: Vec<ChatRef> = chats
        .iter()
        .map(|c| ChatRef {
            id: c.id.clone(),
            agent: c.agent.clone(),
            title: c.title.clone(),
        })
        .collect();

    // Determine the active chat: use per-connection state, slot override, or first available
    let active_chat = state
        .active_chats
        .get(&(slot.project_id.clone(), slot.task_id.clone()))
        .and_then(|cid| available_chats.iter().find(|c| c.id == *cid))
        .cloned()
        .or_else(|| {
            slot.target_chat_id
                .as_ref()
                .and_then(|cid| available_chats.iter().find(|c| c.id == *cid))
                .cloned()
        })
        .or_else(|| available_chats.first().cloned());

    Some(ServerMessage::ChatInfo {
        position,
        active_chat,
        available_chats,
    })
}

/// Send a prompt to the active (or overridden) chat for a slot.
async fn send_prompt_to_task(
    group_id: &str,
    position: u16,
    text: &str,
    override_chat_id: Option<&str>,
    state: &mut WalkieTalkieState,
    groups: &[taskgroups::TaskGroup],
) -> ServerMessage {
    let slot = match find_slot_in(groups, group_id, position) {
        Some(s) => s,
        None => {
            return ServerMessage::PromptSent {
                group_id: group_id.to_string(),
                position,
                status: "error".to_string(),
                error: Some("Slot not found".to_string()),
            };
        }
    };

    // Resolve which chat to use
    let chat_id = override_chat_id
        .map(|s| s.to_string())
        .or_else(|| {
            state
                .active_chats
                .get(&(slot.project_id.clone(), slot.task_id.clone()))
                .cloned()
        })
        .or_else(|| slot.target_chat_id.clone())
        .or_else(|| {
            tasks::load_chat_sessions(&slot.project_id, &slot.task_id)
                .unwrap_or_default()
                .first()
                .map(|c| c.id.clone())
        });

    let chat_id = match chat_id {
        Some(id) => id,
        None => {
            return ServerMessage::PromptSent {
                group_id: group_id.to_string(),
                position,
                status: "error".to_string(),
                error: Some("No chat session available".to_string()),
            };
        }
    };

    // Update active chat tracking
    state.active_chats.insert(
        (slot.project_id.clone(), slot.task_id.clone()),
        chat_id.clone(),
    );

    let session_key = format!("{}:{}:{}", slot.project_id, slot.task_id, chat_id);

    match acp::get_session_handle(&session_key) {
        Some(handle) => {
            match handle
                .send_prompt(text.to_string(), vec![], Some("radio".to_string()), false)
                .await
            {
                Ok(_) => ServerMessage::PromptSent {
                    group_id: group_id.to_string(),
                    position,
                    status: "ok".to_string(),
                    error: None,
                },
                Err(e) => ServerMessage::PromptSent {
                    group_id: group_id.to_string(),
                    position,
                    status: "error".to_string(),
                    error: Some(format!("Failed to send prompt: {}", e)),
                },
            }
        }
        None => ServerMessage::PromptSent {
            group_id: group_id.to_string(),
            position,
            status: "error".to_string(),
            error: Some("No active ACP session for this chat".to_string()),
        },
    }
}

/// Cycle through available chats for a slot in the given direction ("next" | "prev").
fn switch_chat(
    group_id: &str,
    position: u16,
    direction: &str,
    state: &mut WalkieTalkieState,
    groups: &[taskgroups::TaskGroup],
) -> Option<ServerMessage> {
    let slot = find_slot_in(groups, group_id, position)?;

    let chats = tasks::load_chat_sessions(&slot.project_id, &slot.task_id).unwrap_or_default();
    if chats.is_empty() {
        return Some(ServerMessage::ChatInfo {
            position,
            active_chat: None,
            available_chats: vec![],
        });
    }

    let available_chats: Vec<ChatRef> = chats
        .iter()
        .map(|c| ChatRef {
            id: c.id.clone(),
            agent: c.agent.clone(),
            title: c.title.clone(),
        })
        .collect();

    // Find current index
    let current_id = state
        .active_chats
        .get(&(slot.project_id.clone(), slot.task_id.clone()));

    let current_idx = current_id
        .and_then(|cid| available_chats.iter().position(|c| c.id == *cid))
        .unwrap_or(0);

    let new_idx = match direction {
        "next" => (current_idx + 1) % available_chats.len(),
        "prev" => {
            if current_idx == 0 {
                available_chats.len() - 1
            } else {
                current_idx - 1
            }
        }
        _ => current_idx,
    };

    let active_chat = available_chats.get(new_idx).cloned();

    // Update state
    if let Some(ref chat) = active_chat {
        state.active_chats.insert(
            (slot.project_id.clone(), slot.task_id.clone()),
            chat.id.clone(),
        );
    }

    Some(ServerMessage::ChatInfo {
        position,
        active_chat,
        available_chats,
    })
}

/// Poll status changes for known tasks without rebuilding the full snapshot.
/// New tasks are picked up via GroupChanged events which trigger a full snapshot
/// rebuild and update `last_statuses` in the WS loop.
fn poll_task_statuses(
    last_statuses: &mut HashMap<(String, String), String>,
    tx: &mpsc::UnboundedSender<ServerMessage>,
) {
    for (key, prev_status) in last_statuses.iter_mut() {
        let current = check_agent_status(&key.0, &key.1);
        if *prev_status != current {
            let _ = tx.send(ServerMessage::TaskStatus {
                project_id: key.0.clone(),
                task_id: key.1.clone(),
                agent_status: current.clone(),
            });
            *prev_status = current;
        }
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/// Find a TaskSlot from pre-loaded groups (avoids repeated disk reads).
fn find_slot_in(groups: &[taskgroups::TaskGroup], group_id: &str, position: u16) -> Option<taskgroups::TaskSlot> {
    groups
        .iter()
        .find(|g| g.id == group_id)
        .and_then(|g| g.slots.iter().find(|s| s.position == position).cloned())
}

// ─── Radio Server Endpoints ───────────────────────────────────────────────

/// POST /radio/start — Start the independent Radio server, return connection info + QR code
pub async fn start_radio() -> axum::response::Json<serde_json::Value> {
    // Check if audio transcription is enabled and configured
    let audio_settings = crate::storage::ai::load_audio_global();
    if !audio_settings.enabled {
        return axum::response::Json(serde_json::json!({
            "error": "transcribe_not_configured",
            "message": "Audio transcription is not enabled. Please enable it in Settings → AI → Audio first.",
        }));
    }
    let providers = crate::storage::ai::load_providers();
    let has_transcribe = providers.providers.iter().any(|p| {
        p.id == audio_settings.transcribe_provider || p.name == audio_settings.transcribe_provider
    });
    if !has_transcribe {
        return axum::response::Json(serde_json::json!({
            "error": "transcribe_not_configured",
            "message": "Audio transcription provider is not configured. Please set up a provider in Settings → AI → Audio first.",
        }));
    }

    match crate::api::radio_server::start().await {
        Ok(info) => {
            let lan_ip = crate::api::get_lan_ip();
            let host = lan_ip.unwrap_or_else(|| "localhost".to_string());
            let url = format!("https://{}:{}/#token={}", host, info.port, info.token);

            // Generate QR code as SVG
            let qr_svg = match qrcode::QrCode::new(&url) {
                Ok(code) => {
                    let svg = code
                        .render::<qrcode::render::svg::Color>()
                        .min_dimensions(200, 200)
                        .quiet_zone(true)
                        .build();
                    Some(svg)
                }
                Err(_) => None,
            };

            axum::response::Json(serde_json::json!({
                "url": url,
                "port": info.port,
                "token": info.token,
                "host": host,
                "qr_svg": qr_svg,
            }))
        }
        Err(e) => axum::response::Json(serde_json::json!({
            "error": e,
        })),
    }
}

/// POST /radio/stop — Stop the independent Radio server
pub async fn stop_radio() -> axum::response::Json<serde_json::Value> {
    crate::api::radio_server::stop().await;
    axum::response::Json(serde_json::json!({
        "status": "stopped",
    }))
}

/// GET /radio/status — Check if the Radio server is running
pub async fn radio_status() -> axum::response::Json<serde_json::Value> {
    match crate::api::radio_server::info().await {
        Some(info) => {
            let lan_ip = crate::api::get_lan_ip();
            let host = lan_ip.unwrap_or_else(|| "localhost".to_string());
            let url = format!("https://{}:{}/#token={}", host, info.port, info.token);
            axum::response::Json(serde_json::json!({
                "running": true,
                "url": url,
                "port": info.port,
                "token": info.token,
                "host": host,
            }))
        }
        None => axum::response::Json(serde_json::json!({
            "running": false,
        })),
    }
}

// ─── Desktop Radio Events WebSocket ────────────────────────────────────────

/// GET /radio/events/ws — Desktop Blitz subscribes to radio control events.
/// Receives RadioEvent messages when the phone user taps/sends on the Radio page.
pub async fn radio_events_ws_handler(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(handle_radio_events_ws)
}

async fn handle_radio_events_ws(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = RADIO_EVENTS.subscribe();

    use futures::{SinkExt, StreamExt};

    // Send current Radio client count immediately on connect
    let count_event = RadioEvent::ClientCount {
        count: radio_client_count(),
    };
    if let Ok(json) = serde_json::to_string(&count_event) {
        let _ = ws_tx.send(Message::Text(json.into())).await;
    }

    loop {
        tokio::select! {
            // Forward radio events to desktop client
            result = event_rx.recv() => {
                match result {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Dropped some events, continue
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // Listen for close from client
            maybe_msg = ws_rx.next() => {
                match maybe_msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_message_deserialization() {
        // SwitchGroup
        let json = r#"{"type":"switch_group","group_id":"g1"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ClientMessage::SwitchGroup { group_id } if group_id == "g1"));

        // SelectTask
        let json = r#"{"type":"select_task","group_id":"g1","position":3}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(
            matches!(msg, ClientMessage::SelectTask { group_id, position } if group_id == "g1" && position == 3)
        );

        // SendPrompt with chat_id
        let json =
            r#"{"type":"send_prompt","group_id":"g1","position":1,"text":"hello","chat_id":"c1"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(
            matches!(msg, ClientMessage::SendPrompt { text, chat_id, .. } if text == "hello" && chat_id == Some("c1".to_string()))
        );

        // SendPrompt without chat_id
        let json = r#"{"type":"send_prompt","group_id":"g1","position":1,"text":"hi"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ClientMessage::SendPrompt { chat_id, .. } if chat_id.is_none()));

        // SwitchChat
        let json = r#"{"type":"switch_chat","group_id":"g1","position":2,"direction":"next"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(msg, ClientMessage::SwitchChat { direction, .. } if direction == "next"));
    }

    #[test]
    fn test_server_message_serialization() {
        // PromptSent — ok
        let msg = ServerMessage::PromptSent {
            group_id: "g1".to_string(),
            position: 1,
            status: "ok".to_string(),
            error: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"prompt_sent""#));
        assert!(json.contains(r#""status":"ok""#));
        assert!(!json.contains("error")); // skip_serializing_if None

        // PromptSent — error
        let msg = ServerMessage::PromptSent {
            group_id: "g1".to_string(),
            position: 1,
            status: "error".to_string(),
            error: Some("chat not found".to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""error":"chat not found""#));

        // TaskStatus
        let msg = ServerMessage::TaskStatus {
            project_id: "p1".to_string(),
            task_id: "t1".to_string(),
            agent_status: "busy".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"task_status""#));
        assert!(json.contains(r#""agent_status":"busy""#));

        // ChatInfo
        let msg = ServerMessage::ChatInfo {
            position: 3,
            active_chat: Some(ChatRef {
                id: "c1".to_string(),
                agent: "claude".to_string(),
                title: "Chat 1".to_string(),
            }),
            available_chats: vec![],
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"chat_info""#));
        assert!(json.contains(r#""agent":"claude""#));
    }

    #[test]
    fn test_invalid_client_message() {
        // Unknown type
        let json = r#"{"type":"unknown_msg","data":"x"}"#;
        let result = serde_json::from_str::<ClientMessage>(json);
        assert!(result.is_err());

        // Missing required field
        let json = r#"{"type":"switch_group"}"#;
        let result = serde_json::from_str::<ClientMessage>(json);
        assert!(result.is_err());
    }
}
