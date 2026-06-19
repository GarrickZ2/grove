// AI Settings API (providers + audio)

import { apiClient, getApiHost } from './client';
import type { AudioSettings, ProviderProfile, VoiceControlSettings } from '../components/AI/types';

// ─── Provider Types ─────────────────────────────────────────────────────────

export interface ProviderResponse {
  id: string;
  name: string;
  type: string;
  base_url: string;
  api_key: string; // masked
  model: string;
  status: string;
}

interface ProvidersListResponse {
  providers: ProviderResponse[];
}

interface CreateProviderRequest {
  name: string;
  type: string;
  base_url: string;
  api_key: string;
  model: string;
}

interface UpdateProviderRequest {
  name?: string;
  type?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  status?: string;
}

interface VerifyResponse {
  status: string;
  message: string;
}

// ─── Provider API ───────────────────────────────────────────────────────────

export async function listProviders(): Promise<ProviderProfile[]> {
  const resp = await apiClient.get<ProvidersListResponse>('/api/v1/ai/providers');
  return resp.providers.map(serverToProvider);
}

export async function createProvider(
  data: Omit<ProviderProfile, 'id' | 'status'>,
): Promise<ProviderProfile> {
  const req: CreateProviderRequest = {
    name: data.name,
    type: data.type,
    base_url: data.baseUrl,
    api_key: data.apiKey,
    model: data.model,
  };
  const resp = await apiClient.post<CreateProviderRequest, ProviderResponse>(
    '/api/v1/ai/providers',
    req,
  );
  return serverToProvider(resp);
}

export async function updateProvider(
  id: string,
  data: Partial<ProviderProfile>,
): Promise<ProviderProfile> {
  const req: UpdateProviderRequest = {};
  if (data.name !== undefined) req.name = data.name;
  if (data.type !== undefined) req.type = data.type;
  if (data.baseUrl !== undefined) req.base_url = data.baseUrl;
  if (data.apiKey !== undefined) req.api_key = data.apiKey;
  if (data.model !== undefined) req.model = data.model;
  if (data.status !== undefined) req.status = data.status;

  const resp = await apiClient.put<UpdateProviderRequest, ProviderResponse>(
    `/api/v1/ai/providers/${id}`,
    req,
  );
  return serverToProvider(resp);
}

export async function deleteProvider(id: string): Promise<void> {
  await apiClient.delete(`/api/v1/ai/providers/${id}`);
}

export async function verifyProvider(id: string): Promise<VerifyResponse> {
  return apiClient.post<Record<string, never>, VerifyResponse>(
    `/api/v1/ai/providers/${id}/verify`,
    {},
  );
}

function serverToProvider(s: ProviderResponse): ProviderProfile {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    baseUrl: s.base_url,
    apiKey: s.api_key,
    model: s.model,
    status: s.status as ProviderProfile['status'],
  };
}

// ─── Audio API ──────────────────────────────────────────────────────────────

export async function getAudioSettings(projectId?: string): Promise<AudioSettings> {
  const params = projectId ? `?project_id=${encodeURIComponent(projectId)}` : '';
  return apiClient.get<AudioSettings>(`/api/v1/ai/audio${params}`);
}

export async function saveAudioGlobal(settings: AudioSettings): Promise<void> {
  const body = {
    enabled: settings.enabled,
    transcribeMode: settings.transcribeMode,
    globalModeEnabled: settings.globalModeEnabled,
    transcribeProvider: settings.transcribeProvider,
    preferredLanguages: settings.preferredLanguages,
    toggleShortcut: settings.toggleShortcut,
    pushToTalkKey: settings.pushToTalkKey,
    pttActivationDelayMs: settings.pttActivationDelayMs,
    maxDuration: settings.maxDuration,
    minDuration: settings.minDuration,
    reviseEnabled: settings.reviseEnabled,
    reviseProvider: settings.reviseProvider,
    revisePromptGlobal: settings.revisePromptGlobal,
    preferredTermsGlobal: settings.preferredTermsGlobal,
    forbiddenTermsGlobal: settings.forbiddenTermsGlobal,
    replacementsGlobal: settings.replacementsGlobal,
  };
  await apiClient.put('/api/v1/ai/audio', body);
}

export async function saveAudioProject(
  projectId: string,
  settings: AudioSettings,
): Promise<void> {
  const body = {
    revisePromptProject: settings.revisePromptProject,
    preferredTermsProject: settings.preferredTermsProject,
    forbiddenTermsProject: settings.forbiddenTermsProject,
    replacementsProject: settings.replacementsProject,
  };
  await apiClient.put(`/api/v1/projects/${projectId}/ai/audio`, body);
}

// ─── Transcribe API ─────────────────────────────────────────────────────────

export interface TranscribeResult {
  raw: string;
  revised: string | null;
  final: string;
}

export async function transcribeAudio(
  audioBlob: Blob,
  projectId?: string,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  if (projectId) {
    formData.append('project_id', projectId);
  }
  return apiClient.postFormData<TranscribeResult>('/api/v1/ai/transcribe', formData, signal);
}

// ─── Streaming Transcribe (WebSocket) ────────────────────────────────────────

/** Live transcript update: stable finalized sentences + the replaceable current one. */
export interface StreamUpdateMsg {
  type: 'update';
  finalized: string[];
  current: string;
}

/** Terminal message after flush: assembled full text + optional revision. */
export interface StreamDoneMsg {
  type: 'done';
  full: string;
  revised?: string;
}

export interface StreamReadyMsg {
  type: 'ready';
}

export interface StreamErrorMsg {
  type: 'error';
  message: string;
}

export type StreamServerMsg =
  | StreamReadyMsg
  | StreamUpdateMsg
  | StreamDoneMsg
  | StreamErrorMsg;

/** Algorithm tuning sent to the streaming endpoint as query params. All
 *  optional — omitted fields fall back to the backend's defaults. */
export interface StreamTuning {
  /** Re-transcribe once this many ms of new audio arrives (default 1000). */
  minChunkMs?: number;
  /** RMS silence threshold (default 0.01). */
  silenceRms?: number;
  /** Trailing silence (ms) that finalizes a sentence (default 700). */
  silenceHoldMs?: number;
  /** Hard buffer cap (ms) that forces finalization (default 30000). */
  maxBufferMs?: number;
  /** Refresh the current sentence between boundaries (default true). Set false
   *  to transcribe only per-sentence — far fewer API calls. */
  intraSentenceRefresh?: boolean;
}

/**
 * Build a WebSocket URL for the streaming-transcribe endpoint.
 * The caller must append HMAC auth (see `appendHmacToUrl`).
 */
export function transcribeStreamWsUrl(projectId?: string, tuning?: StreamTuning): string {
  const host = getApiHost();
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams();
  if (projectId) qs.set('project_id', projectId);
  if (tuning?.minChunkMs != null) qs.set('min_chunk_ms', String(tuning.minChunkMs));
  if (tuning?.silenceRms != null) qs.set('silence_rms', String(tuning.silenceRms));
  if (tuning?.silenceHoldMs != null) qs.set('silence_hold_ms', String(tuning.silenceHoldMs));
  if (tuning?.maxBufferMs != null) qs.set('max_buffer_ms', String(tuning.maxBufferMs));
  if (tuning?.intraSentenceRefresh != null) {
    qs.set('intra_refresh', String(tuning.intraSentenceRefresh));
  }
  const q = qs.toString();
  return `${proto}//${host}/api/v1/ai/transcribe-stream${q ? `?${q}` : ''}`;
}

// ─── Voice Control API ──────────────────────────────────────────────────────

export async function getVoiceControlSettings(): Promise<VoiceControlSettings> {
  return apiClient.get<VoiceControlSettings>('/api/v1/ai/voice-control');
}

// Note: `sttModel` and `llmModel` inside `settings` are server-managed (resolved
// from the chosen provider profile) and are silently ignored by the backend.
export async function saveVoiceControlSettings(settings: VoiceControlSettings): Promise<void> {
  await apiClient.put('/api/v1/ai/voice-control', settings);
}

export interface VoiceControlToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface VoiceControlExecuteResult {
  rawTranscript: string;
  text: string | null;
  toolCalls: VoiceControlToolCall[];
}

export async function executeVoiceControl(
  audioBlob: Blob,
  tools: unknown[],
  context?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<VoiceControlExecuteResult> {
  const formData = new FormData();
  formData.append('audio', audioBlob, 'recording.webm');
  formData.append('tools', JSON.stringify(tools));
  if (context) {
    formData.append('context', JSON.stringify(context));
  }
  return apiClient.postFormData<VoiceControlExecuteResult>(
    '/api/v1/ai/voice-control/execute',
    formData,
    signal,
  );
}
