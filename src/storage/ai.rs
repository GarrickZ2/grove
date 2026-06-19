//! AI settings persistence (providers + audio)
//!
//! Uses SQLite tables: `ai_providers`, `audio_config`, `audio_config_project`,
//! `audio_terms`.

use rusqlite::params;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;

// ─── Provider Profile ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub status: String, // "verified" | "draft" | "failed"
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProvidersData {
    #[serde(default)]
    pub providers: Vec<ProviderProfile>,
}

pub fn load_providers() -> ProvidersData {
    let conn = crate::storage::database::connection();
    let mut stmt = match conn.prepare(
        "SELECT id, name, provider_type, base_url, api_key, model, status FROM ai_providers",
    ) {
        Ok(s) => s,
        Err(_) => return ProvidersData::default(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok(ProviderProfile {
            id: row.get(0)?,
            name: row.get(1)?,
            provider_type: row.get(2)?,
            base_url: row.get(3)?,
            api_key: row.get(4)?,
            model: row.get(5)?,
            status: row.get(6)?,
        })
    }) {
        Ok(r) => r,
        Err(_) => return ProvidersData::default(),
    };
    let providers: Vec<ProviderProfile> = rows.filter_map(|r| r.ok()).collect();
    ProvidersData { providers }
}

pub fn save_providers(data: &ProvidersData) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM ai_providers", [])?;
    for p in &data.providers {
        tx.execute(
            "INSERT INTO ai_providers (id, name, provider_type, base_url, api_key, model, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![p.id, p.name, p.provider_type, p.base_url, p.api_key, p.model, p.status],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn generate_provider_id() -> String {
    Uuid::new_v4().to_string()
}

// ─── Audio Settings ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplacementRule {
    pub from: String,
    pub to: String,
}

/// Global audio settings
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioSettingsGlobal {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub transcribe_provider: String,
    #[serde(default)]
    pub preferred_languages: Vec<String>,
    /// Combo key shortcut for toggle mode (e.g. "Cmd+Shift+.")
    #[serde(default)]
    pub toggle_shortcut: String,
    /// Single key for push-to-talk mode (e.g. "F5")
    #[serde(default)]
    pub push_to_talk_key: String,
    /// How long the PTT key must be held before recording starts (ms)
    #[serde(default = "default_ptt_activation_delay_ms")]
    pub ptt_activation_delay_ms: u32,
    /// Max recording duration in seconds
    #[serde(default = "default_max_duration")]
    pub max_duration: u32,
    /// Min recording duration in seconds (below = discard)
    #[serde(default = "default_min_duration")]
    pub min_duration: u32,
    #[serde(default)]
    pub revise_enabled: bool,
    #[serde(default)]
    pub revise_provider: String,
    #[serde(default)]
    pub revise_prompt: String,
    #[serde(default)]
    pub preferred_terms: Vec<String>,
    #[serde(default)]
    pub forbidden_terms: Vec<String>,
    #[serde(default)]
    pub replacements: Vec<ReplacementRule>,
    /// Transcription mode: "batch" (record then transcribe) or "streaming" (live).
    #[serde(default = "default_transcribe_mode")]
    pub transcribe_mode: String,
    /// OS-wide global voice mode (global shortcut + floating widget).
    #[serde(default)]
    pub global_mode_enabled: bool,
}

fn default_max_duration() -> u32 {
    60
}

fn default_min_duration() -> u32 {
    2
}

fn default_ptt_activation_delay_ms() -> u32 {
    500
}

fn default_transcribe_mode() -> String {
    "batch".to_string()
}

impl Default for AudioSettingsGlobal {
    fn default() -> Self {
        Self {
            enabled: false,
            transcribe_provider: String::new(),
            preferred_languages: Vec::new(),
            toggle_shortcut: String::new(),
            push_to_talk_key: String::new(),
            ptt_activation_delay_ms: default_ptt_activation_delay_ms(),
            max_duration: default_max_duration(),
            min_duration: default_min_duration(),
            revise_enabled: false,
            revise_provider: String::new(),
            revise_prompt: String::new(),
            preferred_terms: Vec::new(),
            forbidden_terms: Vec::new(),
            replacements: Vec::new(),
            transcribe_mode: default_transcribe_mode(),
            global_mode_enabled: false,
        }
    }
}

/// Project-level audio settings
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AudioSettingsProject {
    #[serde(default)]
    pub revise_prompt: String,
    #[serde(default)]
    pub preferred_terms: Vec<String>,
    #[serde(default)]
    pub forbidden_terms: Vec<String>,
    #[serde(default)]
    pub replacements: Vec<ReplacementRule>,
}

// ─── Audio Global ───────────────────────────────────────────────────────────

pub fn load_audio_global() -> AudioSettingsGlobal {
    let conn = crate::storage::database::connection();
    let config = crate::storage::config::load_config();

    // Load global terms (project_hash IS NULL)
    let mut preferred_terms = Vec::new();
    let mut forbidden_terms = Vec::new();
    let mut replacements = Vec::new();

    if let Ok(mut stmt) = conn
        .prepare("SELECT type, from_term, target_term FROM audio_terms WHERE project_hash IS NULL")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            let term_type: String = row.get(0)?;
            let from_term: Option<String> = row.get(1)?;
            let target_term: String = row.get(2)?;
            Ok((term_type, from_term, target_term))
        }) {
            for row in rows.flatten() {
                match row.0.as_str() {
                    "prefer" => preferred_terms.push(row.2),
                    "forbidden" => forbidden_terms.push(row.2),
                    "replace" => replacements.push(ReplacementRule {
                        from: row.1.unwrap_or_default(),
                        to: row.2,
                    }),
                    _ => {}
                }
            }
        }
    }

    AudioSettingsGlobal {
        enabled: config.audio.enabled,
        transcribe_provider: config.audio.transcribe_provider.clone(),
        preferred_languages: config.audio.preferred_languages.clone(),
        toggle_shortcut: config.audio.toggle_shortcut.clone(),
        push_to_talk_key: config.audio.push_to_talk_key.clone(),
        ptt_activation_delay_ms: config.audio.ptt_activation_delay_ms,
        max_duration: config.audio.max_duration,
        min_duration: config.audio.min_duration,
        revise_enabled: config.audio.revise_enabled,
        revise_provider: config.audio.revise_provider.clone(),
        revise_prompt: config.audio.revise_prompt_global.clone(),
        preferred_terms,
        forbidden_terms,
        replacements,
        transcribe_mode: config.audio.transcribe_mode.clone(),
        global_mode_enabled: config.audio.global_mode_enabled,
    }
}

pub fn save_audio_global(data: &AudioSettingsGlobal) -> Result<()> {
    let conn = crate::storage::database::connection();

    // 1. Save settings to config.toml
    let mut config = crate::storage::config::load_config();
    config.audio.enabled = data.enabled;
    config.audio.transcribe_provider = data.transcribe_provider.clone();
    config.audio.toggle_shortcut = data.toggle_shortcut.clone();
    config.audio.push_to_talk_key = data.push_to_talk_key.clone();
    config.audio.max_duration = data.max_duration;
    config.audio.min_duration = data.min_duration;
    config.audio.revise_enabled = data.revise_enabled;
    config.audio.revise_provider = data.revise_provider.clone();
    config.audio.revise_prompt_global = data.revise_prompt.clone();
    config.audio.preferred_languages = data.preferred_languages.clone();
    config.audio.transcribe_mode = data.transcribe_mode.clone();
    config.audio.global_mode_enabled = data.global_mode_enabled;
    config.audio.ptt_activation_delay_ms = data.ptt_activation_delay_ms;
    crate::storage::config::save_config(&config)?;

    // 2. Save terms to SQLite
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM audio_terms WHERE project_hash IS NULL", [])?;

    for term in &data.preferred_terms {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (NULL, 'prefer', NULL, ?1)",
            params![term],
        )?;
    }

    for term in &data.forbidden_terms {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (NULL, 'forbidden', NULL, ?1)",
            params![term],
        )?;
    }

    for rule in &data.replacements {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (NULL, 'replace', ?1, ?2)",
            params![rule.from, rule.to],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ─── Voice Control Config ───────────────────────────────────────────────────

pub fn load_voice_control() -> crate::storage::config::VoiceControlConfig {
    let conn = crate::storage::database::connection();

    let row = conn.query_row(
        "SELECT enabled, stt_provider_id, stt_model, llm_provider_id, llm_model,
                toggle_shortcut, push_to_talk_key, ptt_activation_delay_ms,
                max_duration, min_duration, preferred_languages, disabled_actions,
                has_initialized_actions
         FROM voice_control_config WHERE id = 1",
        [],
        |row| {
            Ok((
                row.get::<_, bool>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, u32>(7)?,
                row.get::<_, u32>(8)?,
                row.get::<_, u32>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, bool>(12)?,
            ))
        },
    );

    match row {
        Ok((
            enabled,
            stt_provider_id,
            stt_model,
            llm_provider_id,
            llm_model,
            toggle_shortcut,
            push_to_talk_key,
            ptt_activation_delay_ms,
            max_duration,
            min_duration,
            preferred_languages_json,
            disabled_actions_json,
            has_initialized_actions,
        )) => {
            let preferred_languages =
                serde_json::from_str(&preferred_languages_json).unwrap_or_default();
            let disabled_actions = serde_json::from_str(&disabled_actions_json).unwrap_or_default();
            crate::storage::config::VoiceControlConfig {
                enabled,
                stt_provider_id,
                stt_model,
                llm_provider_id,
                llm_model,
                toggle_shortcut,
                push_to_talk_key,
                ptt_activation_delay_ms,
                max_duration,
                min_duration,
                preferred_languages,
                disabled_actions,
                has_initialized_actions,
            }
        }
        Err(_) => {
            // No row yet: release the connection lock BEFORE calling save_voice_control,
            // which also needs the same mutex. std::sync::Mutex is not reentrant.
            drop(conn);
            let legacy = crate::storage::config::load_config().voice_control.clone();
            let _ = save_voice_control(&legacy);
            legacy
        }
    }
}

pub fn save_voice_control(data: &crate::storage::config::VoiceControlConfig) -> Result<()> {
    let conn = crate::storage::database::connection();
    let preferred_languages_json =
        serde_json::to_string(&data.preferred_languages).unwrap_or_else(|_| "[]".to_string());
    let disabled_actions_json =
        serde_json::to_string(&data.disabled_actions).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO voice_control_config (id, enabled, stt_provider_id, stt_model,
            llm_provider_id, llm_model, toggle_shortcut, push_to_talk_key,
            ptt_activation_delay_ms, max_duration, min_duration,
            preferred_languages, disabled_actions, has_initialized_actions)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            enabled = excluded.enabled,
            stt_provider_id = excluded.stt_provider_id,
            stt_model = excluded.stt_model,
            llm_provider_id = excluded.llm_provider_id,
            llm_model = excluded.llm_model,
            toggle_shortcut = excluded.toggle_shortcut,
            push_to_talk_key = excluded.push_to_talk_key,
            ptt_activation_delay_ms = excluded.ptt_activation_delay_ms,
            max_duration = excluded.max_duration,
            min_duration = excluded.min_duration,
            preferred_languages = excluded.preferred_languages,
            disabled_actions = excluded.disabled_actions,
            has_initialized_actions = excluded.has_initialized_actions",
        params![
            data.enabled,
            data.stt_provider_id,
            data.stt_model,
            data.llm_provider_id,
            data.llm_model,
            data.toggle_shortcut,
            data.push_to_talk_key,
            data.ptt_activation_delay_ms,
            data.max_duration,
            data.min_duration,
            preferred_languages_json,
            disabled_actions_json,
            data.has_initialized_actions,
        ],
    )?;
    Ok(())
}

// ─── Audio Project ──────────────────────────────────────────────────────────

pub fn load_audio_project(project_hash: &str) -> AudioSettingsProject {
    let conn = crate::storage::database::connection();

    let revise_prompt: String = conn
        .query_row(
            "SELECT revise_prompt FROM audio_config_project WHERE project_hash = ?1",
            params![project_hash],
            |row| row.get(0),
        )
        .unwrap_or_default();

    // Load project terms
    let mut preferred_terms = Vec::new();
    let mut forbidden_terms = Vec::new();
    let mut replacements = Vec::new();

    if let Ok(mut stmt) =
        conn.prepare("SELECT type, from_term, target_term FROM audio_terms WHERE project_hash = ?1")
    {
        if let Ok(rows) = stmt.query_map(params![project_hash], |row| {
            let term_type: String = row.get(0)?;
            let from_term: Option<String> = row.get(1)?;
            let target_term: String = row.get(2)?;
            Ok((term_type, from_term, target_term))
        }) {
            for row in rows.flatten() {
                match row.0.as_str() {
                    "prefer" => preferred_terms.push(row.2),
                    "forbidden" => forbidden_terms.push(row.2),
                    "replace" => replacements.push(ReplacementRule {
                        from: row.1.unwrap_or_default(),
                        to: row.2,
                    }),
                    _ => {}
                }
            }
        }
    }

    AudioSettingsProject {
        revise_prompt,
        preferred_terms,
        forbidden_terms,
        replacements,
    }
}

pub fn save_audio_project(project_hash: &str, data: &AudioSettingsProject) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "INSERT OR REPLACE INTO audio_config_project (project_hash, revise_prompt) VALUES (?1, ?2)",
        params![project_hash, data.revise_prompt],
    )?;

    tx.execute(
        "DELETE FROM audio_terms WHERE project_hash = ?1",
        params![project_hash],
    )?;

    for term in &data.preferred_terms {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (?1, 'prefer', NULL, ?2)",
            params![project_hash, term],
        )?;
    }

    for term in &data.forbidden_terms {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (?1, 'forbidden', NULL, ?2)",
            params![project_hash, term],
        )?;
    }

    for rule in &data.replacements {
        tx.execute(
            "INSERT INTO audio_terms (project_hash, type, from_term, target_term) VALUES (?1, 'replace', ?2, ?3)",
            params![project_hash, rule.from, rule.to],
        )?;
    }

    tx.commit()?;
    Ok(())
}
