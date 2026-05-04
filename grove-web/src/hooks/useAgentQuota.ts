import { useCallback, useEffect, useRef, useState } from 'react';

import { getAgentUsage, type AgentUsage } from '../api/agentUsage';

/**
 * Built-in agent IDs that support quota fetching. Custom agents and other
 * built-ins (Droid, Kimi, …) return `null` and the badge hides the quota.
 */
const SUPPORTED_AGENTS = new Set([
  'claude',
  'codex',
  'gemini',
  'copilot',
  'kimi',
  'opencode',
  'minimax',
]);

/**
 * Agents whose quota pool depends on the selected model. For these agents the
 * `model` argument is part of the cache key server-side and must be threaded
 * through. For standalone built-ins (claude/codex/gemini/copilot/kimi) all
 * models share one pool, so we intentionally ignore `model` here to avoid
 * re-fetching on every model switch.
 */
const MODEL_AWARE_AGENTS = new Set<string>(['opencode']);

export interface UseAgentQuotaResult {
  usage: AgentUsage | null;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Fetch agent usage for the currently active agent.
 *
 * - On mount and whenever `agentId` changes, fetches once immediately.
 * - Re-fetches (non-forced, may hit backend 60s cache) each time the active
 *   chat transitions from busy to idle — i.e. right after a turn completes.
 * - `refresh()` forces a bypass of the backend cache (`?force=true`).
 *   Refresh calls are suppressed until the initial fetch for the current
 *   agent has started, avoiding a duplicate upstream hit on agent switch.
 * - Returns `null` for unsupported agent IDs and on any fetch failure —
 *   the UI then hides the quota badge entirely.
 *
 * `model` is only forwarded for model-aware multi-provider agents (see
 * `MODEL_AWARE_AGENTS`). For standalone built-ins it's dropped so model
 * switches don't cause redundant upstream requests.
 */
export function useAgentQuota(
  agentId: string | null,
  busy: boolean = false,
  model?: string,
): UseAgentQuotaResult {
  const [cached, setCached] = useState<AgentUsage | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Tracks the latest request so late responses for a stale agent are ignored.
  const requestIdRef = useRef(0);
  // True once the effect-driven initial fetch for the current agent has been
  // kicked off — used to suppress a redundant `refresh()` racing the mount.
  const initialFetchStartedRef = useRef(false);

  // Drop the model for agents whose quota pool doesn't depend on it.
  const effectiveModel = agentId && MODEL_AWARE_AGENTS.has(agentId) ? model : undefined;

  // For model-aware multi-provider agents (opencode), the previously cached
  // value belongs to a different upstream pool — clear it during render when
  // agentId changes so the popover doesn't briefly mix old plan/extras with
  // the new agent. This is the documented "Adjusting state on prop change"
  // pattern: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [prevAgentId, setPrevAgentId] = useState(agentId);
  if (prevAgentId !== agentId) {
    setPrevAgentId(agentId);
    if (agentId && MODEL_AWARE_AGENTS.has(agentId)) {
      setCached(null);
    }
  }

  const fetchData = useCallback(async (agent: string, force: boolean, m?: string) => {
    if (!SUPPORTED_AGENTS.has(agent)) return;
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    // Yield a microtask before flipping to "refreshing" so this is not a
    // synchronous setState when called from an effect body.
    await Promise.resolve();
    if (requestId !== requestIdRef.current) return; // superseded already
    setRefreshing(true);
    let result: AgentUsage | null = null;
    let failed = false;
    try {
      result = await getAgentUsage(agent, force, m);
    } catch (err) {
      // Surface fetch failures via console; the UI hides the badge when
      // there is no cached usage matching the active agent.
      console.error('[useAgentQuota] fetch failed', err);
      failed = true;
    }
    if (requestId !== requestIdRef.current) return; // stale
    if (!failed && result !== null) setCached(result);
    // Always clear the flag for the *latest* request so the UI can never
    // get stuck in a "refreshing" state, even if a stale response returns
    // after a newer request was already completed.
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!agentId || !SUPPORTED_AGENTS.has(agentId)) {
      // Invalidate any in-flight request; the next render will hide the
      // badge because `cached.agent` won't match the new `agentId`.
      requestIdRef.current += 1;
      initialFetchStartedRef.current = false;
      return;
    }

    initialFetchStartedRef.current = true;
    void fetchData(agentId, false, effectiveModel);
    return () => {
      requestIdRef.current += 1;
      initialFetchStartedRef.current = false;
    };
  }, [agentId, effectiveModel, fetchData]);

  // Re-fetch whenever the chat transitions from busy → idle (a turn finished).
  const prevBusyRef = useRef(busy);
  useEffect(() => {
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!agentId || !SUPPORTED_AGENTS.has(agentId)) return;
    if (!initialFetchStartedRef.current) return;
    if (wasBusy && !busy) {
      void fetchData(agentId, false, effectiveModel);
    }
  }, [busy, agentId, effectiveModel, fetchData]);

  const refresh = useCallback(() => {
    // Ignore forced refreshes issued before the effect's initial fetch has
    // started — otherwise the effect and the refresh would fire two back-to-
    // back upstream requests on mount / agent switch.
    if (!agentId || !initialFetchStartedRef.current) return;
    void fetchData(agentId, true, effectiveModel);
  }, [agentId, effectiveModel, fetchData]);

  // Only surface the cached usage if it belongs to the current agent. This
  // prevents a stale quota from flashing on-screen during agent switch.
  const isActiveAgent = !!agentId && SUPPORTED_AGENTS.has(agentId);
  const usage = isActiveAgent && cached?.agent === agentId ? cached : null;
  const effectiveRefreshing = isActiveAgent ? refreshing : false;

  return { usage, refreshing: effectiveRefreshing, refresh };
}
