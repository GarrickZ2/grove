//! Streaming speech-to-text over WebSocket.
//!
//! Reuses the existing batch Whisper endpoint (`call_transcription_api`) but
//! drives it in a streaming fashion at the algorithm layer:
//!
//! - The browser captures PCM via an AudioWorklet, resamples to 16 kHz mono,
//!   and streams raw `f32` frames as binary WS messages.
//! - The backend keeps a growing PCM buffer for the **current sentence**. Every
//!   ~1 s of new audio it re-transcribes the whole current sentence and pushes
//!   an `Update` whose `current` field *replaces* the previously shown text —
//!   so earlier mis-recognized words get corrected live ("full refresh until
//!   final").
//! - A simple energy VAD splits speech into sentences. When trailing silence
//!   exceeds a threshold the current sentence is **finalized** (frozen into the
//!   `finalized` list) and the buffer is cleared, so re-transcription cost stays
//!   bounded to the current sentence.
//! - On `flush` (user released the shortcut) we run one last transcription,
//!   assemble the full text, optionally revise it once, and send `Done`.
//!
//! See `docs`/the plan for the rationale; this deliberately avoids token-level
//! LocalAgreement commit because the product wants the whole current sentence
//! to stay refreshable until it's spoken out.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::Query;
use axum::response::Response;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use super::ai::{build_revision_prompt, call_revision_api, call_transcription_api};
use crate::storage::ai;

// ─── Tunable algorithm parameters ───────────────────────────────────────────

/// Target sample rate (the worklet resamples to this before sending).
const SAMPLE_RATE: u32 = 16_000;
/// Re-transcribe once this many new samples have arrived (~1 s).
const MIN_CHUNK_SAMPLES: usize = SAMPLE_RATE as usize;
/// RMS below this is considered silence (~-40 dB).
const SILENCE_RMS: f32 = 0.01;
/// Trailing silence this long finalizes the current sentence (~700 ms).
const SILENCE_HOLD_SAMPLES: usize = (SAMPLE_RATE as usize) * 7 / 10;
/// Hard cap — finalize even without silence so the buffer can't grow forever (~30 s).
const MAX_BUFFER_SAMPLES: usize = (SAMPLE_RATE as usize) * 30;

// ─── Wire messages ──────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMsg {
    /// User released the shortcut — finish up and send `Done`.
    Flush,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ServerMsg {
    /// Sent once the session is ready to receive audio.
    Ready,
    /// Live transcript: stable finalized sentences + the (replaceable) current one.
    Update {
        finalized: Vec<String>,
        current: String,
    },
    /// Terminal message after flush: the assembled full text + optional revision.
    Done {
        full: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        revised: Option<String>,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct StreamQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    // ── Optional algorithm tuning (hot-tunable from the client; falls back to
    //    the constants above so you can iterate without recompiling). ──
    /// Re-transcribe once this many ms of new audio arrives (default 1000).
    #[serde(default)]
    pub min_chunk_ms: Option<u32>,
    /// RMS silence threshold (default 0.01).
    #[serde(default)]
    pub silence_rms: Option<f32>,
    /// Trailing silence (ms) that finalizes a sentence (default 700).
    #[serde(default)]
    pub silence_hold_ms: Option<u32>,
    /// Hard buffer cap (ms) that forces finalization (default 30000).
    #[serde(default)]
    pub max_buffer_ms: Option<u32>,
    /// Refresh the current sentence on every chunk (default true). Set false to
    /// transcribe only on sentence boundaries / flush — far fewer API calls.
    #[serde(default)]
    pub intra_refresh: Option<bool>,
}

fn ms_to_samples(ms: u32) -> usize {
    (ms as usize) * (SAMPLE_RATE as usize) / 1000
}

// ─── A transcription round's result, delivered back to the select loop ───────

struct TranscribeResult {
    text: String,
    /// How many samples were in the snapshot that produced `text`.
    snapshot_len: usize,
    /// Freeze the current sentence after applying this result.
    will_finalize: bool,
    /// Assemble + revise + send `Done` after applying this result.
    will_flush: bool,
    /// Carries an error string instead of text (transcription API failed).
    error: Option<String>,
}

// ─── WebSocket upgrade handler ──────────────────────────────────────────────

/// GET /api/v1/ai/transcribe-stream
pub async fn transcribe_stream_ws_handler(
    Query(params): Query<StreamQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    ws.on_upgrade(move |socket| handle_stream(socket, params))
}

/// Snapshot of provider config taken at connect time (so blocking calls don't
/// need to touch storage).
struct Provider {
    base_url: String,
    api_key: String,
    model: String,
    language: Option<String>,
}

struct Session {
    provider: Provider,
    global: ai::AudioSettingsGlobal,
    project: Option<ai::AudioSettingsProject>,

    // Algorithm tuning (resolved from query params or the default constants).
    min_chunk_samples: usize,
    silence_rms: f32,
    silence_hold_samples: usize,
    max_buffer_samples: usize,
    /// Whether to re-transcribe the current sentence between boundaries.
    intra_refresh: bool,
    /// Ticks remaining in an error backoff (e.g. after a 429). 0 = none.
    cooldown_ticks: u32,

    /// PCM for the sentence currently being spoken (16 kHz mono f32).
    buffer: Vec<f32>,
    /// Sentences already frozen (stable, never rewritten).
    finalized: Vec<String>,
    /// Latest transcription of the current sentence (replaceable).
    current: String,

    samples_at_last_transcribe: usize,
    trailing_silence: usize,
    /// Whether the current sentence has contained any non-silent audio.
    has_voice: bool,

    in_flight: bool,
    pending_finalize: bool,
    pending_flush: bool,
    done: bool,

    msg_tx: mpsc::UnboundedSender<String>,
    result_tx: mpsc::UnboundedSender<TranscribeResult>,
}

impl Session {
    /// Append a freshly received PCM frame and update VAD state.
    fn ingest(&mut self, pcm: &[f32]) {
        if pcm.is_empty() {
            return;
        }
        let rms = samples_rms(pcm);
        if rms < self.silence_rms {
            self.trailing_silence += pcm.len();
        } else {
            self.trailing_silence = 0;
            self.has_voice = true;
        }
        self.buffer.extend_from_slice(pcm);

        // Finalize on a long silent tail, or hard-cap the buffer.
        if self.has_voice
            && (self.trailing_silence >= self.silence_hold_samples
                || self.buffer.len() >= self.max_buffer_samples)
        {
            self.pending_finalize = true;
        }
    }

    fn send(&self, msg: ServerMsg) {
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = self.msg_tx.send(json);
        }
    }

    fn send_update(&self) {
        self.send(ServerMsg::Update {
            finalized: self.finalized.clone(),
            current: self.current.clone(),
        });
    }

    /// Decide and kick off the next action. Idempotent — safe to call after any
    /// state change; the 250 ms tick also calls it so multi-step flows settle.
    async fn pump(&mut self) {
        if self.in_flight || self.done {
            return;
        }
        if self.cooldown_ticks > 0 {
            // Backing off after a transcription error (e.g. 429). Don't hammer
            // the API; if the user is flushing, finish with what we have.
            if self.pending_flush {
                self.finish_done().await;
            }
            return;
        }
        let new_since = self
            .buffer
            .len()
            .saturating_sub(self.samples_at_last_transcribe);

        // Intra-sentence refresh is optional (off → far fewer API calls);
        // finalize and flush always transcribe so sentences still get captured.
        let want_regular = new_since >= self.min_chunk_samples && self.intra_refresh;
        if self.has_voice
            && (want_regular || self.pending_finalize || (self.pending_flush && new_since > 0))
        {
            self.start_transcribe();
            return;
        }

        // Finalize a silence-only stretch (no voice) — just reset, no API call.
        if self.pending_finalize {
            self.reset_sentence();
            self.pending_finalize = false;
            self.send_update();
        }

        // Flush with nothing left to transcribe — assemble and finish.
        if self.pending_flush {
            self.finish_done().await;
        }
    }

    /// Spawn a blocking transcription of the current buffer snapshot.
    fn start_transcribe(&mut self) {
        let snapshot: Vec<f32> = self.buffer.clone();
        let snapshot_len = snapshot.len();
        let will_finalize = self.pending_finalize;
        let will_flush = self.pending_flush;

        self.in_flight = true;
        // NB: don't mark `samples_at_last_transcribe` here. We only advance it
        // when the round *succeeds* (in apply_result); on error the old value is
        // kept so the failed audio is retried after the cooldown instead of
        // being skipped.

        let base_url = self.provider.base_url.clone();
        let api_key = self.provider.api_key.clone();
        let model = self.provider.model.clone();
        let language = self.provider.language.clone();
        let tx = self.result_tx.clone();

        tokio::task::spawn_blocking(move || {
            let wav = pcm_to_wav(&snapshot, SAMPLE_RATE);
            let outcome = call_transcription_api(
                &base_url,
                &api_key,
                &model,
                &wav,
                "chunk.wav",
                language.as_deref(),
            );
            let result = match outcome {
                Ok(text) => TranscribeResult {
                    text,
                    snapshot_len,
                    will_finalize,
                    will_flush,
                    error: None,
                },
                Err(e) => TranscribeResult {
                    text: String::new(),
                    snapshot_len,
                    will_finalize,
                    will_flush,
                    error: Some(e),
                },
            };
            let _ = tx.send(result);
        });
    }

    /// Apply a finished transcription round.
    async fn apply_result(&mut self, result: TranscribeResult) {
        self.in_flight = false;

        if let Some(err) = result.error {
            eprintln!("[transcribe-stream] transcription error: {}", err);
            // Back off so we don't hammer the API (especially 429 rate limits) —
            // ~4s at 250ms/tick. The next pump after cooldown retries.
            self.cooldown_ticks = 16;
            // Don't kill the session on a transient error; keep listening.
            // But if the user was flushing, finish with what we have.
            if result.will_flush {
                self.finish_done().await;
            }
            return;
        }

        self.current = result.text.trim().to_string();
        // Round succeeded — advance the watermark so the next `new_since` only
        // counts audio that arrived after this snapshot.
        self.samples_at_last_transcribe = result.snapshot_len;
        self.send_update();

        if result.will_finalize {
            if !self.current.is_empty() {
                self.finalized.push(self.current.clone());
            }
            // Drop the finalized audio but keep anything that arrived mid-round
            // (the start of the next sentence).
            let drain = result.snapshot_len.min(self.buffer.len());
            self.buffer.drain(0..drain);
            self.samples_at_last_transcribe = 0;
            self.current.clear();
            self.trailing_silence = 0;
            // Only the buffer tail (~100 ms) — a long silent carry-over would
            // otherwise average a brief voice onset below threshold.
            let tail_start = self.buffer.len().saturating_sub(1600);
            self.has_voice = samples_rms(&self.buffer[tail_start..]) >= self.silence_rms;
            self.pending_finalize = false;
            self.send_update();
        }

        if result.will_flush {
            self.finish_done().await;
            return;
        }

        // Re-evaluate in case a flush/finalize landed while in flight.
        Box::pin(self.pump()).await;
    }

    /// Assemble the full transcript, optionally revise once, send `Done`, stop.
    async fn finish_done(&mut self) {
        let mut parts = self.finalized.clone();
        if !self.current.trim().is_empty() {
            parts.push(self.current.clone());
        }
        let full = parts.join(" ").trim().to_string();

        let revised = self.maybe_revise(&full).await;
        self.send(ServerMsg::Done { full, revised });
        self.done = true;
    }

    /// Run the revision pass once over the full text, if enabled & configured.
    async fn maybe_revise(&self, full: &str) -> Option<String> {
        if !self.global.revise_enabled || full.is_empty() {
            return None;
        }
        let providers = ai::load_providers();
        let provider = providers
            .providers
            .iter()
            .find(|p| p.id == self.global.revise_provider)
            .or_else(|| {
                providers
                    .providers
                    .iter()
                    .find(|p| p.name == self.global.revise_provider)
            })?;

        let system_prompt = build_revision_prompt(&self.global, self.project.as_ref(), full);
        let base_url = provider.base_url.clone();
        let api_key = provider.api_key.clone();
        let model = provider.model.clone();
        let transcript = full.to_string();

        tokio::task::spawn_blocking(move || {
            call_revision_api(&base_url, &api_key, &model, &system_prompt, &transcript)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
    }

    fn reset_sentence(&mut self) {
        self.buffer.clear();
        self.current.clear();
        self.samples_at_last_transcribe = 0;
        self.trailing_silence = 0;
        self.has_voice = false;
    }
}

async fn handle_stream(socket: WebSocket, params: StreamQuery) {
    use futures::{SinkExt, StreamExt};
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Resolve provider config up front so the blocking calls are self-contained.
    let global = ai::load_audio_global();
    let project = params.project_id.as_deref().map(ai::load_audio_project);
    let providers = ai::load_providers();
    let provider = providers
        .providers
        .iter()
        .find(|p| p.id == global.transcribe_provider)
        .or_else(|| {
            providers
                .providers
                .iter()
                .find(|p| p.name == global.transcribe_provider)
        });

    let provider = match provider {
        Some(p) => Provider {
            base_url: p.base_url.clone(),
            api_key: p.api_key.clone(),
            model: p.model.clone(),
            language: global.preferred_languages.first().cloned(),
        },
        None => {
            let err = ServerMsg::Error {
                message: "Transcription provider not configured".to_string(),
            };
            if let Ok(json) = serde_json::to_string(&err) {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            return;
        }
    };

    let (msg_tx, mut msg_rx) = mpsc::unbounded_channel::<String>();
    let (result_tx, mut result_rx) = mpsc::unbounded_channel::<TranscribeResult>();

    let mut session = Session {
        provider,
        global,
        project,
        min_chunk_samples: params
            .min_chunk_ms
            .map(ms_to_samples)
            .unwrap_or(MIN_CHUNK_SAMPLES),
        silence_rms: params.silence_rms.unwrap_or(SILENCE_RMS),
        silence_hold_samples: params
            .silence_hold_ms
            .map(ms_to_samples)
            .unwrap_or(SILENCE_HOLD_SAMPLES),
        max_buffer_samples: params
            .max_buffer_ms
            .map(ms_to_samples)
            .unwrap_or(MAX_BUFFER_SAMPLES),
        intra_refresh: params.intra_refresh.unwrap_or(true),
        cooldown_ticks: 0,
        buffer: Vec::new(),
        finalized: Vec::new(),
        current: String::new(),
        samples_at_last_transcribe: 0,
        trailing_silence: 0,
        has_voice: false,
        in_flight: false,
        pending_finalize: false,
        pending_flush: false,
        done: false,
        msg_tx,
        result_tx,
    };

    session.send(ServerMsg::Ready);

    let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // Outgoing messages (from pump / result handling).
            Some(json) = msg_rx.recv() => {
                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }

            // Incoming audio / control.
            maybe_msg = ws_rx.next() => {
                match maybe_msg {
                    Some(Ok(Message::Binary(bytes))) => {
                        let pcm = bytes_to_pcm(&bytes);
                        session.ingest(&pcm);
                        session.pump().await;
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(ClientMsg::Flush) = serde_json::from_str::<ClientMsg>(&text) {
                            session.pending_flush = true;
                            session.pump().await;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }

            // A transcription round finished.
            Some(result) = result_rx.recv() => {
                session.apply_result(result).await;
            }

            // Periodic nudge so chunk/finalize/flush flows settle.
            _ = tick.tick() => {
                if session.cooldown_ticks > 0 {
                    session.cooldown_ticks -= 1;
                }
                session.pump().await;
            }
        }

        if session.done {
            // Drain any final queued messages (Done) before closing.
            while let Ok(json) = msg_rx.try_recv() {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            // Send an explicit Close frame so the client sees a clean (1000)
            // closure instead of an abnormal 1006 — otherwise the browser fires
            // `onerror` right after `done` and the UI flashes "Connection error".
            let _ = ws_tx.send(Message::Close(None)).await;
            break;
        }
    }
}

// ─── Audio helpers ──────────────────────────────────────────────────────────

/// Decode a binary WS frame of little-endian `f32` samples into PCM.
fn bytes_to_pcm(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .collect()
}

/// RMS amplitude of a PCM slice (0.0 for empty).
fn samples_rms(pcm: &[f32]) -> f32 {
    if pcm.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = pcm.iter().map(|x| x * x).sum();
    (sum_sq / pcm.len() as f32).sqrt()
}

/// Encode 16 kHz mono f32 PCM into an in-memory 16-bit WAV file.
fn pcm_to_wav(pcm: &[f32], sample_rate: u32) -> Vec<u8> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = match hound::WavWriter::new(&mut cursor, spec) {
            Ok(w) => w,
            Err(_) => return Vec::new(),
        };
        for &s in pcm {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            let _ = writer.write_sample(v);
        }
        let _ = writer.finalize();
    }
    cursor.into_inner()
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(samples_rms(&[]), 0.0);
        assert_eq!(samples_rms(&[0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn rms_of_full_scale_is_one() {
        let s = [1.0, -1.0, 1.0, -1.0];
        assert!((samples_rms(&s) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn pcm_to_wav_has_riff_header() {
        // 1600 samples = 100 ms @ 16 kHz
        let pcm: Vec<f32> = (0..1600).map(|i| (i as f32 * 0.02).sin() * 0.5).collect();
        let wav = pcm_to_wav(&pcm, SAMPLE_RATE);
        assert!(wav.len() > 44, "wav must include header + data");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        // 16-bit mono → 2 bytes per sample of data.
        assert!(wav.len() >= 44 + pcm.len() * 2);
    }

    #[test]
    fn bytes_roundtrip_to_pcm() {
        let samples = [0.0f32, 0.5, -0.5, 1.0];
        let mut bytes = Vec::new();
        for s in &samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let pcm = bytes_to_pcm(&bytes);
        assert_eq!(pcm, samples);
    }

    #[test]
    fn bytes_to_pcm_ignores_trailing_partial_sample() {
        // 5 bytes = one full f32 + 1 stray byte → one sample, no panic.
        let bytes = [0u8, 0, 0, 0, 7];
        assert_eq!(bytes_to_pcm(&bytes).len(), 1);
    }
}
