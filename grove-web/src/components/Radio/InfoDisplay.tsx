import { useMemo } from "react";
import type { GroupSnapshot, ChatRef } from "../../data/types";

interface InfoDisplayProps {
  group: GroupSnapshot | null;
  selectedPosition: number | null;
  activeChat: ChatRef | null;
  isRecording: boolean;
  recordingElapsed: number;
  frequencyData: Uint8Array | null;
  isTranscribing: boolean;
  promptStatus: { status: "ok" | "error"; error?: string } | null;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Waveform({ frequencyData }: { frequencyData: Uint8Array | null }) {
  const bars = 28;
  const heights = useMemo(() => {
    const result: number[] = [];
    for (let i = 0; i < bars; i++) {
      if (frequencyData && frequencyData.length > 0) {
        const index = Math.floor((i / bars) * frequencyData.length);
        const value = frequencyData[index];
        result.push(4 + (value / 255) * 28);
      } else {
        result.push(4);
      }
    }
    return result;
  }, [frequencyData]);

  return (
    <div className="flex h-7 items-end gap-[2px]">
      {heights.map((h, i) => (
        <div
          key={i}
          className="rounded-sm"
          style={{
            width: 3,
            height: h,
            transition: "height 0.1s ease",
            backgroundColor: "var(--color-warning)",
          }}
        />
      ))}
    </div>
  );
}

export default function InfoDisplay({
  group,
  selectedPosition,
  activeChat,
  isRecording,
  recordingElapsed,
  frequencyData,
  isTranscribing,
  promptStatus,
}: InfoDisplayProps) {
  const slotStatus =
    group && selectedPosition !== null
      ? group.slot_statuses[selectedPosition] ?? null
      : null;

  const borderColor = isRecording
    ? "var(--color-warning)"
    : isTranscribing
      ? "var(--color-accent)"
      : "var(--color-border)";

  const statusLabel = isRecording
    ? "Recording"
    : isTranscribing
      ? "Transcribing..."
      : promptStatus
        ? promptStatus.status === "ok" ? "Sent" : "Error"
        : "Ready";

  const statusColor = isRecording
    ? "var(--color-warning)"
    : isTranscribing
      ? "var(--color-accent)"
      : promptStatus
        ? promptStatus.status === "ok" ? "var(--color-success)" : "var(--color-error)"
        : "var(--color-text-muted)";

  return (
    <div
      className="rounded-xl border px-3 py-2.5 transition-colors"
      style={{ borderColor, backgroundColor: "var(--color-bg)" }}
    >
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: statusColor }}>
            {statusLabel}
          </div>
          <div className="mt-0.5 truncate text-[15px] font-semibold" style={{ color: "var(--color-text)" }}>
            {slotStatus ? slotStatus.task_name : "No Channel Selected"}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[10px] uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
            CH
          </div>
          <div className="font-mono text-[18px] font-semibold leading-none" style={{ color: "var(--color-highlight)" }}>
            {selectedPosition !== null ? String(selectedPosition).padStart(2, "0") : "--"}
          </div>
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px]" style={{ color: "var(--color-text-muted)" }}>
            {activeChat ? `${activeChat.agent} / ${activeChat.title}` : isRecording ? "Recording..." : "No session"}
          </div>
        </div>

        {isRecording && (
          <div className="shrink-0 flex items-center gap-2">
            <Waveform frequencyData={frequencyData} />
            <span className="font-mono text-[11px]" style={{ color: "var(--color-warning)" }}>
              {formatTime(recordingElapsed)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
