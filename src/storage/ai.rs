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

    // Load main config row
    let config_result = conn.query_row(
        "SELECT enabled, transcribe_provider, toggle_shortcut, push_to_talk_key, \
         max_duration, min_duration, revise_enabled, revise_provider, revise_prompt, \
         preferred_languages, transcribe_mode, global_mode_enabled, ptt_activation_delay_ms \
         FROM audio_config WHERE id = 1",
        [],
        |row| {
            let enabled: i32 = row.get(0)?;
            let transcribe_provider: String = row.get(1)?;
            let toggle_shortcut: String = row.get(2)?;
            let push_to_talk_key: String = row.get(3)?;
            let max_duration: u32 = row.get(4)?;
            let min_duration: u32 = row.get(5)?;
            let revise_enabled: i32 = row.get(6)?;
            let revise_provider: String = row.get(7)?;
            let revise_prompt: String = row.get(8)?;
            let preferred_languages_json: String = row.get(9)?;
            let transcribe_mode: String = row.get(10)?;
            let global_mode_enabled: i32 = row.get(11)?;
            let ptt_activation_delay_ms: u32 = row.get(12)?;
            Ok((
                enabled != 0,
                transcribe_provider,
                toggle_shortcut,
                push_to_talk_key,
                max_duration,
                min_duration,
                revise_enabled != 0,
                revise_provider,
                revise_prompt,
                preferred_languages_json,
                transcribe_mode,
                global_mode_enabled != 0,
                ptt_activation_delay_ms,
            ))
        },
    );

    let (
        enabled,
        transcribe_provider,
        toggle_shortcut,
        push_to_talk_key,
        max_duration,
        min_duration,
        revise_enabled,
        revise_provider,
        revise_prompt,
        preferred_languages_json,
        transcribe_mode,
        global_mode_enabled,
        ptt_activation_delay_ms,
    ) = match config_result {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return AudioSettingsGlobal::default(),
        Err(_) => return AudioSettingsGlobal::default(),
    };

    let preferred_languages: Vec<String> =
        serde_json::from_str(&preferred_languages_json).unwrap_or_default();

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
        enabled,
        transcribe_provider,
        preferred_languages,
        toggle_shortcut,
        push_to_talk_key,
        ptt_activation_delay_ms,
        max_duration,
        min_duration,
        revise_enabled,
        revise_provider,
        revise_prompt,
        preferred_terms,
        forbidden_terms,
        replacements,
        transcribe_mode,
        global_mode_enabled,
    }
}

pub fn save_audio_global(data: &AudioSettingsGlobal) -> Result<()> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    let preferred_languages_json = serde_json::to_string(&data.preferred_languages)?;

    tx.execute(
        "INSERT OR REPLACE INTO audio_config \
         (id, enabled, transcribe_provider, toggle_shortcut, push_to_talk_key, \
          max_duration, min_duration, revise_enabled, revise_provider, revise_prompt, \
          preferred_languages, transcribe_mode, global_mode_enabled, ptt_activation_delay_ms) \
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            data.enabled as i32,
            data.transcribe_provider,
            data.toggle_shortcut,
            data.push_to_talk_key,
            data.max_duration,
            data.min_duration,
            data.revise_enabled as i32,
            data.revise_provider,
            data.revise_prompt,
            preferred_languages_json,
            data.transcribe_mode,
            data.global_mode_enabled as i32,
            data.ptt_activation_delay_ms,
        ],
    )?;

    // Replace global terms
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
