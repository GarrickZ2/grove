//! AI Settings API handlers (providers + audio + transcribe)

use axum::extract::{Multipart, Path, Query};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::storage::ai;
use crate::storage::workspace;

// ─── Provider DTOs ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ProviderDto {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    /// Masked API key for display (e.g. "sk-****abcd")
    pub api_key: String,
    pub model: String,
    pub status: String,
}

#[derive(Debug, Serialize)]
pub struct ProvidersListResponse {
    pub providers: Vec<ProviderDto>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProviderRequest {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProviderRequest {
    pub name: Option<String>,
    #[serde(rename = "type")]
    pub provider_type: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub status: Option<String>,
}

/// Mask an API key for display: show first 3 and last 4 chars
fn mask_api_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let prefix: String = chars[..3].iter().collect();
    let suffix: String = chars[chars.len() - 4..].iter().collect();
    format!("{}{}{}", prefix, "*".repeat(chars.len() - 7), suffix)
}

fn provider_to_dto(p: &ai::ProviderProfile) -> ProviderDto {
    ProviderDto {
        id: p.id.clone(),
        name: p.name.clone(),
        provider_type: p.provider_type.clone(),
        base_url: p.base_url.clone(),
        api_key: mask_api_key(&p.api_key),
        model: p.model.clone(),
        status: p.status.clone(),
    }
}

// ─── Provider Handlers ──────────────────────────────────────────────────────

/// GET /api/v1/ai/providers
pub async fn list_providers() -> Json<ProvidersListResponse> {
    let data = ai::load_providers();
    let providers = data.providers.iter().map(provider_to_dto).collect();
    Json(ProvidersListResponse { providers })
}

/// POST /api/v1/ai/providers
pub async fn create_provider(
    Json(req): Json<CreateProviderRequest>,
) -> Result<Json<ProviderDto>, StatusCode> {
    let mut data = ai::load_providers();

    let profile = ai::ProviderProfile {
        id: ai::generate_provider_id(),
        name: req.name,
        provider_type: req.provider_type,
        base_url: req.base_url,
        api_key: req.api_key,
        model: req.model,
        status: "draft".to_string(),
    };

    let dto = provider_to_dto(&profile);
    data.providers.push(profile);
    ai::save_providers(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(dto))
}

/// PUT /api/v1/ai/providers/{id}
pub async fn update_provider(
    Path(id): Path<String>,
    Json(req): Json<UpdateProviderRequest>,
) -> Result<Json<ProviderDto>, StatusCode> {
    let mut data = ai::load_providers();

    let profile = data
        .providers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    if let Some(name) = req.name {
        profile.name = name;
    }
    if let Some(provider_type) = req.provider_type {
        profile.provider_type = provider_type;
    }
    if let Some(base_url) = req.base_url {
        profile.base_url = base_url;
    }
    if let Some(api_key) = req.api_key {
        profile.api_key = api_key;
    }
    if let Some(model) = req.model {
        profile.model = model;
    }
    if let Some(status) = req.status {
        profile.status = status;
    }

    let dto = provider_to_dto(profile);
    ai::save_providers(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(dto))
}

/// DELETE /api/v1/ai/providers/{id}
pub async fn delete_provider(Path(id): Path<String>) -> Result<StatusCode, StatusCode> {
    let mut data = ai::load_providers();
    let len_before = data.providers.len();
    data.providers.retain(|p| p.id != id);

    if data.providers.len() == len_before {
        return Err(StatusCode::NOT_FOUND);
    }

    ai::save_providers(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/ai/providers/{id}/verify
///
/// Test provider connectivity by calling the models endpoint.
#[derive(Debug, Serialize)]
pub struct VerifyResponse {
    pub status: String,
    pub message: String,
}

pub async fn verify_provider(Path(id): Path<String>) -> Result<Json<VerifyResponse>, StatusCode> {
    let mut data = ai::load_providers();
    let profile = data
        .providers
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    // Blocking HTTP call — run off the async runtime
    let url = format!("{}/models", profile.base_url.trim_end_matches('/'));
    let api_key = profile.api_key.clone();
    let (status, message) = tokio::task::spawn_blocking(move || {
        let result = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", api_key))
            .timeout(std::time::Duration::from_secs(10))
            .call();
        match result {
            Ok(resp) if resp.status() == 200 => {
                ("verified".to_string(), "Connection successful".to_string())
            }
            Ok(resp) => ("failed".to_string(), format!("HTTP {}", resp.status())),
            Err(e) => ("failed".to_string(), format!("Connection failed: {}", e)),
        }
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    profile.status = status.clone();
    ai::save_providers(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(VerifyResponse { status, message }))
}

// ─── Audio DTOs ─────────────────────────────────────────────────────────────

/// Combined audio settings response (matching frontend AudioSettings type)
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettingsResponse {
    pub enabled: bool,
    pub transcribe_provider: String,
    pub preferred_languages: Vec<String>,
    pub toggle_shortcut: String,
    pub push_to_talk_key: String,
    #[serde(default = "default_ptt_activation_delay_ms")]
    pub ptt_activation_delay_ms: u32,
    pub max_duration: u32,
    pub min_duration: u32,
    pub revise_enabled: bool,
    pub revise_provider: String,
    pub revise_prompt_global: String,
    pub revise_prompt_project: String,
    pub preferred_terms_global: Vec<String>,
    pub preferred_terms_project: Vec<String>,
    pub forbidden_terms_global: Vec<String>,
    pub forbidden_terms_project: Vec<String>,
    pub replacements_global: Vec<ReplacementRuleDto>,
    pub replacements_project: Vec<ReplacementRuleDto>,
    pub transcribe_mode: String,
    pub global_mode_enabled: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReplacementRuleDto {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct AudioQuery {
    pub project_id: Option<String>,
}

/// PUT /api/v1/ai/audio request (global settings)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAudioGlobalRequest {
    pub enabled: bool,
    pub transcribe_provider: String,
    pub preferred_languages: Vec<String>,
    pub toggle_shortcut: String,
    pub push_to_talk_key: String,
    #[serde(default = "default_ptt_activation_delay_ms")]
    pub ptt_activation_delay_ms: u32,
    pub max_duration: u32,
    pub min_duration: u32,
    pub revise_enabled: bool,
    pub revise_provider: String,
    pub revise_prompt_global: String,
    pub preferred_terms_global: Vec<String>,
    pub forbidden_terms_global: Vec<String>,
    pub replacements_global: Vec<ReplacementRuleDto>,
    #[serde(default = "default_transcribe_mode")]
    pub transcribe_mode: String,
    #[serde(default)]
    pub global_mode_enabled: bool,
}

fn default_transcribe_mode() -> String {
    "batch".to_string()
}

fn default_ptt_activation_delay_ms() -> u32 {
    500
}

/// PUT /api/v1/projects/{id}/ai/audio request (project settings)
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAudioProjectRequest {
    pub revise_prompt_project: String,
    pub preferred_terms_project: Vec<String>,
    pub forbidden_terms_project: Vec<String>,
    pub replacements_project: Vec<ReplacementRuleDto>,
}

// ─── Audio Handlers ─────────────────────────────────────────────────────────

/// GET /api/v1/ai/audio?project_id=xxx
pub async fn get_audio(Query(query): Query<AudioQuery>) -> Json<AudioSettingsResponse> {
    let global = ai::load_audio_global();

    let (project_prompt, project_preferred, project_forbidden, project_replacements) =
        if let Some(ref project_id) = query.project_id {
            let project = ai::load_audio_project(project_id);
            (
                project.revise_prompt,
                project.preferred_terms,
                project.forbidden_terms,
                project.replacements,
            )
        } else {
            (String::new(), Vec::new(), Vec::new(), Vec::new())
        };

    Json(AudioSettingsResponse {
        enabled: global.enabled,
        transcribe_provider: global.transcribe_provider,
        preferred_languages: global.preferred_languages,
        toggle_shortcut: global.toggle_shortcut,
        push_to_talk_key: global.push_to_talk_key,
        ptt_activation_delay_ms: global.ptt_activation_delay_ms,
        max_duration: global.max_duration,
        min_duration: global.min_duration,
        revise_enabled: global.revise_enabled,
        revise_provider: global.revise_provider,
        revise_prompt_global: global.revise_prompt,
        revise_prompt_project: project_prompt,
        preferred_terms_global: global.preferred_terms,
        preferred_terms_project: project_preferred,
        forbidden_terms_global: global.forbidden_terms,
        forbidden_terms_project: project_forbidden,
        replacements_global: global
            .replacements
            .into_iter()
            .map(|r| ReplacementRuleDto {
                from: r.from,
                to: r.to,
            })
            .collect(),
        replacements_project: project_replacements
            .into_iter()
            .map(|r| ReplacementRuleDto {
                from: r.from,
                to: r.to,
            })
            .collect(),
        transcribe_mode: global.transcribe_mode,
        global_mode_enabled: global.global_mode_enabled,
    })
}

/// PUT /api/v1/ai/audio
pub async fn save_audio_global(
    Json(req): Json<SaveAudioGlobalRequest>,
) -> Result<StatusCode, StatusCode> {
    let data = ai::AudioSettingsGlobal {
        enabled: req.enabled,
        transcribe_provider: req.transcribe_provider,
        preferred_languages: req.preferred_languages,
        toggle_shortcut: req.toggle_shortcut,
        push_to_talk_key: req.push_to_talk_key,
        ptt_activation_delay_ms: req.ptt_activation_delay_ms,
        max_duration: req.max_duration,
        min_duration: req.min_duration,
        revise_enabled: req.revise_enabled,
        revise_provider: req.revise_provider,
        revise_prompt: req.revise_prompt_global,
        preferred_terms: req.preferred_terms_global,
        forbidden_terms: req.forbidden_terms_global,
        replacements: req
            .replacements_global
            .into_iter()
            .map(|r| ai::ReplacementRule {
                from: r.from,
                to: r.to,
            })
            .collect(),
        transcribe_mode: req.transcribe_mode,
        global_mode_enabled: req.global_mode_enabled,
    };
    ai::save_audio_global(&data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /api/v1/projects/{id}/ai/audio
pub async fn save_audio_project(
    Path(id): Path<String>,
    Json(req): Json<SaveAudioProjectRequest>,
) -> Result<StatusCode, StatusCode> {
    // Verify project exists
    let projects = workspace::load_projects().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    projects
        .iter()
        .find(|p| workspace::project_hash(&p.path) == id)
        .ok_or(StatusCode::NOT_FOUND)?;

    let data = ai::AudioSettingsProject {
        revise_prompt: req.revise_prompt_project,
        preferred_terms: req.preferred_terms_project,
        forbidden_terms: req.forbidden_terms_project,
        replacements: req
            .replacements_project
            .into_iter()
            .map(|r| ai::ReplacementRule {
                from: r.from,
                to: r.to,
            })
            .collect(),
    };
    ai::save_audio_project(&id, &data).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

// ─── Transcribe API ─────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeResponse {
    /// Raw transcript from speech-to-text
    pub raw: String,
    /// Revised transcript (if revision was enabled)
    pub revised: Option<String>,
    /// Final text to use (revised if available, otherwise raw)
    pub r#final: String,
}

/// POST /api/v1/ai/transcribe
///
/// Accepts multipart form:
/// - `audio`: audio file (webm/wav/mp3)
/// - `project_id` (optional): project ID for project-scoped settings
pub async fn transcribe(mut multipart: Multipart) -> Result<Json<TranscribeResponse>, StatusCode> {
    let mut audio_data: Option<Vec<u8>> = None;
    let mut audio_ext = "webm".to_string();
    let mut project_id: Option<String> = None;

    // Parse multipart fields
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "audio" => {
                if let Some(fname) = field.file_name() {
                    // Extract extension only — never use raw filename in headers
                    if let Some(ext) = fname.rsplit('.').next() {
                        let ext_clean: String =
                            ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                        if !ext_clean.is_empty() {
                            audio_ext = ext_clean;
                        }
                    }
                }
                audio_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| StatusCode::BAD_REQUEST)?
                        .to_vec(),
                );
            }
            "project_id" => {
                project_id = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
            }
            _ => {}
        }
    }

    let audio_data = audio_data.ok_or(StatusCode::BAD_REQUEST)?;

    // #8: Reject audio files > 25 MB (matches OpenAI Whisper limit)
    const MAX_AUDIO_SIZE: usize = 25 * 1024 * 1024;
    if audio_data.len() > MAX_AUDIO_SIZE {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }

    // Load settings
    let global = ai::load_audio_global();
    let project_settings = project_id.as_deref().map(ai::load_audio_project);
    let providers = ai::load_providers();

    // #10: Helper — find provider by ID first, fall back to name
    let find_provider = |key: &str| -> Option<&ai::ProviderProfile> {
        providers
            .providers
            .iter()
            .find(|p| p.id == key)
            .or_else(|| providers.providers.iter().find(|p| p.name == key))
    };

    // ── Step 1: Transcribe ──────────────────────────────────────────────────

    let transcribe_provider = find_provider(&global.transcribe_provider).ok_or_else(|| {
        eprintln!(
            "[transcribe] Provider not found: {}",
            global.transcribe_provider
        );
        StatusCode::BAD_REQUEST
    })?;

    // Clone values for spawn_blocking
    let t_base_url = transcribe_provider.base_url.clone();
    let t_api_key = transcribe_provider.api_key.clone();
    let t_model = transcribe_provider.model.clone();
    let t_language = global.preferred_languages.first().cloned();

    let raw_transcript = tokio::task::spawn_blocking(move || {
        call_transcription_api(
            &t_base_url,
            &t_api_key,
            &t_model,
            &audio_data,
            &format!("recording.{}", audio_ext),
            t_language.as_deref(),
        )
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|e| {
        eprintln!("[transcribe] Transcription API error: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    // ── Step 2: Revise (optional) ───────────────────────────────────────────

    let revised = if global.revise_enabled {
        let revise_provider = find_provider(&global.revise_provider);

        if let Some(provider) = revise_provider {
            let system_prompt =
                build_revision_prompt(&global, project_settings.as_ref(), &raw_transcript);
            let r_base_url = provider.base_url.clone();
            let r_api_key = provider.api_key.clone();
            let r_model = provider.model.clone();
            let r_transcript = raw_transcript.clone();

            match tokio::task::spawn_blocking(move || {
                call_revision_api(
                    &r_base_url,
                    &r_api_key,
                    &r_model,
                    &system_prompt,
                    &r_transcript,
                )
            })
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
            {
                Ok(text) => Some(text),
                Err(e) => {
                    eprintln!("[transcribe] Revision API error: {}", e);
                    None
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    let final_text = revised.as_deref().unwrap_or(&raw_transcript).to_string();

    Ok(Json(TranscribeResponse {
        raw: raw_transcript,
        revised,
        r#final: final_text,
    }))
}

/// Call an OpenAI-compatible /audio/transcriptions endpoint
pub(crate) fn call_transcription_api(
    base_url: &str,
    api_key: &str,
    model: &str,
    audio_data: &[u8],
    filename: &str,
    language: Option<&str>,
) -> Result<String, String> {
    let url = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));

    // Build multipart body manually
    let boundary = format!("----GroveBoundary{}", uuid::Uuid::new_v4().simple());

    let mut body = Vec::new();

    // File part
    append_multipart_file(&mut body, &boundary, "file", filename, audio_data);

    // Model part
    append_multipart_text(&mut body, &boundary, "model", model);

    // Language part (ISO-639-1)
    if let Some(lang) = language {
        let iso = language_to_iso(lang);
        append_multipart_text(&mut body, &boundary, "language", &iso);
    }

    // Response format
    append_multipart_text(&mut body, &boundary, "response_format", "text");

    // Closing boundary
    body.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());

    let response = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", api_key))
        .set(
            "Content-Type",
            &format!("multipart/form-data; boundary={}", boundary),
        )
        .timeout(std::time::Duration::from_secs(60))
        .send_bytes(&body);

    match response {
        Ok(resp) => resp
            .into_string()
            .map(|s| s.trim().to_string())
            .map_err(|e| format!("Failed to read response: {}", e)),
        Err(ureq::Error::Status(status, resp)) => {
            let body_text = resp
                .into_string()
                .unwrap_or_else(|_| "(unreadable)".to_string());
            Err(format!("HTTP {}: {} — body: {}", status, url, body_text))
        }
        Err(e) => Err(format!("HTTP error: {}: {}", url, e)),
    }
}

/// Call an OpenAI-compatible /chat/completions endpoint for revision
pub(crate) fn call_revision_api(
    base_url: &str,
    api_key: &str,
    model: &str,
    system_prompt: &str,
    transcript: &str,
) -> Result<String, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    // Wrap transcript in explicit tags so the LLM cannot mistake it for a question
    let user_message = format!(
        "Below is the raw speech-to-text transcript. \
         Clean it up following the rules above. \
         Output ONLY the polished text, nothing else.\n\n\
         <transcript>\n{}\n</transcript>",
        transcript
    );

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_message }
        ],
        "temperature": 0.3
    });

    let response = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", api_key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| format!("HTTP error: {}", e))?;

    let resp_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    resp_body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "No content in response".to_string())
}

/// Max entries per vocabulary category in the revision prompt
const VOCAB_TOP_K: usize = 30;

/// Build the revision system prompt from global + project settings.
///
/// Vocabulary entries are fuzzy-matched against the raw transcript and scored.
/// Each category (preferred, forbidden, replacements) independently picks
/// its top-K most relevant entries to keep the prompt concise.
pub(crate) fn build_revision_prompt(
    global: &ai::AudioSettingsGlobal,
    project: Option<&ai::AudioSettingsProject>,
    transcript: &str,
) -> String {
    let mut parts = vec![
        // Base system prompt — constrains the LLM to text polishing only
        "You are a speech-to-text post-processor. Your ONLY job is to clean up and polish \
         the raw transcript text provided by the user. Rules:\n\
         1. Output ONLY the cleaned-up version of the input text. Nothing else.\n\
         2. Do NOT answer questions, interpret content, add opinions, or generate new information.\n\
         3. Fix grammar, punctuation, filler words, repetitions, and false starts.\n\
         4. You may restructure or format the text (e.g. bullet points, paragraphs) \
            if it improves clarity, but only based on what the speaker actually said.\n\
         5. Preserve the speaker's original meaning, tone, and intent exactly.\n\
         6. Apply the vocabulary rules below if provided."
            .to_string(),
    ];

    // User's custom revision prompt (global)
    if !global.revise_prompt.is_empty() {
        parts.push(global.revise_prompt.clone());
    }

    if let Some(proj) = project {
        if !proj.revise_prompt.is_empty() {
            parts.push(proj.revise_prompt.clone());
        }
    }

    let transcript_lower = transcript.to_lowercase();
    let transcript_words: Vec<&str> = transcript_lower.split_whitespace().collect();

    // Preferred terms — scored & top-K
    let mut preferred: Vec<&str> = global.preferred_terms.iter().map(|s| s.as_str()).collect();
    if let Some(proj) = project {
        preferred.extend(proj.preferred_terms.iter().map(|s| s.as_str()));
    }
    let preferred = top_k_by_relevance(&preferred, &transcript_lower, &transcript_words);
    if !preferred.is_empty() {
        parts.push(format!(
            "Preferred terms (use exactly as written): {}",
            preferred.join(", ")
        ));
    }

    // Forbidden terms — scored & top-K
    let mut forbidden: Vec<&str> = global.forbidden_terms.iter().map(|s| s.as_str()).collect();
    if let Some(proj) = project {
        forbidden.extend(proj.forbidden_terms.iter().map(|s| s.as_str()));
    }
    let forbidden = top_k_by_relevance(&forbidden, &transcript_lower, &transcript_words);
    if !forbidden.is_empty() {
        parts.push(format!(
            "Forbidden terms (avoid or rewrite): {}",
            forbidden.join(", ")
        ));
    }

    // Replacement rules — scored by `from` field & top-K
    let mut replacements: Vec<(&str, &str)> = global
        .replacements
        .iter()
        .map(|r| (r.from.as_str(), r.to.as_str()))
        .collect();
    if let Some(proj) = project {
        replacements.extend(
            proj.replacements
                .iter()
                .map(|r| (r.from.as_str(), r.to.as_str())),
        );
    }
    let mut scored: Vec<(f32, &str, &str)> = replacements
        .iter()
        .map(|(from, to)| {
            let score = term_relevance_score(from, &transcript_lower, &transcript_words);
            (score, *from, *to)
        })
        .filter(|(score, _, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(VOCAB_TOP_K);
    if !scored.is_empty() {
        let rules: Vec<String> = scored
            .iter()
            .map(|(_, from, to)| format!("\"{}\" → \"{}\"", from, to))
            .collect();
        parts.push(format!(
            "Replacement rules (apply these substitutions): {}",
            rules.join(", ")
        ));
    }

    parts.join("\n\n")
}

/// Score & filter terms, return top-K by relevance to the transcript.
fn top_k_by_relevance<'a>(
    terms: &[&'a str],
    transcript_lower: &str,
    transcript_words: &[&str],
) -> Vec<&'a str> {
    let mut scored: Vec<(f32, &str)> = terms
        .iter()
        .map(|term| {
            let score = term_relevance_score(term, transcript_lower, transcript_words);
            (score, *term)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(VOCAB_TOP_K);
    scored.into_iter().map(|(_, t)| t).collect()
}

/// Compute a relevance score (0.0 = irrelevant) for a vocabulary term
/// against the transcript text. Higher = more relevant.
///
/// Scoring tiers:
///  - 100: exact case-insensitive substring match
///  -  80: exact word match (one of the transcript words)
///  -  60: any transcript word shares a prefix of 3+ chars with term
///  -  40–20: edit distance close enough (scaled by word length)
///  -   0: no match
fn term_relevance_score(term: &str, transcript_lower: &str, transcript_words: &[&str]) -> f32 {
    let term_lower = term.to_lowercase();

    // Tier 1: exact substring containment
    if transcript_lower.contains(&term_lower) {
        return 100.0;
    }

    // Split multi-word terms and score each sub-word, take the max
    let term_parts: Vec<&str> = term_lower.split_whitespace().collect();
    let mut best = 0.0_f32;

    for tp in &term_parts {
        // Tier 2: exact word match
        if transcript_words.contains(tp) {
            best = best.max(80.0);
            continue;
        }

        for tw in transcript_words {
            // Tier 3: shared prefix (min 3 chars)
            let prefix_len = common_prefix_len(tp, tw);
            let min_len = tp.len().min(tw.len());
            if prefix_len >= 3 && prefix_len as f32 / min_len as f32 >= 0.6 {
                best = best.max(60.0);
                continue;
            }

            // Tier 4: edit distance — only for words of similar length
            let len_diff = (tp.len() as i32 - tw.len() as i32).unsigned_abs() as usize;
            if len_diff <= 3 && tp.len() >= 3 {
                let max_dist = match tp.len() {
                    3..=4 => 1,
                    5..=7 => 2,
                    _ => 3,
                };
                let dist = levenshtein(tp, tw);
                if dist <= max_dist {
                    // Score inversely proportional to distance
                    let score = 40.0 - (dist as f32 * 10.0);
                    best = best.max(score.max(10.0));
                }
            }
        }
    }

    best
}

/// Length of the common prefix between two strings
fn common_prefix_len(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Levenshtein edit distance
fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (m, n) = (a.len(), b.len());

    let mut prev = (0..=n).collect::<Vec<_>>();
    let mut curr = vec![0; n + 1];

    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }

    prev[n]
}

// ─── Multipart helpers ──────────────────────────────────────────────────────

fn append_multipart_text(body: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", name).as_bytes(),
    );
    body.extend_from_slice(value.as_bytes());
    body.extend_from_slice(b"\r\n");
}

fn append_multipart_file(
    body: &mut Vec<u8>,
    boundary: &str,
    name: &str,
    filename: &str,
    data: &[u8],
) {
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\n",
            name, filename
        )
        .as_bytes(),
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(data);
    body.extend_from_slice(b"\r\n");
}

/// Convert a language name to ISO-639-1 code for the Whisper API
fn language_to_iso(lang: &str) -> String {
    match lang.to_lowercase().as_str() {
        "chinese" | "mandarin" => "zh".to_string(),
        "english" => "en".to_string(),
        "japanese" => "ja".to_string(),
        "korean" => "ko".to_string(),
        "german" => "de".to_string(),
        "french" => "fr".to_string(),
        "spanish" => "es".to_string(),
        "italian" => "it".to_string(),
        "portuguese" => "pt".to_string(),
        "russian" => "ru".to_string(),
        other => other.to_string(), // Pass through if already ISO code
    }
}

// ─── Voice Control DTOs and Handlers ────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceControlSettingsResponse {
    pub enabled: bool,
    pub stt_provider_id: String,
    pub stt_model: String,
    pub llm_provider_id: String,
    pub llm_model: String,
    pub toggle_shortcut: String,
    pub push_to_talk_key: String,
    pub ptt_activation_delay_ms: u32,
    pub max_duration: u32,
    pub min_duration: u32,
    pub preferred_languages: Vec<String>,
    pub disabled_actions: Vec<String>,
    pub has_initialized_actions: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VoiceControlToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceControlExecuteResponse {
    pub raw_transcript: String,
    pub text: Option<String>,
    pub tool_calls: Vec<VoiceControlToolCall>,
}

/// GET /api/v1/ai/voice-control
pub async fn get_voice_control() -> Json<VoiceControlSettingsResponse> {
    let settings = ai::load_voice_control();
    Json(VoiceControlSettingsResponse {
        enabled: settings.enabled,
        stt_provider_id: settings.stt_provider_id,
        stt_model: settings.stt_model,
        llm_provider_id: settings.llm_provider_id,
        llm_model: settings.llm_model,
        toggle_shortcut: settings.toggle_shortcut,
        push_to_talk_key: settings.push_to_talk_key,
        ptt_activation_delay_ms: settings.ptt_activation_delay_ms,
        max_duration: settings.max_duration,
        min_duration: settings.min_duration,
        preferred_languages: settings.preferred_languages,
        disabled_actions: settings.disabled_actions,
        has_initialized_actions: settings.has_initialized_actions,
    })
}

/// Request body for PUT /api/v1/ai/voice-control.
/// Intentionally omits stt_model / llm_model — those are resolved
/// server-side from provider config and are not user-editable via this endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveVoiceControlRequest {
    pub enabled: bool,
    pub stt_provider_id: String,
    pub llm_provider_id: String,
    pub toggle_shortcut: String,
    pub push_to_talk_key: String,
    pub ptt_activation_delay_ms: u32,
    pub max_duration: u32,
    pub min_duration: u32,
    pub preferred_languages: Vec<String>,
    pub disabled_actions: Vec<String>,
    pub has_initialized_actions: bool,
}

/// PUT /api/v1/ai/voice-control
pub async fn save_voice_control(
    Json(req): Json<SaveVoiceControlRequest>,
) -> Result<StatusCode, StatusCode> {
    // Preserve existing stt_model / llm_model — the frontend doesn't manage them.
    let existing = ai::load_voice_control();
    let settings = crate::storage::config::VoiceControlConfig {
        enabled: req.enabled,
        stt_provider_id: req.stt_provider_id,
        stt_model: existing.stt_model,
        llm_provider_id: req.llm_provider_id,
        llm_model: existing.llm_model,
        toggle_shortcut: req.toggle_shortcut,
        push_to_talk_key: req.push_to_talk_key,
        ptt_activation_delay_ms: req.ptt_activation_delay_ms,
        max_duration: req.max_duration,
        min_duration: req.min_duration,
        preferred_languages: req.preferred_languages,
        disabled_actions: req.disabled_actions,
        has_initialized_actions: req.has_initialized_actions,
    };
    ai::save_voice_control(&settings).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::NO_CONTENT)
}

/// POST /api/v1/ai/voice-control/execute
pub async fn execute_voice_control(
    mut multipart: Multipart,
) -> Result<Json<VoiceControlExecuteResponse>, StatusCode> {
    let mut audio_data: Option<Vec<u8>> = None;
    let mut audio_ext = "webm".to_string();
    let mut tools_json: Option<String> = None;
    let mut context_json: Option<String> = None;

    // Parse multipart fields
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| StatusCode::BAD_REQUEST)?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "audio" => {
                if let Some(fname) = field.file_name() {
                    if let Some(ext) = fname.rsplit('.').next() {
                        let ext_clean: String =
                            ext.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
                        if !ext_clean.is_empty() {
                            audio_ext = ext_clean;
                        }
                    }
                }
                audio_data = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|_| StatusCode::BAD_REQUEST)?
                        .to_vec(),
                );
            }
            "tools" => {
                tools_json = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
            }
            "context" => {
                context_json = Some(field.text().await.map_err(|_| StatusCode::BAD_REQUEST)?);
            }
            _ => {}
        }
    }

    let audio_data = audio_data.ok_or(StatusCode::BAD_REQUEST)?;
    const MAX_AUDIO_SIZE: usize = 25 * 1024 * 1024;
    if audio_data.len() > MAX_AUDIO_SIZE {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let tools: Vec<serde_json::Value> = if let Some(json_str) = tools_json {
        serde_json::from_str(&json_str).unwrap_or_default()
    } else {
        Vec::new()
    };

    // Load settings from config.toml
    let config = crate::storage::config::load_config();
    let vc_settings = config.voice_control;
    if !vc_settings.enabled {
        return Err(StatusCode::FORBIDDEN);
    }

    let providers = ai::load_providers();
    let find_provider = |key: &str| -> Option<&ai::ProviderProfile> {
        providers
            .providers
            .iter()
            .find(|p| p.id == key)
            .or_else(|| providers.providers.iter().find(|p| p.name == key))
    };

    // ── Step 1: Transcribe ──────────────────────────────────────────────────
    let stt_provider = find_provider(&vc_settings.stt_provider_id).ok_or_else(|| {
        eprintln!(
            "[voice_control] STT Provider not found: {}",
            vc_settings.stt_provider_id
        );
        StatusCode::BAD_REQUEST
    })?;

    let t_base_url = stt_provider.base_url.clone();
    let t_api_key = stt_provider.api_key.clone();
    let t_model = if vc_settings.stt_model.is_empty() {
        stt_provider.model.clone()
    } else {
        vc_settings.stt_model.clone()
    };
    let t_language = vc_settings.preferred_languages.first().cloned();

    let raw_transcript = tokio::task::spawn_blocking(move || {
        call_transcription_api(
            &t_base_url,
            &t_api_key,
            &t_model,
            &audio_data,
            &format!("recording.{}", audio_ext),
            t_language.as_deref(),
        )
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|e| {
        eprintln!("[voice_control] Transcription error: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    // ── Step 2: Call LLM with Tools ─────────────────────────────────────────
    let llm_provider = find_provider(&vc_settings.llm_provider_id).ok_or_else(|| {
        eprintln!(
            "[voice_control] LLM Provider not found: {}",
            vc_settings.llm_provider_id
        );
        StatusCode::BAD_REQUEST
    })?;

    let l_base_url = llm_provider.base_url.clone();
    let l_api_key = llm_provider.api_key.clone();
    let l_model = if vc_settings.llm_model.is_empty() {
        llm_provider.model.clone()
    } else {
        vc_settings.llm_model.clone()
    };

    let raw_transcript_clone = raw_transcript.clone();
    let context_clone = context_json.clone();
    let result = tokio::task::spawn_blocking(move || {
        call_voice_control_llm(
            &l_base_url,
            &l_api_key,
            &l_model,
            &raw_transcript_clone,
            tools,
            context_clone.as_deref(),
        )
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(|e| {
        eprintln!("[voice_control] LLM error: {}", e);
        StatusCode::BAD_GATEWAY
    })?;

    Ok(Json(VoiceControlExecuteResponse {
        raw_transcript,
        text: result.text,
        tool_calls: result.tool_calls,
    }))
}

struct LlmResult {
    text: Option<String>,
    tool_calls: Vec<VoiceControlToolCall>,
}

fn call_voice_control_llm(
    base_url: &str,
    api_key: &str,
    model: &str,
    transcript: &str,
    tools: Vec<serde_json::Value>,
    context: Option<&str>,
) -> Result<LlmResult, String> {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut system_prompt = "You are a voice controller for Grove. Based on the user's spoken command, generate a sequence of tool calls to perform the requested actions. Call the tools in the exact order they should be executed.\n".to_string();

    if let Some(ctx_str) = context {
        system_prompt.push_str("\n=== Current Page Context ===\n");
        system_prompt.push_str(ctx_str);
        system_prompt.push_str("\n============================\n\n");
        system_prompt.push_str("If the user refers to items relatively (e.g., \"the second task\", \"the last session\", \"the chat about Rust\", or \"active task\") or specifies a project/task by name, resolve their target ID, name, or index using the Context above (e.g. resolving a project name to its actual ID from 'projects_list'). When invoking tools, always pass resolved actual entity IDs (e.g. project ID, task ID, session ID) in arguments rather than index numbers unless the tool arguments explicitly expect an index.");
    }

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": transcript }
        ],
        "temperature": 0.1
    });

    if !tools.is_empty() {
        let openai_tools: Vec<serde_json::Value> = tools
            .into_iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": t
                })
            })
            .collect();
        body["tools"] = serde_json::Value::Array(openai_tools);
    }

    let response = ureq::post(&url)
        .set("Authorization", &format!("Bearer {}", api_key))
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(30))
        .send_string(&body.to_string())
        .map_err(|e| format!("HTTP error: {}", e))?;

    let resp_body: serde_json::Value = response
        .into_json()
        .map_err(|e| format!("Failed to parse response: {}", e))?;

    let choice = &resp_body["choices"][0]["message"];
    let text = choice["content"].as_str().map(|s| s.trim().to_string());

    let mut tool_calls = Vec::new();
    if let Some(calls) = choice["tool_calls"].as_array() {
        for call in calls {
            let id = call["id"].as_str().unwrap_or_default().to_string();
            let name = call["function"]["name"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let args_str = call["function"]["arguments"].as_str().unwrap_or("{}");
            let arguments: serde_json::Value = serde_json::from_str(args_str).unwrap_or_default();
            tool_calls.push(VoiceControlToolCall {
                id,
                name,
                arguments,
            });
        }
    }

    Ok(LlmResult { text, tool_calls })
}
