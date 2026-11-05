//! The connection between two paired machines.
//!
//! One WebSocket per pair, opened by the side that added the pair, so a
//! machine with no reachable address can still pair with one that has. It
//! carries frames both ways, and its traffic is the heartbeat: a machine is
//! online exactly while a connection to it is alive.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message as ServerMessage, WebSocket};
use futures::{Sink, SinkExt, Stream, StreamExt};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, Error as ClientError, Message as ClientMessage,
};

use super::ProfilePatch;
use crate::storage::machines::{self as store, Peer, Profile};

const PING_EVERY: Duration = Duration::from_secs(15);
const SILENCE_LIMIT: Duration = Duration::from_secs(45);
const HELLO_LIMIT: Duration = Duration::from_secs(10);
const LONGEST_RETRY: Duration = Duration::from_secs(30);

/// What paired machines say to each other. Frames a machine doesn't know are
/// ignored, so a newer peer can add more.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    Hello {
        profile: Profile,
        version: String,
    },
    Profile {
        profile: Profile,
    },
    SetProfile(ProfilePatch),
    Unpair,
    /// Asks the machine for something; it answers with `Answer` and this id.
    Call {
        id: String,
        call: Call,
    },
    Answer {
        id: String,
        result: Result<serde_json::Value, String>,
    },
}

/// What one machine can ask another. A machine too old to know a call ignores
/// it, so the asker's time limit is the answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "call", rename_all = "snake_case")]
pub enum Call {
    Buddies,
    MessageBuddy(crate::buddy::chat::BuddyMessage),
}

struct Session {
    generation: u64,
    frames: mpsc::UnboundedSender<Frame>,
}

static GENERATIONS: AtomicU64 = AtomicU64::new(0);
static SESSIONS: Lazy<Mutex<HashMap<String, Vec<Session>>>> = Lazy::new(Mutex::default);
static LINKS: Lazy<Mutex<HashMap<String, JoinHandle<()>>>> = Lazy::new(Mutex::default);
/// Calls waiting on an answer, by machine and call id.
type Waiting = oneshot::Sender<Result<serde_json::Value, String>>;
static CALLS: Lazy<Mutex<HashMap<(String, String), Waiting>>> = Lazy::new(Mutex::default);
/// Why a machine refused us, until a connection succeeds.
static REFUSED: Lazy<Mutex<HashMap<String, &'static str>>> = Lazy::new(Mutex::default);
static VERSIONS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(Mutex::default);

fn lock<T>(mutex: &'static Lazy<Mutex<T>>) -> std::sync::MutexGuard<'static, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// `online`, `offline`, `signed_out` when the peer revoked this machine, or
/// `needs_login` when something in front of it wants a person to sign in.
pub fn status(id: &str) -> &'static str {
    if lock(&SESSIONS).get(id).is_some_and(|s| !s.is_empty()) {
        return "online";
    }
    lock(&REFUSED).get(id).copied().unwrap_or("offline")
}

fn refusal(status: u16) -> Option<&'static str> {
    match status {
        300..=399 => Some("needs_login"),
        401 => Some("signed_out"),
        _ => None,
    }
}

pub fn version(id: &str) -> Option<String> {
    lock(&VERSIONS).get(id).cloned()
}

/// Send a frame to a machine; false when it isn't connected.
pub fn send(id: &str, frame: Frame) -> bool {
    lock(&SESSIONS)
        .get(id)
        .and_then(|sessions| sessions.last())
        .is_some_and(|session| session.frames.send(frame).is_ok())
}

/// Machines before 0.14.3 ignore calls.
fn answers_no_calls(version: &str) -> bool {
    semver::Version::parse(version).is_ok_and(|version| version < semver::Version::new(0, 14, 3))
}

/// Ask a machine for something and wait for its answer.
pub async fn ask(machine: &str, call: Call, limit: Duration) -> Result<serde_json::Value, String> {
    if version(machine).is_some_and(|version| answers_no_calls(&version)) {
        return Err("That machine runs an older Grove; update it first".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let key = (machine.to_string(), id.clone());
    let (answer, answered) = oneshot::channel();
    lock(&CALLS).insert(key.clone(), answer);
    if !send(machine, Frame::Call { id, call }) {
        lock(&CALLS).remove(&key);
        return Err("That machine is offline".into());
    }
    let result = tokio::time::timeout(limit, answered).await;
    lock(&CALLS).remove(&key);
    match result {
        Ok(Ok(answer)) => answer,
        _ => Err("That machine did not answer; it may need updating".into()),
    }
}

async fn answer(machine: &str, call: Call) -> crate::error::Result<serde_json::Value> {
    match call {
        Call::Buddies => crate::buddy::chat::here(None),
        Call::MessageBuddy(message) => crate::buddy::chat::receive(machine, message).await,
    }
}

/// Tell every connected machine about this machine's new profile.
pub fn announce(profile: &Profile) {
    for sessions in lock(&SESSIONS).values() {
        if let Some(session) = sessions.last() {
            let _ = session.frames.send(Frame::Profile {
                profile: profile.clone(),
            });
        }
    }
}

fn register(id: &str) -> (u64, mpsc::UnboundedReceiver<Frame>) {
    let (frames, receiver) = mpsc::unbounded_channel();
    let generation = GENERATIONS.fetch_add(1, Ordering::Relaxed);
    lock(&SESSIONS)
        .entry(id.to_string())
        .or_default()
        .push(Session { generation, frames });
    lock(&REFUSED).remove(id);
    (generation, receiver)
}

fn unregister(id: &str, generation: u64) {
    let mut sessions = lock(&SESSIONS);
    if let Some(list) = sessions.get_mut(id) {
        list.retain(|session| session.generation != generation);
        if list.is_empty() {
            sessions.remove(id);
        }
    }
}

fn hello() -> crate::error::Result<Frame> {
    Ok(Frame::Hello {
        profile: super::this()?,
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

fn remember_profile(id: &str, profile: Profile) {
    // The id is who the connection belongs to; a frame can't change it.
    if profile.id != id {
        return;
    }
    if let Err(error) = store::update_peer(id, |peer| peer.profile = profile) {
        eprintln!("[Grove] could not update a paired machine: {error}");
    }
}

enum Ended {
    Closed,
    Unpaired,
}

/// Act on a frame from `id`; true when the pair is over.
fn receive(id: &str, frame: Frame) -> bool {
    match frame {
        Frame::Hello { profile, version } => {
            lock(&VERSIONS).insert(id.to_string(), version);
            remember_profile(id, profile);
        }
        Frame::Profile { profile } => remember_profile(id, profile),
        Frame::SetProfile(patch) => {
            if let Err(error) = super::update_this(&patch) {
                eprintln!("[Grove] ignored a machine profile change: {error}");
            }
        }
        Frame::Unpair => {
            if let Err(error) = super::forget(id) {
                eprintln!("[Grove] could not unpair a machine: {error}");
            }
            return true;
        }
        Frame::Call { id: call_id, call } => {
            // Answering can start an Agent, which must not hold up the heartbeat.
            let machine = id.to_string();
            tokio::spawn(async move {
                let result = answer(&machine, call).await.map_err(|e| e.to_string());
                send(
                    &machine,
                    Frame::Answer {
                        id: call_id,
                        result,
                    },
                );
            });
        }
        Frame::Answer {
            id: call_id,
            result,
        } => {
            if let Some(waiting) = lock(&CALLS).remove(&(id.to_string(), call_id)) {
                let _ = waiting.send(result);
            }
        }
    }
    false
}

/// One side's view of a socket, so both ends can share a loop.
enum Wire {
    Text(String),
    Ping,
    Traffic,
    Closed,
}

async fn drive<I, O>(
    id: &str,
    incoming: I,
    outgoing: O,
    mut frames: mpsc::UnboundedReceiver<Frame>,
) -> Ended
where
    I: Stream<Item = Wire>,
    O: Sink<Wire>,
{
    futures::pin_mut!(incoming, outgoing);
    let mut ping = tokio::time::interval(PING_EVERY);
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            wire = incoming.next() => match wire {
                Some(Wire::Text(text)) => {
                    heard = Instant::now();
                    if let Ok(frame) = serde_json::from_str::<Frame>(&text) {
                        if receive(id, frame) {
                            return Ended::Unpaired;
                        }
                    }
                }
                Some(Wire::Traffic | Wire::Ping) => heard = Instant::now(),
                _ => return Ended::Closed,
            },
            frame = frames.recv() => {
                let Some(frame) = frame else { return Ended::Closed };
                let leaving = matches!(frame, Frame::Unpair);
                let Ok(text) = serde_json::to_string(&frame) else { continue };
                if outgoing.send(Wire::Text(text)).await.is_err() {
                    return Ended::Closed;
                }
                if leaving {
                    return Ended::Unpaired;
                }
            }
            _ = ping.tick() => {
                if heard.elapsed() > SILENCE_LIMIT
                    || outgoing.send(Wire::Ping).await.is_err()
                {
                    return Ended::Closed;
                }
            }
        }
    }
}

// ─── The side that was connected to ─────────────────────────────────────────

/// A paired machine connected here. `device` is how it signed in.
pub async fn accept(socket: WebSocket, device: Option<String>) {
    let (outgoing, incoming) = socket.split();
    let mut incoming = incoming.map(|message| match message {
        Ok(ServerMessage::Text(text)) => Wire::Text(text.to_string()),
        Ok(ServerMessage::Ping(_) | ServerMessage::Pong(_) | ServerMessage::Binary(_)) => {
            Wire::Traffic
        }
        _ => Wire::Closed,
    });
    let outgoing = outgoing.with(|wire: Wire| {
        futures::future::ready(Ok::<_, axum::Error>(match wire {
            Wire::Text(text) => ServerMessage::Text(text.into()),
            _ => ServerMessage::Ping(Default::default()),
        }))
    });

    let first = tokio::time::timeout(HELLO_LIMIT, incoming.next()).await;
    let Ok(Some(Wire::Text(text))) = first else {
        return;
    };
    let Ok(Frame::Hello { profile, version }) = serde_json::from_str(&text) else {
        return;
    };
    let Ok(this) = super::this() else { return };
    if profile.id == this.id {
        return;
    }
    let id = profile.id.clone();
    if let Err(error) = remember_incoming(profile, device) {
        eprintln!("[Grove] could not record a paired machine: {error}");
        return;
    }
    lock(&VERSIONS).insert(id.clone(), version);

    let (generation, frames) = register(&id);
    if let Ok(hello) = hello() {
        send(&id, hello);
    }
    drive(&id, incoming, outgoing, frames).await;
    unregister(&id, generation);
}

fn remember_incoming(profile: Profile, device: Option<String>) -> crate::error::Result<()> {
    let id = profile.id.clone();
    if store::peer(&id)?.is_some() {
        store::update_peer(&id, |peer| {
            peer.profile = profile;
            // Keep a pair we added ourselves as it is: that record holds our key.
            if peer.url.is_none() {
                peer.device_id = device;
            }
        })?;
        return Ok(());
    }
    store::save_peer(Peer {
        url: None,
        device_id: device,
        device_key: None,
        proxy_port: None,
        headers: Default::default(),
        profile,
    })
}

// ─── The side that keeps the connection open ────────────────────────────────

/// Keep a connection to this machine, replacing any existing one.
pub fn connect(id: &str) {
    let owned = id.to_string();
    let task = tokio::spawn(async move { keep_connected(owned).await });
    if let Some(previous) = lock(&LINKS).insert(id.to_string(), task) {
        previous.abort();
    }
}

pub fn disconnect(id: &str) {
    if let Some(task) = lock(&LINKS).remove(id) {
        task.abort();
    }
    lock(&REFUSED).remove(id);
}

async fn keep_connected(id: String) {
    let mut wait = Duration::from_secs(1);
    loop {
        let Ok(Some(peer)) = store::peer(&id) else {
            return;
        };
        if peer.url.is_none() {
            return;
        }
        match hold(&peer).await {
            Ok(Ended::Unpaired) => return,
            Ok(Ended::Closed) => wait = Duration::from_secs(1),
            Err(error) => {
                if let ClientError::Http(response) = &*error {
                    if let Some(reason) = refusal(response.status().as_u16()) {
                        lock(&REFUSED).insert(id.clone(), reason);
                    }
                }
            }
        }
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(LONGEST_RETRY);
    }
}

fn request_for(
    peer: &Peer,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, Box<ClientError>> {
    let base = peer.url.as_deref().unwrap_or_default();
    let base = base
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let mut url = format!("{base}/api/v1/machines/link");
    if let Some(authorization) = super::authorization(peer) {
        url = crate::api::sign_ws_url(&url, &authorization);
    }
    let mut request = url.into_client_request().map_err(Box::new)?;
    for (name, value) in &peer.headers {
        if let (Ok(name), Ok(value)) = (
            axum::http::HeaderName::from_bytes(name.as_bytes()),
            axum::http::HeaderValue::from_str(value),
        ) {
            request.headers_mut().insert(name, value);
        }
    }
    Ok(request)
}

async fn hold(peer: &Peer) -> Result<Ended, Box<ClientError>> {
    let id = &peer.profile.id;
    let (socket, _) = tokio_tungstenite::connect_async(request_for(peer)?)
        .await
        .map_err(Box::new)?;
    let (outgoing, incoming) = socket.split();
    let incoming = incoming.map(|message| match message {
        Ok(ClientMessage::Text(text)) => Wire::Text(text.to_string()),
        Ok(ClientMessage::Close(_)) | Err(_) => Wire::Closed,
        Ok(_) => Wire::Traffic,
    });
    let outgoing = outgoing.with(|wire: Wire| {
        futures::future::ready(Ok::<_, ClientError>(match wire {
            Wire::Text(text) => ClientMessage::Text(text.into()),
            _ => ClientMessage::Ping(Default::default()),
        }))
    });
    let (generation, frames) = register(id);
    if let Ok(hello) = hello() {
        send(id, hello);
    }
    let ended = drive(id, incoming, outgoing, frames).await;
    unregister(id, generation);
    Ok(ended)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str) -> Profile {
        Profile {
            id: id.into(),
            name: "Dev box".into(),
            description: String::new(),
            icon: "server".into(),
        }
    }

    #[test]
    fn a_refused_connection_says_what_it_needs() {
        assert_eq!(refusal(302), Some("needs_login"));
        assert_eq!(refusal(401), Some("signed_out"));
        assert_eq!(refusal(502), None);
    }

    #[test]
    fn frames_keep_their_wire_format() {
        let text = serde_json::to_string(&Frame::SetProfile(ProfilePatch {
            name: Some("GPU".into()),
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(text, r#"{"type":"set_profile","name":"GPU"}"#);
        assert!(matches!(
            serde_json::from_str::<Frame>(r#"{"type":"unpair"}"#).unwrap(),
            Frame::Unpair
        ));
        assert!(serde_json::from_str::<Frame>(r#"{"type":"from_the_future"}"#).is_err());
    }

    #[tokio::test]
    async fn calls_are_answered_only_by_the_machine_asked() {
        let (session, mut frames) = register("link-test-call");
        let asking = tokio::spawn(ask("link-test-call", Call::Buddies, Duration::from_secs(5)));
        let Some(Frame::Call { id, .. }) = frames.recv().await else {
            panic!("expected a call");
        };
        let reply = Frame::Answer {
            id,
            result: Ok(serde_json::json!(["ada"])),
        };
        // The same id from another machine answers nothing.
        assert!(!receive("link-test-other", reply.clone()));
        assert!(!asking.is_finished());
        assert!(!receive("link-test-call", reply));
        assert_eq!(asking.await.unwrap().unwrap(), serde_json::json!(["ada"]));
        unregister("link-test-call", session);
    }

    #[test]
    fn older_machines_are_known_not_to_answer() {
        assert!(answers_no_calls("0.14.2"));
        assert!(!answers_no_calls("0.14.3"));
        assert!(!answers_no_calls("1.0.0"));
        assert!(!answers_no_calls("unknown"));
    }

    #[tokio::test]
    async fn calling_an_offline_or_silent_machine_fails() {
        assert!(ask("link-test-gone", Call::Buddies, Duration::from_secs(5))
            .await
            .unwrap_err()
            .contains("offline"));
        let (session, _frames) = register("link-test-silent");
        assert!(
            ask("link-test-silent", Call::Buddies, Duration::from_millis(10))
                .await
                .unwrap_err()
                .contains("did not answer")
        );
        unregister("link-test-silent", session);
    }

    #[test]
    fn a_machine_is_online_while_a_session_lives_and_prefers_the_newest() {
        let (older, mut older_frames) = register("link-test-a");
        let (newer, mut newer_frames) = register("link-test-a");
        assert_eq!(status("link-test-a"), "online");
        assert!(send("link-test-a", Frame::Unpair));
        assert!(newer_frames.try_recv().is_ok());
        assert!(older_frames.try_recv().is_err());
        unregister("link-test-a", newer);
        assert_eq!(status("link-test-a"), "online");
        unregister("link-test-a", older);
        assert_eq!(status("link-test-a"), "offline");
        assert!(!send("link-test-a", Frame::Unpair));
    }

    #[test]
    fn a_frame_cannot_rewrite_another_machines_record() {
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        remember_incoming(profile("peer"), Some("device".into())).unwrap();
        remember_profile("peer", profile("impostor"));
        assert_eq!(
            store::peer("peer").unwrap().unwrap().profile,
            profile("peer")
        );
        crate::storage::set_grove_dir_override(None);
    }

    #[test]
    fn a_machine_connecting_back_keeps_the_pair_we_added() {
        let dir = tempfile::tempdir().unwrap();
        crate::storage::set_grove_dir_override(Some(dir.path().to_path_buf()));
        store::save_peer(Peer {
            url: Some("http://devbox".into()),
            device_id: Some("ours".into()),
            device_key: Some("key".into()),
            proxy_port: None,
            headers: Default::default(),
            profile: profile("peer"),
        })
        .unwrap();
        remember_incoming(profile("peer"), Some("theirs".into())).unwrap();
        let peer = store::peer("peer").unwrap().unwrap();
        assert_eq!(peer.device_id.as_deref(), Some("ours"));
        assert_eq!(peer.device_key.as_deref(), Some("key"));
        crate::storage::set_grove_dir_override(None);
    }
}
