import { useRef, useCallback, useState } from "react";
import type { GroupSnapshot } from "../../data/types";

interface ChannelGridProps {
  group: GroupSnapshot | null;
  selectedPosition: number | null;
  recordingPosition: number | null;
  onTap: (position: number) => void;
  onHoldStart: (position: number) => void;
  onHoldEnd: (position: number) => void;
  onCancel: (position: number) => void;
}

interface ChannelButtonProps {
  position: number;
  taskName: string | null;
  agentStatus: "idle" | "busy" | "disconnected" | null;
  isSelected: boolean;
  isRecording: boolean;
  onTap: (position: number) => void;
  onHoldStart: (position: number) => void;
  onHoldEnd: (position: number) => void;
  onCancel: (position: number) => void;
}

const CANCEL_THRESHOLD = 80; // pixels to drag up to trigger cancel

function ChannelButton({
  position,
  taskName,
  agentStatus,
  isSelected,
  isRecording,
  onTap,
  onHoldStart,
  onHoldEnd,
  onCancel,
}: ChannelButtonProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdingRef = useRef(false);
  const dragStartYRef = useRef<number | null>(null);
  const isCancellingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const finishHold = useCallback(() => {
    holdingRef.current = false;
    if (pointerIdRef.current !== null && buttonRef.current) {
      try { buttonRef.current.releasePointerCapture(pointerIdRef.current); } catch { /* pointer may already be released */ }
      pointerIdRef.current = null;
    }
    if (isCancellingRef.current) {
      onCancel(position);
    } else {
      onHoldEnd(position);
    }
    dragStartYRef.current = null;
    isCancellingRef.current = false;
    setIsCancelling(false);
  }, [position, onHoldEnd, onCancel]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (taskName === null) return;
    const startY = e.clientY;
    const pointerId = e.pointerId;
    holdingRef.current = false;
    dragStartYRef.current = null;
    isCancellingRef.current = false;
    setIsCancelling(false);
    timerRef.current = setTimeout(() => {
      holdingRef.current = true;
      dragStartYRef.current = startY;
      pointerIdRef.current = pointerId;
      const btn = buttonRef.current;
      if (btn) {
        try { btn.setPointerCapture(pointerId); } catch { /* pointer may already be released */ }
      }
      onHoldStart(position);
    }, 300);
  }, [position, taskName, onHoldStart]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!holdingRef.current || dragStartYRef.current === null) return;
    const deltaY = dragStartYRef.current - e.clientY;
    const shouldCancel = deltaY >= CANCEL_THRESHOLD;
    if (shouldCancel !== isCancellingRef.current) {
      isCancellingRef.current = shouldCancel;
      setIsCancelling(shouldCancel);
    }
  }, []);

  const handlePointerUp = useCallback(() => {
    clearTimer();
    if (holdingRef.current) {
      finishHold();
    } else {
      // Release capture if hold didn't start yet
      if (pointerIdRef.current !== null && buttonRef.current) {
        try { buttonRef.current.releasePointerCapture(pointerIdRef.current); } catch { /* pointer may already be released */ }
        pointerIdRef.current = null;
      }
      if (taskName !== null) {
        onTap(position);
      }
    }
  }, [position, taskName, clearTimer, onTap, finishHold]);

  const handlePointerLeave = useCallback(() => {
    clearTimer();
    if (holdingRef.current) {
      finishHold();
    }
  }, [clearTimer, finishHold]);

  const isEmpty = taskName === null;
  const showCancel = isRecording && isCancelling;

  const borderStyle = isRecording
    ? showCancel
      ? "border-[var(--color-error)]"
      : "border-[var(--color-warning)]"
    : isSelected
      ? "border-[var(--color-highlight)]"
      : isEmpty
        ? "border-dashed border-[var(--color-border)]"
        : "border-[var(--color-border)]";

  const bgStyle = isEmpty
    ? "bg-[var(--color-bg)]/50"
    : showCancel
      ? "bg-[var(--color-error)]/20"
      : "bg-[var(--color-bg-secondary)]";

  const glowStyle = isRecording
    ? showCancel
      ? { boxShadow: `0 0 30px color-mix(in srgb, var(--color-error) 60%, transparent)`, animation: "pulse-cancel 0.4s ease-in-out infinite" }
      : { boxShadow: `0 0 20px color-mix(in srgb, var(--color-warning) 30%, transparent)` }
    : isSelected
      ? { boxShadow: `0 0 16px color-mix(in srgb, var(--color-highlight) 25%, transparent)` }
      : {};

  return (
    <button
      ref={buttonRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onPointerCancel={handlePointerLeave}
      onContextMenu={(e) => e.preventDefault()}
      className={`touch-none select-none relative flex h-full flex-col overflow-hidden rounded-xl border ${borderStyle} ${bgStyle} transition-all active:scale-[0.97]`}
      style={glowStyle}
    >
      {/* Watermark number */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span
          className="font-mono font-bold leading-none"
          style={{
            fontSize: isEmpty ? "32px" : "48px",
            color: isSelected
              ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)"
              : "color-mix(in srgb, var(--color-text-muted) 10%, transparent)",
          }}
        >
          {position}
        </span>
      </div>

      {/* Content overlay */}
      <div className="relative flex flex-1 flex-col p-2">
        {/* Top: small channel number + status */}
        <div className="flex items-center justify-between">
          <span
            className="font-mono text-[11px] font-semibold"
            style={{ color: isSelected ? "var(--color-highlight)" : "var(--color-text-muted)" }}
          >
            {position}
          </span>
          {!isEmpty && (
            <span
              className="h-2 w-2 rounded-full"
              style={{
                backgroundColor: agentStatus === "busy"
                  ? "var(--color-warning)"
                  : agentStatus === "idle"
                    ? "var(--color-success)"
                    : "var(--color-text-muted)",
                boxShadow: agentStatus === "busy"
                  ? "0 0 8px var(--color-warning)"
                  : agentStatus === "idle"
                    ? "0 0 8px var(--color-success)"
                    : "none",
                opacity: agentStatus === "disconnected" ? 0.3 : 1,
              }}
            />
          )}
        </div>

        {/* Center: task name */}
        <div className="flex flex-1 items-center justify-center min-h-0">
          {isEmpty ? (
            <span className="text-[11px]" style={{ color: "var(--color-text-muted)", opacity: 0.4 }}>
              Empty
            </span>
          ) : (
            <div
              className="w-full text-center text-[13px] font-medium leading-snug line-clamp-2 break-all"
              style={{ color: "var(--color-text)" }}
              title={taskName ?? ""}
            >
              {taskName}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

export default function ChannelGrid({
  group,
  selectedPosition,
  recordingPosition,
  onTap,
  onHoldStart,
  onHoldEnd,
  onCancel,
}: ChannelGridProps) {
  const positions = [1, 2, 3, 4, 5, 6, 7, 8, 9];

  return (
    <div className="grid flex-1 grid-cols-3 grid-rows-3 gap-2">
      {positions.map((pos) => {
        const status = group?.slot_statuses[pos] ?? null;
        return (
          <ChannelButton
            key={pos}
            position={pos}
            taskName={status?.task_name ?? null}
            agentStatus={status?.agent_status ?? null}
            isSelected={selectedPosition === pos}
            isRecording={recordingPosition === pos}
            onTap={onTap}
            onHoldStart={onHoldStart}
            onHoldEnd={onHoldEnd}
            onCancel={onCancel}
          />
        );
      })}
    </div>
  );
}
