import { useState, useCallback, useEffect, useRef } from "react";
import { useWalkieTalkie } from "../../hooks/useWalkieTalkie";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { transcribeAudio } from "../../api/ai";
import { themes } from "../../context/ThemeContext";
import GroupSelector from "./GroupSelector";
import ChannelGrid from "./ChannelGrid";
import InfoDisplay from "./InfoDisplay";
import TranscriptDialog from "./TranscriptDialog";

export function RadioPage() {
  // Prevent zoom/double-tap on mobile for push-to-talk UX
  useEffect(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    const original = meta?.getAttribute("content") ?? "";
    meta?.setAttribute("content", "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover");
    return () => { meta?.setAttribute("content", original); };
  }, []);

  // Hooks
  const [state, actions] = useWalkieTalkie();
  const processBlobRef = useRef<(blob: Blob) => void>(() => {});
  const recorder = useAudioRecorder({
    minDuration: 0.5,
    maxDuration: 60,
    onMaxReached: (blob) => {
      setRecordingPosition(null);
      isProcessingRef.current = true;
      processBlobRef.current(blob);
    },
  });

  // Apply theme from desktop via WS
  useEffect(() => {
    if (!state.theme) return;
    const systemIsDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    let resolved = themes.find((t) => t.id === state.theme);
    if (!resolved || resolved.id === "auto") {
      resolved = themes.find((t) => t.id === (systemIsDark ? "dark" : "light")) ?? themes[1];
    }
    const root = document.documentElement;
    const c = resolved.colors;
    root.style.setProperty("--color-bg", c.bg);
    root.style.setProperty("--color-bg-secondary", c.bgSecondary);
    root.style.setProperty("--color-bg-tertiary", c.bgTertiary);
    root.style.setProperty("--color-border", c.border);
    root.style.setProperty("--color-text", c.text);
    root.style.setProperty("--color-text-muted", c.textMuted);
    root.style.setProperty("--color-highlight", c.highlight);
    root.style.setProperty("--color-accent", c.accent);
    root.style.setProperty("--color-success", c.success);
    root.style.setProperty("--color-warning", c.warning);
    root.style.setProperty("--color-error", c.error);
    root.style.setProperty("--color-info", c.info);
  }, [state.theme]);

  // Local state
  const [autoSend, setAutoSend] = useState(true);
  const [recordingPosition, setRecordingPosition] = useState<number | null>(
    null,
  );
  const [transcriptText, setTranscriptText] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<{
    groupId: string;
    position: number;
    chatId?: string;
  } | null>(null);

  // Refs to capture group/position at recording start (avoids stale closures)
  const recordingGroupRef = useRef<string | null>(null);
  const recordingPositionRef = useRef<number | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);

  // Refs to track latest values for async callbacks (C1: stale closure fix)
  const connectedRef = useRef(state.connected);
  const activeChatRef = useRef(state.activeChat);
  const autoSendRef = useRef(autoSend);
  const groupsRef = useRef(state.groups);
  const isProcessingRef = useRef(false);
  const holdGenerationRef = useRef(0);

  useEffect(() => { connectedRef.current = state.connected; }, [state.connected]);
  useEffect(() => { activeChatRef.current = state.activeChat; }, [state.activeChat]);
  useEffect(() => { autoSendRef.current = autoSend; }, [autoSend]);
  useEffect(() => { groupsRef.current = state.groups; }, [state.groups]);

  // Prompt status feedback (auto-clears after 3 seconds)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visiblePromptStatus, setVisiblePromptStatus] = useState<
    typeof state.lastPromptStatus
  >(null);

  useEffect(() => {
    if (state.lastPromptStatus) {
      setVisiblePromptStatus(state.lastPromptStatus);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      statusTimerRef.current = setTimeout(() => {
        setVisiblePromptStatus(null);
      }, 3000);
    }
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, [state.lastPromptStatus]);

  // Derived
  const currentGroup =
    state.groups.find((g) => g.id === state.currentGroupId) ?? null;

  // ── Callbacks ─────────────────────────────────────────────────────────────

  const handleTap = useCallback(
    (position: number) => {
      if (state.currentGroupId) {
        actions.selectTask(state.currentGroupId, position);
      }
    },
    [state.currentGroupId, actions],
  );

  const handleHoldStart = useCallback(
    (position: number) => {
      // C2: Cancel any in-progress recording before starting a new one
      if (recorder.status === "recording") {
        recorder.cancel();
      }
      // Increment generation to cancel any stale hold-end processing
      holdGenerationRef.current++;
      // C2: Block if transcription is still in progress
      if (isProcessingRef.current) return;

      if (state.currentGroupId) {
        actions.selectTask(state.currentGroupId, position);
      }
      recordingGroupRef.current = state.currentGroupId;
      recordingPositionRef.current = position;
      setRecordingPosition(position);
      // Track the start promise so holdEnd can wait for it
      startPromiseRef.current = recorder.start();
    },
    [state.currentGroupId, actions, recorder],
  );

  // Shared blob processing: transcribe → send or show for edit
  const processBlob = useCallback(async (blob: Blob) => {
    const groupId = recordingGroupRef.current;
    const pos = recordingPositionRef.current;
    if (!groupId || pos === null) {
      isProcessingRef.current = false;
      return;
    }

    setIsTranscribing(true);
    try {
      const currentGroup = groupsRef.current.find((g) => g.id === groupId);
      const slot = currentGroup?.slots.find((s) => s.position === pos);
      const result = await transcribeAudio(blob, slot?.project_id);
      const text = result.final || result.revised || result.raw;

      if (!connectedRef.current) {
        setTranscriptText(text);
        setPendingPrompt({ groupId, position: pos, chatId: activeChatRef.current?.id });
      } else if (autoSendRef.current) {
        actions.sendPrompt(groupId, pos, text, activeChatRef.current?.id);
        setTranscriptText(null);
        setPendingPrompt(null);
      } else {
        setTranscriptText(text);
        setPendingPrompt({ groupId, position: pos, chatId: activeChatRef.current?.id });
      }
    } catch (err) {
      console.error("[Radio] Transcription failed:", err);
      setPendingPrompt(null);
    } finally {
      setIsTranscribing(false);
      isProcessingRef.current = false;
    }
  }, [actions]);
  processBlobRef.current = processBlob;

  const handleHoldEnd = useCallback(
    () => {
      setRecordingPosition(null);
      setIsTranscribing(true); // Show "Transcribing" immediately on release

      // Capture current generation to detect stale processing
      const gen = holdGenerationRef.current;

      // Wait for start() to complete before stopping
      const doStop = async () => {
        if (startPromiseRef.current) {
          await startPromiseRef.current;
          startPromiseRef.current = null;
        }
        return recorder.stop();
      };

      isProcessingRef.current = true;
      doStop().then(async (blob) => {
        // If a new hold-start happened while we were stopping, discard this result
        if (gen !== holdGenerationRef.current) {
          isProcessingRef.current = false;
          setIsTranscribing(false);
          return;
        }
        if (!blob) {
          setIsTranscribing(false);
          isProcessingRef.current = false;
          return;
        }
        processBlob(blob);
      });
    },
    [recorder, processBlob],
  );

  const handleManualSend = useCallback(
    (text: string) => {
      // M4: Use captured groupId/position/chatId from recording time, not current state
      if (pendingPrompt) {
        actions.sendPrompt(
          pendingPrompt.groupId,
          pendingPrompt.position,
          text,
          pendingPrompt.chatId,
        );
      }
      setTranscriptText(null);
      setPendingPrompt(null);
    },
    [pendingPrompt, actions],
  );

  const handleClearTranscript = useCallback(() => {
    setTranscriptText(null);
    setPendingPrompt(null);
  }, []);

  // ── Volume key support (works on physical keyboards / tablets, not iOS Safari) ──

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!state.currentGroupId || state.currentPosition === null) return;

      if (e.key === "AudioVolumeUp") {
        e.preventDefault();
        actions.switchChat(
          state.currentGroupId,
          state.currentPosition,
          "prev",
        );
      } else if (e.key === "AudioVolumeDown") {
        e.preventDefault();
        actions.switchChat(
          state.currentGroupId,
          state.currentPosition,
          "next",
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.currentGroupId, state.currentPosition, actions]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-[100dvh] w-full overflow-hidden" style={{ backgroundColor: "var(--color-bg)" }}>
      <div className="mx-auto flex h-full w-full max-w-[34rem] flex-col p-2.5 pb-[env(safe-area-inset-bottom)] sm:p-4 sm:pb-[calc(env(safe-area-inset-bottom)+1rem)]">
        <div
          className="flex flex-1 flex-col rounded-2xl border p-2 sm:p-3"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-secondary)" }}
        >
          {/* Header */}
          <div className="mb-1.5 flex items-center justify-between px-2 py-1.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.32em]" style={{ color: "var(--color-text-muted)" }}>
              Grove Radio
            </div>
            <div
              className="flex items-center gap-2 rounded-full border px-2 py-0.5"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)" }}
            >
              <span
                className="h-2 w-2 rounded-full"
                style={{
                  backgroundColor: state.connected ? "var(--color-success)" : "var(--color-text-muted)",
                  boxShadow: state.connected ? "0 0 10px var(--color-success)" : "none",
                  animation: state.connected ? "none" : "pulse 2s infinite",
                }}
              />
              <span className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
                {state.connected ? "Linked" : "Linking"}
              </span>
            </div>
          </div>

          {/* Bank selector */}
          <div className="mb-1.5">
            <GroupSelector
              groups={state.groups}
              currentGroupId={state.currentGroupId}
              onSwitch={actions.switchGroup}
            />
          </div>

          {/* Info display */}
          <div className="mb-1.5">
            <InfoDisplay
              group={currentGroup}
              selectedPosition={state.currentPosition}
              activeChat={state.activeChat}
              isRecording={recordingPosition !== null}
              recordingElapsed={recorder.elapsed}
              frequencyData={recorder.frequencyData}
              isTranscribing={isTranscribing}
              promptStatus={visiblePromptStatus}
            />
          </div>

          {/* Channel grid */}
          <div className="mb-1.5 flex-1 min-h-0 flex flex-col">
            <ChannelGrid
              group={currentGroup}
              selectedPosition={state.currentPosition}
              recordingPosition={recordingPosition}
              onTap={handleTap}
              onHoldStart={handleHoldStart}
              onHoldEnd={handleHoldEnd}
            />
          </div>

          {/* Dispatch mode toggle */}
          <div
            className="flex items-center justify-between rounded-xl border px-3 py-2"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)" }}
          >
            <span className="font-mono text-[10px] uppercase tracking-[0.24em]" style={{ color: "var(--color-text-muted)" }}>
              Dispatch
            </span>
            <div
              className="grid grid-cols-2 rounded-lg border p-0.5"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-secondary)" }}
            >
              <button
                onClick={() => setAutoSend(true)}
                className="rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200"
                style={{
                  color: autoSend ? "var(--color-highlight)" : "var(--color-text-muted)",
                  backgroundColor: autoSend ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
                }}
              >
                Auto
              </button>
              <button
                onClick={() => setAutoSend(false)}
                className="rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-200"
                style={{
                  color: !autoSend ? "var(--color-highlight)" : "var(--color-text-muted)",
                  backgroundColor: !autoSend ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
                }}
              >
                Manual
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Transcript edit dialog (when autoSend is off) */}
      <TranscriptDialog
        text={transcriptText}
        onSend={handleManualSend}
        onCancel={handleClearTranscript}
      />
    </div>
  );
}
