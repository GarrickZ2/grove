import { useState, useEffect, useRef } from "react";
import { useWalkieTalkie } from "../../hooks/useWalkieTalkie";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { getAudioSettings, transcribeAudio } from "../../api/ai";
import { themes } from "../../context/ThemeContext";
import type { TargetMode } from "../../api/walkieTalkie";
import type { ChatRef } from "../../data/types";
import GroupSelector from "./GroupSelector";
import ChannelGrid from "./ChannelGrid";
import InfoDisplay from "./InfoDisplay";
import TranscriptDialog from "./TranscriptDialog";

type TargetModeType = "chat" | "terminal";

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
  const [audioMinDuration, setAudioMinDuration] = useState(2);
  const [audioMaxDuration, setAudioMaxDuration] = useState(60);
  const processBlobRef = useRef<(blob: Blob) => void>(() => {});
  const isProcessingRef = useRef(false);
  const recordingStartRef = useRef(0);
  const recorder = useAudioRecorder({
    minDuration: 0.5, // allow short recordings through to transcribe; we check minDuration separately
    maxDuration: audioMaxDuration,
    onMaxReached: (blob) => {
      setRecordingPosition(null);
      isProcessingRef.current = true;
      processBlobRef.current(blob);
    },
  });

  // Fetch audio settings for min/max duration
  useEffect(() => {
    getAudioSettings().then((settings) => {
      setAudioMinDuration(settings.minDuration);
      setAudioMaxDuration(settings.maxDuration);
    }).catch((err) => { console.warn("[Radio] Failed to fetch audio settings, using defaults:", err); });
  }, []);

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
  const [recordingPosition, setRecordingPosition] = useState<number | null>(null);
  const [transcriptText, setTranscriptText] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<{
    groupId: string;
    position: number;
    target: TargetMode;
  } | null>(null);

  // Per-slot target mode state: key = "groupId:position"
  const [targetModes, setTargetModes] = useState<Record<string, TargetModeType>>({});
  // Per-slot selected chat: key = "groupId:position"
  const [selectedChats, setSelectedChats] = useState<Record<string, string>>({});

  const slotKey = state.currentGroupId && state.currentPosition !== null
    ? `${state.currentGroupId}:${state.currentPosition}`
    : null;

  const currentTargetMode: TargetModeType = slotKey ? (targetModes[slotKey] ?? "chat") : "chat";
  const currentSelectedChatId = slotKey ? selectedChats[slotKey] : undefined;

  // Use the selected chat from our local state, falling back to the server's active chat
  const effectiveActiveChat = currentSelectedChatId
    ? (state.availableChats.find((c) => c.id === currentSelectedChatId) ?? state.activeChat)
    : state.activeChat;

  // Build TargetMode for the current slot. Plain function — Compiler memoizes.
  const buildTarget = (): TargetMode => {
    if (currentTargetMode === "terminal") {
      return { mode: "terminal" };
    }
    const chatId = effectiveActiveChat?.id;
    if (chatId) {
      return { mode: "chat", chat_id: chatId };
    }
    return { mode: "terminal" }; // fallback if no chat available
  };

  // Refs to capture group/position at recording start (avoids stale closures)
  const recordingGroupRef = useRef<string | null>(null);
  const recordingPositionRef = useRef<number | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);

  // Refs to track latest values for async callbacks (avoids stale closures)
  const connectedRef = useRef(state.connected);
  const autoSendRef = useRef(autoSend);
  const groupsRef = useRef(state.groups);
  const holdGenerationRef = useRef(0);
  const audioMinDurationRef = useRef(audioMinDuration);
  const buildTargetRef = useRef(buildTarget);
  const slotKeyRef = useRef(slotKey);
  const currentGroupIdRef = useRef(state.currentGroupId);
  const currentPositionRef = useRef(state.currentPosition);
  const effectiveActiveChatRef = useRef(effectiveActiveChat);

  useEffect(() => { connectedRef.current = state.connected; }, [state.connected]);
  useEffect(() => { autoSendRef.current = autoSend; }, [autoSend]);
  useEffect(() => { groupsRef.current = state.groups; }, [state.groups]);
  useEffect(() => { audioMinDurationRef.current = audioMinDuration; }, [audioMinDuration]);
  // No dep array — buildTarget is now a plain (Compiler-memoized) function,
  // so we just keep the ref in sync on every commit.
  useEffect(() => { buildTargetRef.current = buildTarget; });
  useEffect(() => { slotKeyRef.current = slotKey; }, [slotKey]);
  useEffect(() => { currentGroupIdRef.current = state.currentGroupId; }, [state.currentGroupId]);
  useEffect(() => { currentPositionRef.current = state.currentPosition; }, [state.currentPosition]);
  useEffect(() => { effectiveActiveChatRef.current = effectiveActiveChat; }, [effectiveActiveChat]);

  // Prompt status feedback (auto-clears after 3 seconds)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visiblePromptStatus, setVisiblePromptStatus] = useState<
    typeof state.lastPromptStatus
  >(null);

  // Mirror the latest non-null prompt status into local visible state, and
  // schedule it to auto-clear after 3 seconds. The state sync uses the
  // "Adjusting state on prop change" pattern; the timer (a side-effect on an
  // external system) lives in an effect so it's set/cleared off-render.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [lastSyncedPromptStatus, setLastSyncedPromptStatus] = useState(
    state.lastPromptStatus,
  );
  if (lastSyncedPromptStatus !== state.lastPromptStatus) {
    setLastSyncedPromptStatus(state.lastPromptStatus);
    if (state.lastPromptStatus) {
      setVisiblePromptStatus(state.lastPromptStatus);
    }
  }
  useEffect(() => {
    if (!state.lastPromptStatus) return;
    const timer = setTimeout(() => {
      setVisiblePromptStatus(null);
    }, 3000);
    statusTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (statusTimerRef.current === timer) statusTimerRef.current = null;
    };
  }, [state.lastPromptStatus]);

  // Derived
  const currentGroup =
    state.groups.find((g) => g.id === state.currentGroupId) ?? null;

  // ── Mode / Session switching ─────────────────────────────────────────────

  // Plain handlers — React Compiler auto-memoizes and treats ref.current
  // reads as opaque, so we don't need (and can't satisfy) a manual deps
  // array here. Manual useCallback with `[actions]` couldn't be preserved
  // by Compiler because the body reads refs not in the deps.
  const handleTargetModeChange = (mode: TargetModeType) => {
    const sk = slotKeyRef.current;
    const gid = currentGroupIdRef.current;
    const pos = currentPositionRef.current;
    if (!sk || !gid || pos === null) return;
    setTargetModes((prev) => ({ ...prev, [sk]: mode }));
    // Broadcast to Blitz so it can preemptively switch panel
    const chatId = effectiveActiveChatRef.current?.id;
    const target: TargetMode = mode === "terminal" || !chatId
      ? { mode: "terminal" }
      : { mode: "chat", chat_id: chatId };
    actions.setTarget(gid, pos, target);
  };

  const handleSelectChat = (chat: ChatRef) => {
    const sk = slotKeyRef.current;
    const gid = currentGroupIdRef.current;
    const pos = currentPositionRef.current;
    if (!sk || !gid || pos === null) return;
    setSelectedChats((prev) => ({ ...prev, [sk]: chat.id }));
    // Broadcast to Blitz
    actions.setTarget(gid, pos, { mode: "chat", chat_id: chat.id });
  };

  // ── Callbacks ─────────────────────────────────────────────────────────────

  const handleTap = (position: number) => {
    if (state.currentGroupId) {
      // Build target from the TARGET slot's state (not current slot)
      const tapSlotKey = `${state.currentGroupId}:${position}`;
      const mode = targetModes[tapSlotKey] ?? "chat";
      const chatId = selectedChats[tapSlotKey];
      let target: TargetMode | undefined;
      if (mode === "terminal") {
        target = { mode: "terminal" };
      } else if (chatId) {
        target = { mode: "chat", chat_id: chatId };
      }
      // If no target (first visit, no selection yet), server will use its fallback
      actions.selectTask(state.currentGroupId, position, target);
    }
  };

  const handleHoldStart = (position: number) => {
    // Cancel any in-progress recording before starting a new one
    if (recorder.status === "recording") {
      recorder.cancel();
    }
    // Increment generation to cancel any stale hold-end processing
    holdGenerationRef.current += 1;
    // Block if transcription is still in progress
    if (isProcessingRef.current) return;

    if (state.currentGroupId) {
      // Build target from the HOLD slot's state (not current slot)
      const holdSlotKey = `${state.currentGroupId}:${position}`;
      const mode = targetModes[holdSlotKey] ?? "chat";
      const holdChatId = selectedChats[holdSlotKey];
      let target: TargetMode | undefined;
      if (mode === "terminal") {
        target = { mode: "terminal" };
      } else if (holdChatId) {
        target = { mode: "chat", chat_id: holdChatId };
      }
      actions.selectTask(state.currentGroupId, position, target);
    }
    recordingGroupRef.current = state.currentGroupId;
    recordingPositionRef.current = position;
    recordingStartRef.current = Date.now();
    setRecordingPosition(position);
    // Track the start promise so holdEnd can wait for it
    startPromiseRef.current = recorder.start();
  };

  // Shared blob processing: transcribe → send or show for edit
  const processBlob = async (blob: Blob) => {
    const groupId = recordingGroupRef.current;
    const pos = recordingPositionRef.current;
    if (!groupId || pos === null) {
      isProcessingRef.current = false;
      return;
    }

    setIsTranscribing(true);
    // Resolve the slot's project id outside try — optional chaining inside
    // a try block bails the whole function out of React Compiler.
    const currentGroup = groupsRef.current.find((g) => g.id === groupId);
    const slot = currentGroup?.slots.find((s) => s.position === pos);
    const projectId = slot?.project_id;
    let result: Awaited<ReturnType<typeof transcribeAudio>> | null = null;
    let succeeded = false;
    try {
      result = await transcribeAudio(blob, projectId);
      succeeded = true;
    } catch (err) {
      console.error("[Radio] Transcription failed:", err);
      setPendingPrompt(null);
    }
    if (!succeeded || result === null) {
      setIsTranscribing(false);
      isProcessingRef.current = false;
      return;
    }
    const text = (result.final || result.revised || result.raw || "").trim();
    if (!text) {
      // Empty transcription — skip silently
      setPendingPrompt(null);
      setIsTranscribing(false);
      isProcessingRef.current = false;
      return;
    }
    const target = buildTargetRef.current();
    if (!connectedRef.current) {
      setTranscriptText(text);
      setPendingPrompt({ groupId, position: pos, target });
    } else if (autoSendRef.current) {
      actions.sendPrompt(groupId, pos, text, target);
      setTranscriptText(null);
      setPendingPrompt(null);
    } else {
      setTranscriptText(text);
      setPendingPrompt({ groupId, position: pos, target });
    }
    setIsTranscribing(false);
    isProcessingRef.current = false;
  };
  useEffect(() => {
    processBlobRef.current = processBlob;
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleHoldEnd = (_position: number) => {
    const preciseElapsed = (Date.now() - recordingStartRef.current) / 1000;
    setRecordingPosition(null);

    // Skip if recording is shorter than configured min duration
    if (preciseElapsed < audioMinDurationRef.current) {
      recorder.cancel();
      isProcessingRef.current = false;
      return;
    }

    const gen = holdGenerationRef.current;

    const doStop = async () => {
      if (startPromiseRef.current) {
        await startPromiseRef.current;
        startPromiseRef.current = null;
      }
      return recorder.stop();
    };

    isProcessingRef.current = true;
    doStop().then(async (blob) => {
      if (gen !== holdGenerationRef.current) {
        isProcessingRef.current = false;
        return;
      }
      if (!blob) {
        isProcessingRef.current = false;
        return;
      }
      setIsTranscribing(true);
      processBlob(blob);
    });
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleCancel = (_position: number) => {
    setRecordingPosition(null);
    holdGenerationRef.current += 1;
    startPromiseRef.current = null;
    recorder.cancel();
    isProcessingRef.current = false;
  };

  const handleManualSend = (text: string) => {
    if (pendingPrompt) {
      actions.sendPrompt(
        pendingPrompt.groupId,
        pendingPrompt.position,
        text,
        pendingPrompt.target,
      );
    }
    setTranscriptText(null);
    setPendingPrompt(null);
  };

  const handleClearTranscript = () => {
    setTranscriptText(null);
    setPendingPrompt(null);
  };

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
              activeChat={effectiveActiveChat}
              availableChats={state.availableChats}
              targetMode={currentTargetMode}
              onTargetModeChange={handleTargetModeChange}
              onSelectChat={handleSelectChat}
              isRecording={recordingPosition !== null}
              recordingElapsed={recorder.elapsed}
              maxDuration={audioMaxDuration}
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
              onCancel={handleCancel}
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
