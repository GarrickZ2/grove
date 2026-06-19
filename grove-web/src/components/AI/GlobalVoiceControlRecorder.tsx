import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { getVoiceControlSettings, executeVoiceControl } from "../../api";
import { matchesShortcut, matchesPTTKey } from "./utils";
import { RecordingIndicator } from "./RecordingIndicator";
import type { VoiceControlSettings } from "./types";
import { useContextKey, commandRegistry, useDefineCommand, voiceControlContextRegistry } from "../../keyboard";

const PTT_ACTIVATION_DELAY_MIN_MS = 50;

function pttActivationDelayMs(s: VoiceControlSettings | null): number {
  const v = s?.pttActivationDelayMs ?? 500;
  return Math.max(PTT_ACTIVATION_DELAY_MIN_MS, v);
}

export type IndicatorStatus = "idle" | "warming" | "recording" | "processing" | "error";

export interface GlobalVoiceControlRecorderProps {
  isLoading?: boolean;
}

export function GlobalVoiceControlRecorder({
  isLoading = false,
}: GlobalVoiceControlRecorderProps) {
  const [settings, setSettings] = useState<VoiceControlSettings | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isLoadingRef = useRef(isLoading);
  useEffect(() => {
    isLoadingRef.current = isLoading;
  }, [isLoading]);

  // PTT State
  const [pttWarming, setPttWarming] = useState(false);
  const [pttWarmElapsed, setPttWarmElapsed] = useState(0);
  const [pttWarmDelay, setPttWarmDelay] = useState(0);

  const settingsRef = useRef<VoiceControlSettings | null>(null);
  const pttActiveRef = useRef(false);
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pttWarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load settings on mount and bind event listener
  const loadSettings = useCallback(() => {
    getVoiceControlSettings()
      .then((s: VoiceControlSettings) => {
        setSettings(s);
        settingsRef.current = s;
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    loadSettings();
    window.addEventListener("grove:voice-control-settings-changed", loadSettings);
    return () => {
      window.removeEventListener("grove:voice-control-settings-changed", loadSettings);
    };
  }, [loadSettings]);



  // Audio Recorder Hook
  const maxDuration = settings?.maxDuration ?? 10;
  const minDuration = settings?.minDuration ?? 1;

  const handleRecordingComplete = useCallback(
    async (blob: Blob) => {
      const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
      if (blob.size > MAX_AUDIO_SIZE) {
        setErrorMessage("Recording too large (max 25 MB)");
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setErrorMessage(null);
      setTranscribing(true);

      try {
        // Collect enabled actions to pass as tool definitions
        const allCmds = commandRegistry.listCommands().filter((c) => !c.hidden);
        const disabledSet = new Set(settingsRef.current?.disabledActions || []);
        const enabledCmds = allCmds.filter((c) => !disabledSet.has(c.id));

        const tools = enabledCmds.map((cmd) => {
          if (cmd.id === "project.open") {
            return {
              name: cmd.id,
              description: "Open/switch to a specific project by its ID",
              parameters: {
                type: "object",
                properties: {
                  projectId: {
                    type: "string",
                    description: "The unique ID of the project to open. Must look up the correct ID from 'projects_list' in the context by matching the name/alias fuzzily.",
                  },
                },
                required: ["projectId"],
              },
            };
          }
          if (cmd.id === "task.open") {
            return {
              name: cmd.id,
              description: "Open/enter a specific task's workspace by its ID or 1-based index",
              parameters: {
                type: "object",
                properties: {
                  taskId: {
                    type: "string",
                    description: "The unique ID of the task to open. Look up from 'tasks_list' in the context.",
                  },
                  taskIndex: {
                    type: "integer",
                    description: "The 1-based index/position of the task in the list (e.g., 1 for the first task, 3 for the third). Use this for relative references like 'the second task'.",
                  },
                },
                required: [],
              },
            };
          }
          if (cmd.id === "chat.switchSession") {
            return {
              name: cmd.id,
              description: "Switch to a specific chat session/agent conversation by its ID or 1-based index",
              parameters: {
                type: "object",
                properties: {
                  sessionId: {
                    type: "string",
                    description: "The unique ID of the session to switch to. Look up from 'active_chat' in the context.",
                  },
                  sessionIndex: {
                    type: "integer",
                    description: "The 1-based index/position of the session in the list (e.g., 1 for the first session, 3 for the third). Use this for relative references like 'the last session'.",
                  },
                },
                required: [],
              },
            };
          }
          return {
            name: cmd.id,
            description: cmd.description || cmd.name,
            parameters: {
              type: "object",
              properties: {},
            },
          };
        });

        const context = voiceControlContextRegistry.collect();
        const result = await executeVoiceControl(blob, tools, context, controller.signal);
        setTranscribing(false);

        if (result.toolCalls && result.toolCalls.length > 0) {
          // Execute actions sequentially with stabilization delays
          const executeToolCallsSequence = async (calls: typeof result.toolCalls) => {
            const failedCommands: string[] = [];
            for (const tc of calls) {
              // 1. Invoke the command; collect failures rather than overwriting the message each time
              const invoked = commandRegistry.invoke(tc.name, tc.arguments);
              if (!invoked) {
                failedCommands.push(tc.name);
              }

              // 2. If the command was a project switch/open or navigation, wait for transition
              if (
                tc.name === "project.open" ||
                tc.name === "project.switch" ||
                tc.name.startsWith("nav.")
              ) {
                // Wait for React to process state change
                await new Promise((resolve) => setTimeout(resolve, 150));
                
                // Wait for project loading to finish if active (5s max to avoid leaking on error)
                if (isLoadingRef.current) {
                  await new Promise<void>((resolve) => {
                    const deadline = Date.now() + 5000;
                    const checkLoading = () => {
                      if (!isLoadingRef.current || Date.now() > deadline) {
                        resolve();
                      } else {
                        setTimeout(checkLoading, 50);
                      }
                    };
                    checkLoading();
                  });
                  // Additional stabilization delay to let components mount and fetch their lists
                  await new Promise((resolve) => setTimeout(resolve, 450));
                } else {
                  // Regular transition stabilization delay
                  await new Promise((resolve) => setTimeout(resolve, 350));
                }
              } else {
                // Small delay between regular commands
                await new Promise((resolve) => setTimeout(resolve, 150));
              }
            }
            if (failedCommands.length > 0) {
              setErrorMessage(`Command unavailable: ${failedCommands.join(", ")}`);
            }
          };

          await executeToolCallsSequence(result.toolCalls);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[voice_control] execution failed:", err);
          setErrorMessage("Voice Control action failed");
        }
        setTranscribing(false);
      }
    },
    // Empty deps: all mutable state is accessed via refs (settingsRef,
    // isLoadingRef, abortRef). Setters (setTranscribing, setErrorMessage)
    // are stable. Adding other values would recreate handleRecordingComplete
    // on every render and force re-subscription in useAudioRecorder.
    []
  );

  const recorder = useAudioRecorder({
    minDuration,
    maxDuration,
    onMaxReached: handleRecordingComplete,
  });

  const recorderRef = useRef(recorder);
  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  // Unified status selector
  const curStatus = useCallback((): IndicatorStatus => {
    if (errorMessage) return "error";
    if (transcribing) return "processing";
    if (pttWarming) return "warming";
    return recorder.status === "recording" ? "recording" : "idle";
  }, [transcribing, pttWarming, errorMessage, recorder.status]);

  const doStart = useCallback(() => {
    recorderRef.current
      .start()
      .catch((err) => {
        console.error("[voice_control] mic access denied:", err);
        setErrorMessage("Microphone access denied");
      });
  }, []);

  const handleToggleStop = useCallback(async () => {
    const blob = await recorderRef.current.stop();
    if (blob) {
      handleRecordingComplete(blob);
    }
  }, [handleRecordingComplete]);

  const startRecording = useCallback(() => {
    const s = settingsRef.current;
    if (!s?.enabled) return;
    const status = curStatus();
    if (status !== "idle" && status !== "error") return;
    setErrorMessage(null);
    doStart();
  }, [curStatus, doStart]);



  const cancelRecording = useCallback(() => {
    recorder.cancel();
    abortRef.current?.abort();
    setTranscribing(false);
    setErrorMessage(null);
  }, [recorder]);

  // Context key binding
  const voiceEnabled = !!settings?.enabled && !recorder.error;
  useContextKey("voiceControlEnabled", voiceEnabled);

  // Cancel PTT warming
  const cancelPTTWarming = useCallback(() => {
    if (pttTimerRef.current) {
      clearTimeout(pttTimerRef.current);
      pttTimerRef.current = null;
    }
    if (pttWarmIntervalRef.current) {
      clearInterval(pttWarmIntervalRef.current);
      pttWarmIntervalRef.current = null;
    }
    pttActiveRef.current = false;
    setPttWarming(false);
    setPttWarmElapsed(0);
    setPttWarmDelay(0);
  }, []);

  // PTT stop release handler
  const handlePTTStop = useCallback(async () => {
    if (!pttActiveRef.current) return;

    if (pttTimerRef.current) {
      cancelPTTWarming();
      return;
    }

    cancelPTTWarming();
    void handleToggleStop();
  }, [cancelPTTWarming, handleToggleStop]);

  // Wire voice_control commands into the command registry so that
  // persistOverride rows for these ids are meaningful (conflict detection,
  // Settings UI keybindings display) and so the commands can be invoked
  // programmatically (e.g. from a future macro system).
  useDefineCommand(
    {
      id: "voice_control.ptt.start",
      name: "Voice Control Push-to-Talk Start",
      category: "Voice Control",
      scope: "workspace",
      defaultWhen: "voiceControlEnabled",
      handler: startRecording,
      enabled: () => voiceEnabled,
    },
    [startRecording, voiceEnabled],
  );
  useDefineCommand(
    {
      id: "voice_control.ptt.stop",
      name: "Voice Control Push-to-Talk Stop",
      category: "Voice Control",
      scope: "workspace",
      defaultWhen: "voiceControlEnabled",
      handler: () => { void handlePTTStop(); },
      enabled: () => voiceEnabled,
    },
    [handlePTTStop, voiceEnabled],
  );
  useDefineCommand(
    {
      id: "voice_control.toggle",
      name: "Voice Control Toggle Recording",
      category: "Voice Control",
      scope: "workspace",
      defaultWhen: "voiceControlEnabled",
      handler: () => {
        if (recorder.status === "recording") {
          void handleToggleStop();
        } else {
          startRecording();
        }
      },
      enabled: () => voiceEnabled,
    },
    [recorder.status, handleToggleStop, startRecording, voiceEnabled],
  );

  // Keyboard Event Handlers
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s?.enabled) return;

      const activeEl = document.activeElement;
      const insideInput =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        (activeEl instanceof HTMLElement && activeEl.isContentEditable);

      // 1. Toggle shortcut trigger (Combo matches, ignore if typing)
      if (s.toggleShortcut && matchesShortcut(event, s.toggleShortcut)) {
        if (insideInput) return; // avoid blocking typing
        event.preventDefault();
        event.stopPropagation();

        const status = curStatus();
        if (status === "recording") {
          void handleToggleStop();
        } else {
          startRecording();
        }
        return;
      }

      // 2. PTT shortcut keydown trigger (Single key matches)
      if (s.pushToTalkKey && matchesPTTKey(event, s.pushToTalkKey)) {
        if (insideInput) return;
        event.preventDefault();
        event.stopPropagation();

        if (pttActiveRef.current) return; // repeat key events

        pttActiveRef.current = true;

        const delay = pttActivationDelayMs(s);
        setPttWarmDelay(delay);
        setPttWarming(true);
        setPttWarmElapsed(0);

        const startMs = Date.now();
        pttWarmIntervalRef.current = setInterval(() => {
          setPttWarmElapsed(Math.min(delay, Date.now() - startMs));
        }, 30);

        pttTimerRef.current = setTimeout(() => {
          if (pttWarmIntervalRef.current) clearInterval(pttWarmIntervalRef.current);
          pttWarmIntervalRef.current = null;
          pttTimerRef.current = null;
          setPttWarming(false);
          doStart();
        }, delay);
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s?.enabled || !s.pushToTalkKey) return;

      if (matchesPTTKey(event, s.pushToTalkKey)) {
        event.preventDefault();
        event.stopPropagation();
        void handlePTTStop();
      }
    };

    const handleWindowBlur = () => {
      if (pttActiveRef.current) {
        void handlePTTStop();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [handleToggleStop, handlePTTStop, doStart, startRecording, curStatus]);

  if (!settings?.enabled) return null;

  // Derive status details for overlay indicator
  let indicatorStatus: IndicatorStatus = recorder.status === "recording" ? "recording" : "idle";
  if (transcribing) indicatorStatus = "processing";
  if (pttWarming) indicatorStatus = "warming";
  if (errorMessage && indicatorStatus !== "processing") indicatorStatus = "error";

  const indicatorErrorMessage = errorMessage ?? recorder.error;

  return (
    <RecordingIndicator
      status={indicatorStatus}
      elapsed={recorder.elapsed}
      maxDuration={settings.maxDuration}
      frequencyData={recorder.frequencyData}
      warmingProgress={pttWarmDelay > 0 ? pttWarmElapsed / pttWarmDelay : 0}
      errorMessage={indicatorErrorMessage}
      onStop={handleToggleStop}
      onCancel={() => {
        cancelPTTWarming();
        cancelRecording();
      }}
    />
  );
}
