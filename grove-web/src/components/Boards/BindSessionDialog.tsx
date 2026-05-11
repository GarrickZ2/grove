import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Code, Laptop, Plus, X } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { SessionRow } from "./SessionRow";
import type { SessionBinding, SessionStatus } from "./types";

interface MockSession {
  id: string;
  preview: string;
  status: SessionStatus;
  agentId?: string;
  elapsedSeconds?: number;
  durationSeconds?: number;
  todoCompleted?: number;
  todoTotal?: number;
}

interface MockTask {
  id: string;
  name: string;
  kind: "worktree" | "local";
  branch?: string;
  sessions: MockSession[];
}

const MOCK_TASKS: MockTask[] = [
  {
    id: "t-101",
    name: "migrate-storage",
    kind: "worktree",
    branch: "feat/migrate-storage",
    sessions: [
      {
        id: "s-101-a",
        preview: "Initial schema design",
        status: "idle",
        agentId: "claude",
        elapsedSeconds: 1080,
      },
      {
        id: "s-101-b",
        preview: "Migration runner",
        status: "working",
        agentId: "codex",
        elapsedSeconds: 145,
        todoCompleted: 2,
        todoTotal: 6,
      },
    ],
  },
  {
    id: "t-102",
    name: "acp-fork",
    kind: "worktree",
    branch: "feat/acp-fork",
    sessions: [
      {
        id: "s-102-a",
        preview: "Fork API exploration",
        status: "working",
        agentId: "claude",
        elapsedSeconds: 38,
      },
    ],
  },
  {
    id: "_local",
    name: "_local",
    kind: "local",
    sessions: [
      {
        id: "s-local-1",
        preview: "Quick notes",
        status: "idle",
        agentId: "claude",
        elapsedSeconds: 7200,
      },
    ],
  },
];

interface BindSessionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onBind: (binding: SessionBinding) => void;
}

export function BindSessionDialog({ isOpen, onClose, onBind }: BindSessionDialogProps) {
  const [step, setStep] = useState<"task" | "session">("task");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [newSessionLabel, setNewSessionLabel] = useState("");
  const idCounterRef = useRef(0);

  const selectedTask = MOCK_TASKS.find((t) => t.id === selectedTaskId);

  function handleClose() {
    setStep("task");
    setSelectedTaskId(null);
    setNewSessionLabel("");
    onClose();
  }

  function pickExistingSession(s: MockSession) {
    if (!selectedTask) return;
    onBind({
      id: s.id,
      taskId: selectedTask.id,
      taskName: selectedTask.name,
      taskKind: selectedTask.kind,
      status: s.status,
      ownerEmail: "you@grove.local",
      agentId: s.agentId,
      preview: s.preview,
      elapsedSeconds: s.elapsedSeconds,
      durationSeconds: s.durationSeconds,
      todoCompleted: s.todoCompleted,
      todoTotal: s.todoTotal,
    });
    handleClose();
  }

  function createNewSession() {
    if (!selectedTask || !newSessionLabel.trim()) return;
    idCounterRef.current += 1;
    onBind({
      id: `s-new-${idCounterRef.current}`,
      taskId: selectedTask.id,
      taskName: selectedTask.name,
      taskKind: selectedTask.kind,
      status: "idle",
      ownerEmail: "you@grove.local",
      agentId: "claude",
      preview: newSessionLabel.trim(),
      elapsedSeconds: 0,
    });
    handleClose();
  }

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose} maxWidth="max-w-lg">
      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {step === "session" && (
              <button
                onClick={() => setStep("task")}
                className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] flex-shrink-0"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-[var(--color-text)] truncate">
                {step === "task" ? "Bind Session — pick a Task" : `Bind Session — ${selectedTask?.name}`}
              </h2>
              <p className="text-[11.5px] text-[var(--color-text-muted)] mt-0.5">
                {step === "task"
                  ? "Sessions are always under a Task. Pick the Task first."
                  : "Pick an existing Session or start a new one."}
              </p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 max-h-[440px] overflow-y-auto">
          {step === "task" && (
            <div className="space-y-1.5">
              {MOCK_TASKS.map((task) => {
                const Icon = task.kind === "local" ? Laptop : Code;
                return (
                  <button
                    key={task.id}
                    onClick={() => {
                      setSelectedTaskId(task.id);
                      setStep("session");
                    }}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/40 hover:bg-[var(--color-bg-tertiary)] transition-all text-left"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Icon
                        className="w-4 h-4 flex-shrink-0"
                        style={{
                          color:
                            task.kind === "local" ? "var(--color-accent)" : "var(--color-highlight)",
                        }}
                      />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[var(--color-text)] truncate">
                          {task.name}
                        </div>
                        {task.branch && (
                          <div className="text-[11px] text-[var(--color-text-muted)] truncate font-mono">
                            {task.branch}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-[11px] text-[var(--color-text-muted)]">
                        {task.sessions.length} session{task.sessions.length !== 1 ? "s" : ""}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {step === "session" && selectedTask && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] px-1">
                  Existing sessions
                </div>
                {selectedTask.sessions.length === 0 && (
                  <div className="text-[11px] text-[var(--color-text-muted)] px-3 py-2">
                    No sessions yet — create one below.
                  </div>
                )}
                {selectedTask.sessions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => pickExistingSession(s)}
                    className="w-full text-left rounded-lg border border-transparent hover:border-[var(--color-highlight)]/30 transition-all p-0.5"
                  >
                    <SessionRow
                      session={{
                        id: s.id,
                        taskId: selectedTask.id,
                        taskName: selectedTask.name,
                        taskKind: selectedTask.kind,
                        status: s.status,
                        ownerEmail: "you@grove.local",
                        agentId: s.agentId,
                        preview: s.preview,
                        elapsedSeconds: s.elapsedSeconds,
                        durationSeconds: s.durationSeconds,
                        todoCompleted: s.todoCompleted,
                        todoTotal: s.todoTotal,
                      }}
                    />
                  </button>
                ))}
              </div>

              <div className="space-y-2 pt-2 border-t border-[var(--color-border)]">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] px-1">
                  Or start a new session
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Session label (e.g. Refactor parser)"
                    value={newSessionLabel}
                    onChange={(e) => setNewSessionLabel(e.target.value)}
                  />
                  <Button onClick={createNewSession} disabled={!newSessionLabel.trim()}>
                    <Plus className="w-3.5 h-3.5 mr-1" />
                    New
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--color-border)] flex justify-end gap-2 bg-[var(--color-bg-secondary)]/40">
          <Button variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
        </div>
      </div>
    </DialogShell>
  );
}
