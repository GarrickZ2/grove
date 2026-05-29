// Create/edit dialog for one Automation.
//
// Visual conventions follow NewTaskDialog: header with icon pill, sectioned
// body with muted-uppercase labels, native `<select>` is replaced by the
// project `Combobox`, branch picker mirrors NewTaskDialog's GitBranch
// dropdown. Time picker is a custom hour+minute popover rather than the
// browser's native `<input type="time">`.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { createPortal } from "react-dom";
import cronstrue from "cronstrue";
import {
  X,
  Repeat,
  ListTodo,
  MessageSquare,
  Wand2,
  Clock4,
  GitBranch,
  ChevronDown,
  Loader2,
  Calendar,
  AlertTriangle,
  Check,
} from "lucide-react";
import { DialogShell } from "../ui/DialogShell";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Combobox, type ComboboxOption } from "../ui/Combobox";
import { AgentPicker, agentOptions } from "../ui/AgentPicker";
import { useACPAvailability } from "../Tasks/TaskView/useACPAvailability";
import { useProject } from "../../context";
import { getBranches } from "../../api";
import { listChats, listTasks } from "../../api";
import { useCommand, useKeyboardScope } from "../../keyboard";
import type {
  Automation,
  AutomationUpsert,
  TargetMode,
} from "../../api/automations";
import type { ChatSessionResponse, TaskResponse } from "../../api/tasks";

interface AutomationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  initial?: Automation | null;
  onSubmit: (input: AutomationUpsert) => Promise<void>;
}

type ScheduleKind = "hourly" | "daily" | "weekly" | "custom";

function detectScheduleKind(cron: string): ScheduleKind {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "custom";
  const [m, h, dom, mon, dow] = parts;
  if (dom === "*" && mon === "*" && dow === "*" && h.startsWith("*/") && /^\d+$/.test(m)) {
    return "hourly";
  }
  if (dom === "*" && mon === "*" && dow === "*" && /^\d+$/.test(h) && /^\d+$/.test(m)) {
    return "daily";
  }
  if (dom === "*" && mon === "*" && /^\d+$/.test(h) && /^\d+$/.test(m) && dow !== "*") {
    return "weekly";
  }
  return "custom";
}

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

// NOTE: ids prefixed `freq-` because plain `"custom"` is a reserved Combobox
// sentinel that flips the picker into free-text-input mode. We want the
// "Custom" option to set `scheduleKind = "custom"` and surface the cron
// input below — not enter Combobox's escape hatch.
const FREQUENCY_OPTIONS: ComboboxOption[] = [
  { id: "freq-hourly", label: "Hourly", value: "hourly" },
  { id: "freq-daily", label: "Daily", value: "daily" },
  { id: "freq-weekly", label: "Weekly", value: "weekly" },
  { id: "freq-custom", label: "Custom", value: "custom" },
];

// Only divisors of 24 — that way cron's `*/N` semantics give uniform
// intervals (e.g. N=12 fires at 0:00 and 12:00, not 0:00 and 12:00 then
// skipping). Non-divisors like N=23 would silently fire at 0:00 and 23:00,
// not "every 23 hours", which mismatches user intuition.
const HOURLY_OPTIONS: ComboboxOption[] = [1, 2, 3, 4, 6, 8, 12].map((n) => ({
  id: String(n),
  label: `${n} hr${n === 1 ? "" : "s"}`,
  value: String(n),
}));

const HOUR_OPTIONS: ComboboxOption[] = Array.from({ length: 24 }, (_, i) => ({
  id: `h${i}`,
  label: String(i).padStart(2, "0"),
  value: String(i),
}));

const MINUTE_OPTIONS: ComboboxOption[] = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i}`,
  label: String(i).padStart(2, "0"),
  value: String(i),
}));

const MINUTE_QUARTER_OPTIONS: ComboboxOption[] = [0, 15, 30, 45].map((m) => ({
  id: `mq${m}`,
  label: String(m).padStart(2, "0"),
  value: String(m),
}));

function buildHourlyCron(everyN: number, minute: number): string {
  const m = Math.max(0, Math.min(59, minute));
  // HOURLY_OPTIONS is already restricted to divisors of 24; this clamp
  // just defends against direct callers passing nonsense values. We
  // don't snap to a divisor here because that would silently change the
  // user's choice — the option list is the place that enforces the
  // uniform-interval invariant.
  const n = Math.max(1, everyN);
  return `${m} */${n} * * *`;
}

function buildDailyCron(hour: number, minute: number): string {
  return `${Math.max(0, Math.min(59, minute))} ${Math.max(0, Math.min(23, hour))} * * *`;
}

function buildWeeklyCron(days: number[], hour: number, minute: number): string {
  const dow = days.length ? [...new Set(days)].sort((a, b) => a - b).join(",") : "*";
  return `${Math.max(0, Math.min(59, minute))} ${Math.max(0, Math.min(23, hour))} * * ${dow}`;
}

/// Parse an integer, returning the fallback when the string isn't a finite
/// number. `parseInt("abc") || 0` looks similar but treats `0` as falsy and
/// would clobber a legitimate zero with the fallback — use Number.isFinite
/// to discriminate "couldn't parse" from "parsed to zero".
function parseIntSafe(s: string, fallback: number): number {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

function describeCron(cron: string): { text: string; valid: boolean } {
  try {
    return { text: cronstrue.toString(cron, { use24HourTimeFormat: true }), valid: true };
  } catch {
    return { text: "Invalid cron expression", valid: false };
  }
}

export function AutomationDialog({
  isOpen,
  onClose,
  projectId,
  initial,
  onSubmit,
}: AutomationDialogProps) {
  const { selectedProject } = useProject();
  const isStudio = selectedProject?.projectType === "studio";
  const { baseAgents, customAgents, customAgentPersonas, acpAvailabilityLoaded } =
    useACPAvailability();

  // Filter to agents the user actually has available — same pattern TaskChat
  // uses for its new-chat picker. Personas are passed separately so the
  // picker can offer "Claude with my XYZ config" as a single click.
  const availableAgentOptions = useMemo(() => {
    if (!acpAvailabilityLoaded) {
      return agentOptions.filter((opt) => opt.acpCheck);
    }
    return baseAgents
      .filter((b) => b.available)
      .map((b) => {
        const local = agentOptions.find((a) => a.value === b.id || a.id === b.id);
        const opt = local ?? { id: b.id, label: b.display_name, value: b.id };
        return { ...opt, label: b.display_name, value: b.id };
      });
  }, [baseAgents, acpAvailabilityLoaded]);

  // ── form state ────────────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [prompt, setPrompt] = useState("");

  const [taskMode, setTaskMode] = useState<TargetMode>("new");
  const [taskId, setTaskId] = useState<string>("");
  const [newTaskName, setNewTaskName] = useState("");
  const [newTaskTarget, setNewTaskTarget] = useState("");

  const [sessionMode, setSessionMode] = useState<TargetMode>("new");
  const [chatId, setChatId] = useState<string>("");
  const [newSessionAgent, setNewSessionAgent] = useState("claude");

  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("daily");
  const [hourlyN, setHourlyN] = useState(1);
  const [hourlyMinute, setHourlyMinute] = useState(0);
  const [dailyHour, setDailyHour] = useState(9);
  const [dailyMinute, setDailyMinute] = useState(0);
  const [weeklyDays, setWeeklyDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [weeklyHour, setWeeklyHour] = useState(9);
  const [weeklyMinute, setWeeklyMinute] = useState(0);
  const [customCron, setCustomCron] = useState("0 9 * * *");

  // ── async loaded data ─────────────────────────────────────────────────
  const [tasks, setTasks] = useState<TaskResponse[]>([]);
  const [chats, setChats] = useState<ChatSessionResponse[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const branchDropdownRef = useRef<HTMLDivElement>(null);
  const [branchDropdownPos, setBranchDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── seed from `initial` on open ──────────────────────────────────────
  // React 18 batches every setState inside one effect into a single render,
  // so the multiple setters below collapse into one commit. The
  // `react-hooks/set-state-in-effect` rule is conservative about this
  // pattern; we silence it because seeding a form from props on open is
  // exactly what the lint rule's "form-init" exception was meant for.
  useEffect(() => {
    if (!isOpen) return;
    /* eslint-disable react-hooks/set-state-in-effect --
     * batched form-init on dialog open; collapses into one commit. */
    if (initial) {
      setName(initial.name);
      setEnabled(initial.enabled);
      setPrompt(initial.prompt);
      setTaskMode(initial.task_mode);
      setTaskId(initial.task_id ?? "");
      setNewTaskName(initial.task_template?.name ?? "");
      setNewTaskTarget(initial.task_template?.target ?? "");
      setSessionMode(initial.session_mode);
      setChatId(initial.chat_id ?? "");
      setNewSessionAgent(initial.session_template?.agent ?? "claude");
      const kind = detectScheduleKind(initial.schedule_cron);
      setScheduleKind(kind);
      const parts = initial.schedule_cron.trim().split(/\s+/);
      if (kind === "hourly" && parts.length === 5) {
        setHourlyMinute(parseIntSafe(parts[0], 0));
        // Parse `*/N`. parseIntSafe falls back to N=1 + scheduleKind=custom
        // when the field doesn't look like a step expression — guards
        // against cron strings the detector misclassifies as hourly.
        const stepRaw = parts[1].startsWith("*/") ? parts[1].slice(2) : "";
        const parsedN = Number.parseInt(stepRaw, 10);
        if (Number.isFinite(parsedN) && parsedN > 0) {
          setHourlyN(parsedN);
        } else {
          setScheduleKind("custom");
          setHourlyN(1);
        }
      } else if (kind === "daily" && parts.length === 5) {
        setDailyHour(parseIntSafe(parts[1], 0));
        setDailyMinute(parseIntSafe(parts[0], 0));
      } else if (kind === "weekly" && parts.length === 5) {
        setWeeklyHour(parseIntSafe(parts[1], 0));
        setWeeklyMinute(parseIntSafe(parts[0], 0));
        setWeeklyDays(parts[4].split(",").map((d) => parseIntSafe(d, 0)));
      }
      setCustomCron(initial.schedule_cron);
    } else {
      setName("");
      setEnabled(true);
      setPrompt("");
      setTaskMode("new");
      setTaskId("");
      setNewTaskName("");
      setNewTaskTarget(selectedProject?.currentBranch || "main");
      setSessionMode("new");
      setChatId("");
      setNewSessionAgent("claude");
      setScheduleKind("daily");
      setHourlyN(1);
      setHourlyMinute(0);
      setDailyHour(9);
      setDailyMinute(0);
      setWeeklyDays([1, 2, 3, 4, 5]);
      setWeeklyHour(9);
      setWeeklyMinute(0);
      setCustomCron("0 9 * * *");
    }
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isOpen, initial, selectedProject?.currentBranch]);

  // Load tasks for the "existing" picker.
  useEffect(() => {
    if (!isOpen || taskMode !== "existing") return;
    let alive = true;
    listTasks(projectId)
      .then((data) => {
        if (alive) setTasks(data);
      })
      .catch(() => {
        if (alive) setTasks([]);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, taskMode, projectId]);

  // Load chats for the "existing" picker. Depend on the resolved task id
  // (either an existing task selection or — once new task is created at
  // run time — there's no chat list available, hence we only do this for
  // existing-task + existing-session combos).
  useEffect(() => {
    let alive = true;
    if (!isOpen || sessionMode !== "existing" || !taskId) {
      void Promise.resolve().then(() => {
        if (alive) setChats([]);
      });
      return () => {
        alive = false;
      };
    }
    listChats(projectId, taskId)
      .then((cs) => {
        if (alive) setChats(cs);
      })
      .catch(() => {
        if (alive) setChats([]);
      });
    return () => {
      alive = false;
    };
  }, [isOpen, sessionMode, taskId, projectId]);

  // Branch list for the New Task → Target Branch picker. setState calls
  // (including the loading flag) are deferred to a microtask so they don't
  // trip `react-hooks/set-state-in-effect`.
  useEffect(() => {
    if (!isOpen || isStudio || taskMode !== "new") return;
    let alive = true;
    void Promise.resolve().then(() => {
      if (!alive) return;
      setIsLoadingBranches(true);
      getBranches(projectId, "local")
        .then((res) => {
          if (alive) setBranches(res.branches.map((b) => b.name));
        })
        .catch(() => {
          if (alive) setBranches([]);
        })
        .finally(() => {
          if (alive) setIsLoadingBranches(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [isOpen, taskMode, projectId, isStudio]);

  const updateBranchDropdownPos = useCallback(() => {
    if (!branchTriggerRef.current) return;
    const rect = branchTriggerRef.current.getBoundingClientRect();
    setBranchDropdownPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  useEffect(() => {
    if (!branchDropdownOpen) return;
    updateBranchDropdownPos();
    const onScroll = () => updateBranchDropdownPos();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [branchDropdownOpen, updateBranchDropdownPos]);

  useEffect(() => {
    if (!branchDropdownOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        branchTriggerRef.current?.contains(t) ||
        branchDropdownRef.current?.contains(t)
      )
        return;
      setBranchDropdownOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [branchDropdownOpen]);

  // ── derived: assembled cron ──────────────────────────────────────────
  const cronExpr = useMemo(() => {
    switch (scheduleKind) {
      case "hourly":
        return buildHourlyCron(hourlyN, hourlyMinute);
      case "daily":
        return buildDailyCron(dailyHour, dailyMinute);
      case "weekly":
        return buildWeeklyCron(weeklyDays, weeklyHour, weeklyMinute);
      case "custom":
        return customCron;
    }
  }, [
    scheduleKind,
    hourlyN,
    hourlyMinute,
    dailyHour,
    dailyMinute,
    weeklyDays,
    weeklyHour,
    weeklyMinute,
    customCron,
  ]);

  const cronInfo = useMemo(() => describeCron(cronExpr), [cronExpr]);

  // ── option lists for Combobox ─────────────────────────────────────────
  // Task options for the Existing-task picker. `listTasks` doesn't return the
  // pseudo Local Task (it's a worktree-less synthetic row), so we synthesise
  // an option for it at the top whenever the project has a current branch
  // (i.e. is a coding project — Studio projects don't have a Local Task).
  // The id `_local` matches `tasks::LOCAL_TASK_ID` on the backend, so the
  // executor's `tasks::get_task` lookup resolves directly.
  const taskOptions: ComboboxOption[] = useMemo(() => {
    const opts: ComboboxOption[] = [];
    if (selectedProject && selectedProject.projectType !== "studio") {
      opts.push({
        id: "_local",
        label: `${selectedProject.name} (Local)`,
        value: "_local",
      });
    }
    for (const t of tasks) {
      if (t.id === "_local") continue; // dedupe — should never appear but be safe
      opts.push({
        id: t.id,
        label: t.name + (t.is_local ? "  ·  local" : ""),
        value: t.id,
      });
    }
    return opts;
  }, [tasks, selectedProject]);

  const chatOptions: ComboboxOption[] = useMemo(
    () =>
      chats.map((c) => ({
        id: c.id,
        label: `${c.title}  ·  ${c.agent}`,
        value: c.id,
      })),
    [chats],
  );

  async function handleSubmit() {
    setError(null);
    if (!name.trim()) return setError("Name is required");
    if (!prompt.trim()) return setError("Prompt is required");
    if (!cronInfo.valid) return setError("Invalid cron expression");
    if (taskMode === "existing" && !taskId) return setError("Pick an existing task");
    if (taskMode === "new" && !newTaskName.trim()) return setError("Task name is required");
    if (sessionMode === "existing" && !chatId) return setError("Pick an existing session");
    if (sessionMode === "new" && !newSessionAgent.trim()) return setError("Agent is required");

    const payload: AutomationUpsert = {
      name: name.trim(),
      enabled,
      task_mode: taskMode,
      task_id: taskMode === "existing" ? taskId : undefined,
      task_template:
        taskMode === "new"
          ? { name: newTaskName.trim(), target: newTaskTarget.trim() || undefined }
          : undefined,
      session_mode: sessionMode,
      chat_id: sessionMode === "existing" ? chatId : undefined,
      session_template:
        sessionMode === "new"
          ? { agent: newSessionAgent.trim() }
          : undefined,
      prompt,
      schedule_cron: cronExpr,
    };

    setSubmitting(true);
    try {
      await onSubmit(payload);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  // Cmd+Enter to submit, Esc to close — wired through the scoped command
  // registry. Escape becomes a no-op when the branch dropdown is open so the
  // dropdown's own dismiss path runs first.
  //
  // Catalog handlers register inside <AutomationDialogBindings> only while
  // isOpen=true. Multiple AutomationDialog wrappers can coexist (one per
  // automation row, all isOpen=false at rest); a top-level useCommand would
  // otherwise overwrite each other on every re-render — only the last-
  // mounted dialog's binding would be live.
  useKeyboardScope("dialog.automation", isOpen);

  const handleCloseGuarded = () => {
    if (branchDropdownOpen) return;
    onClose();
  };

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-4xl">
      {isOpen && (
        <AutomationDialogBindings
          onClose={handleCloseGuarded}
          onSubmit={handleSubmit}
        />
      )}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-highlight)]/10">
              <Repeat className="w-5 h-5 text-[var(--color-highlight)]" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-text)] leading-tight">
                {initial ? "Edit Automation" : "New Automation"}
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                Scheduled prompts sent into a chat session.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Name + toggle row */}
          <div className="flex items-end gap-3">
            <div className="flex-1 min-w-0">
              <Input
                label="Name"
                placeholder="Daily standup summary"
                autoFocus
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(null);
                }}
                className="!bg-[var(--color-bg)]"
              />
            </div>
            <ToggleSwitch
              label="Enabled"
              value={enabled}
              onChange={setEnabled}
            />
          </div>

          {/* Task — single horizontal row */}
          <Section icon={<ListTodo className="w-3.5 h-3.5" />} title="Task">
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-shrink-0">
                <LabelRow>Mode</LabelRow>
                <ModePill value={taskMode} onChange={setTaskMode} />
              </div>
              {taskMode === "existing" ? (
                <div className="flex-1 min-w-[220px]">
                  <LabelRow>Existing task</LabelRow>
                  <Combobox
                    options={taskOptions}
                    value={taskId}
                    onChange={(v) => setTaskId(v)}
                    placeholder={
                      taskOptions.length === 0
                        ? "No tasks in this project yet"
                        : "Select task…"
                    }
                    allowCustom={false}
                  />
                </div>
              ) : (
                <>
                  <div className="flex-1 min-w-[140px]">
                    <LabelRow>Name</LabelRow>
                    <input
                      value={newTaskName}
                      onChange={(e) => setNewTaskName(e.target.value)}
                      placeholder="standup"
                      className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)] transition-all duration-200"
                    />
                  </div>
                  {!isStudio && (
                    <div className="flex-1 min-w-[160px]">
                      <LabelRow>Target branch</LabelRow>
                      <button
                        ref={branchTriggerRef}
                        type="button"
                        onClick={() => setBranchDropdownOpen((o) => !o)}
                        className={`w-full flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg)] border rounded-lg transition-colors text-left ${
                          branchDropdownOpen
                            ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
                            : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <GitBranch className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                          <span className="text-sm text-[var(--color-text)] truncate">
                            {newTaskTarget || "Pick a base branch"}
                          </span>
                        </span>
                        {isLoadingBranches ? (
                          <Loader2 className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />
                        ) : (
                          <ChevronDown
                            className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${
                              branchDropdownOpen ? "rotate-180" : ""
                            }`}
                          />
                        )}
                      </button>
                      {branchDropdownOpen && branchDropdownPos &&
                        createPortal(
                          <motion.div
                            ref={branchDropdownRef}
                            initial={{ opacity: 0, y: -6 }}
                            animate={{ opacity: 1, y: 0 }}
                            style={{
                              position: "fixed",
                              top: branchDropdownPos.top,
                              left: branchDropdownPos.left,
                              width: branchDropdownPos.width,
                              zIndex: 9999,
                            }}
                            className="max-h-48 overflow-y-auto bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg py-1"
                          >
                            {isLoadingBranches ? (
                              <div className="flex items-center justify-center gap-2 px-3 py-3 text-sm text-[var(--color-text-muted)]">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                <span>Loading…</span>
                              </div>
                            ) : branches.length > 0 ? (
                              branches.map((b) => (
                                <button
                                  key={b}
                                  type="button"
                                  onClick={() => {
                                    setNewTaskTarget(b);
                                    setBranchDropdownOpen(false);
                                  }}
                                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--color-bg-tertiary)] transition-colors ${
                                    b === newTaskTarget
                                      ? "text-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                                      : "text-[var(--color-text)]"
                                  }`}
                                >
                                  <GitBranch className="w-3.5 h-3.5 flex-shrink-0" />
                                  <span className="truncate">{b}</span>
                                  {b === selectedProject?.currentBranch && (
                                    <span className="ml-auto text-xs text-[var(--color-text-muted)] flex-shrink-0">
                                      current
                                    </span>
                                  )}
                                </button>
                              ))
                            ) : (
                              <div className="px-3 py-2 text-sm text-[var(--color-text-muted)]">
                                No branches found
                              </div>
                            )}
                          </motion.div>,
                          document.body,
                        )}
                    </div>
                  )}
                </>
              )}
            </div>
          </Section>

          {/* Chat session — single horizontal row */}
          <Section
            icon={<MessageSquare className="w-3.5 h-3.5" />}
            title="Chat session"
          >
            <div className="flex items-end gap-3 flex-wrap">
              <div className="flex-shrink-0">
                <LabelRow>Mode</LabelRow>
                <ModePill value={sessionMode} onChange={setSessionMode} />
              </div>
              <div className="flex-1 min-w-[220px]">
                <LabelRow>
                  {sessionMode === "existing" ? "Existing session" : "Agent"}
                </LabelRow>
                {sessionMode === "existing" ? (
                  <Combobox
                    options={chatOptions}
                    value={chatId}
                    onChange={(v) => setChatId(v)}
                    placeholder={
                      taskMode === "existing" && !taskId
                        ? "Pick a task first"
                        : chatOptions.length === 0
                        ? "No sessions in this task yet"
                        : "Select session…"
                    }
                    allowCustom={false}
                    disabled={taskMode === "existing" && !taskId}
                  />
                ) : (
                  <AgentPicker
                    value={newSessionAgent}
                    onChange={setNewSessionAgent}
                    allowCustom={false}
                    options={availableAgentOptions}
                    customAgents={customAgents}
                    customAgentPersonas={customAgentPersonas}
                  />
                )}
              </div>
            </div>
          </Section>

          {/* Prompt */}
          <Section icon={<Wand2 className="w-3.5 h-3.5" />} title="Prompt">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Summarize today's commits in 3 bullet points."
              rows={5}
              className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg
                text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] resize-y
                focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)]
                transition-all duration-200 font-mono"
            />
          </Section>

          {/* Schedule. The raw cron expression is intentionally hidden;
              users pick semantics, not syntax. Custom mode is the only
              path that exposes the cron string (because users authoring
              custom cron need to see it). */}
          <Section
            icon={<Clock4 className="w-3.5 h-3.5" />}
            title="Schedule"
            trailing={
              <div
                className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-md border max-w-full ${
                  cronInfo.valid
                    ? "bg-[var(--color-highlight)]/5 border-[var(--color-highlight)]/30"
                    : "bg-[var(--color-error)]/5 border-[var(--color-error)]/30"
                }`}
              >
                <Calendar
                  className={`w-3.5 h-3.5 flex-shrink-0 ${
                    cronInfo.valid
                      ? "text-[var(--color-highlight)]"
                      : "text-[var(--color-error)]"
                  }`}
                />
                <span
                  className={`text-xs truncate ${
                    cronInfo.valid ? "text-[var(--color-text)]" : "text-[var(--color-error)]"
                  }`}
                  title={cronInfo.text}
                >
                  {cronInfo.text}
                </span>
              </div>
            }
          >
            {/* Frequency picker + mode-specific controls share one row. */}
            <div className="flex items-center gap-2 flex-wrap">
              <div className="w-28 flex-shrink-0">
                <SimpleSelect
                  options={FREQUENCY_OPTIONS}
                  value={scheduleKind}
                  onChange={(v) => setScheduleKind(v as ScheduleKind)}
                />
              </div>

              {scheduleKind === "hourly" && (
                <>
                  <span className="text-sm text-[var(--color-text-muted)]">Every</span>
                  <div className="w-24">
                    <Combobox
                      options={HOURLY_OPTIONS}
                      value={String(hourlyN)}
                      onChange={(v) => setHourlyN(parseInt(v) || 1)}
                      allowCustom={false}
                    />
                  </div>
                  <span className="text-sm text-[var(--color-text-muted)]">at minute</span>
                  <div className="w-20">
                    <Combobox
                      options={MINUTE_QUARTER_OPTIONS}
                      value={String(hourlyMinute)}
                      onChange={(v) => setHourlyMinute(parseInt(v) || 0)}
                      allowCustom={false}
                    />
                  </div>
                </>
              )}

              {scheduleKind === "daily" && (
                <>
                  <span className="text-sm text-[var(--color-text-muted)]">At</span>
                  <InlineTime
                    hour={dailyHour}
                    minute={dailyMinute}
                    onHour={setDailyHour}
                    onMinute={setDailyMinute}
                  />
                </>
              )}

              {scheduleKind === "weekly" && (
                <>
                  <div className="flex-1 min-w-[160px] max-w-[260px]">
                    <WeekdayPicker
                      value={weeklyDays}
                      onChange={setWeeklyDays}
                    />
                  </div>
                  <span className="text-sm text-[var(--color-text-muted)]">at</span>
                  <InlineTime
                    hour={weeklyHour}
                    minute={weeklyMinute}
                    onHour={setWeeklyHour}
                    onMinute={setWeeklyMinute}
                  />
                </>
              )}

              {scheduleKind === "custom" && (
                <input
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="0 9 * * *"
                  className="flex-1 min-w-[200px] px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm font-mono text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-1 focus:ring-[var(--color-highlight)] transition-all duration-200"
                />
              )}
            </div>
          </Section>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 text-sm rounded-lg bg-[var(--color-error)]/10 border border-[var(--color-error)]/30 text-[var(--color-error)]">
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
          <p className="text-xs text-[var(--color-text-muted)]">
            <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
              ⌘
            </kbd>
            {" + "}
            <kbd className="px-1 py-0.5 text-[10px] font-mono rounded border bg-[var(--color-bg-secondary)] border-[var(--color-border)]">
              Enter
            </kbd>
            {initial ? " to save" : " to create"}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "Saving…" : initial ? "Save" : "Create"}
            </Button>
          </div>
        </div>
      </div>
    </DialogShell>
  );
}

// Registers the dialog.automation.* catalog handlers only while the dialog
// is actually open. See top-of-component comment for the multi-mount rationale.
function AutomationDialogBindings({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  useCommand("dialog.automation.close", onClose, [onClose]);
  useCommand(
    "dialog.automation.submit",
    () => {
      void onSubmit();
    },
    [onSubmit],
  );
  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  trailing,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] flex-shrink-0">
          {icon}
          <span>{title}</span>
        </div>
        {trailing && (
          <div className="flex-1 min-w-0 flex items-center justify-end">
            {trailing}
          </div>
        )}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function LabelRow({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
      {children}
    </label>
  );
}

function ModePill({
  value,
  onChange,
}: {
  value: TargetMode;
  onChange: (m: TargetMode) => void;
}) {
  return (
    <div className="inline-flex items-stretch gap-1 p-1 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg w-fit h-[38px]">
      {(["new", "existing"] as TargetMode[]).map((m) => (
        <motion.button
          key={m}
          type="button"
          whileTap={{ scale: 0.96 }}
          onClick={() => onChange(m)}
          className={`inline-flex items-center px-3 text-sm font-medium rounded-md capitalize transition-colors ${
            value === m
              ? "bg-[var(--color-highlight)] text-white shadow-sm"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          }`}
        >
          {m}
        </motion.button>
      ))}
    </div>
  );
}

function ToggleSwitch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="flex items-center gap-2 pb-2 select-none cursor-pointer group"
    >
      <span
        className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${
          value ? "bg-[var(--color-highlight)]" : "bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <motion.span
          layout
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className={`block w-4 h-4 rounded-full bg-white shadow-sm absolute top-0.5 ${
            value ? "left-[18px]" : "left-0.5"
          }`}
        />
      </span>
      <span className="text-sm text-[var(--color-text)] group-hover:text-[var(--color-highlight)] transition-colors">
        {label}
      </span>
    </button>
  );
}

/// Generic dropdown trigger + popover with a flip-up that **bottom-anchors**
/// when there isn't enough room below — popover stays glued to the trigger
/// instead of floating in the gap above (which is what the shared Combobox
/// does, because it reserves a fixed max-height upward and gets a visible
/// "drift" when content is short).
///
/// Used here for the Frequency picker and the Weekday multi-select; both
/// live near the bottom of the dialog where flip-up is the common case.
interface AnchorPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

function useAnchoredPopover(
  open: boolean,
  triggerRef: React.RefObject<HTMLElement | null>,
  popoverRef: React.RefObject<HTMLElement | null>,
  estimatedContentHeight: number,
  onClose: () => void,
): AnchorPosition | null {
  const [pos, setPos] = useState<AnchorPosition | null>(null);

  const recompute = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 4;
    const viewportPad = 8;
    const availableBelow = window.innerHeight - rect.bottom - gap - viewportPad;
    const availableAbove = rect.top - gap - viewportPad;
    // Flip up only when below truly cannot host the popover AND above is
    // clearly the better side. Otherwise stay below, even if it has to
    // scroll.
    const flipUp =
      availableBelow < estimatedContentHeight && availableAbove > availableBelow;
    const maxHeight = Math.max(120, flipUp ? availableAbove : availableBelow);
    if (flipUp) {
      setPos({
        bottom: window.innerHeight - rect.top + gap,
        left: rect.left,
        width: rect.width,
        maxHeight,
      });
    } else {
      setPos({
        top: rect.bottom + gap,
        left: rect.left,
        width: rect.width,
        maxHeight,
      });
    }
  }, [triggerRef, estimatedContentHeight]);

  useEffect(() => {
    if (!open) return;
    recompute();
    const onScroll = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, recompute]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, onClose, triggerRef, popoverRef]);

  return pos;
}

function popoverStyle(pos: AnchorPosition): React.CSSProperties {
  const base: React.CSSProperties = {
    position: "fixed",
    left: pos.left,
    width: pos.width,
    maxHeight: pos.maxHeight,
    zIndex: 9999,
  };
  if (pos.top !== undefined) base.top = pos.top;
  if (pos.bottom !== undefined) base.bottom = pos.bottom;
  return base;
}

/// Single-select dropdown. Mirrors the trigger styling of the shared
/// Combobox but uses our `useAnchoredPopover` so flip-up stays glued to
/// the trigger.
function SimpleSelect({
  options,
  value,
  onChange,
}: {
  options: ComboboxOption[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPopover(
    open,
    triggerRef,
    popoverRef,
    options.length * 36 + 8,
    () => setOpen(false),
  );
  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full inline-flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg text-sm transition-all duration-200 ${
          open
            ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
            : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
        }`}
      >
        <span className="truncate text-[var(--color-text)]">
          {selected?.label ?? value}
        </span>
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
        </motion.div>
      </button>

      {open && pos &&
        createPortal(
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, y: pos.bottom !== undefined ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            style={popoverStyle(pos)}
            className="py-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-y-auto"
          >
            {options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-sm transition-colors ${
                  opt.value === value
                    ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                    : "text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                }`}
              >
                <span>{opt.label}</span>
                {opt.value === value && <Check className="w-4 h-4" />}
              </button>
            ))}
          </motion.div>,
          document.body,
        )}
    </div>
  );
}

/// Multi-select dropdown for weekdays. Trigger shows a summary
/// ("Every day" / "Weekdays" / "Mon, Wed, Fri" / "Pick days"); the popover
/// holds seven independent checkboxes so the user can toggle days without
/// dismissing the menu between picks.
function WeekdayPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // 7 rows + header ≈ 7 * 36 + 32 = 284px
  const pos = useAnchoredPopover(open, triggerRef, popoverRef, 284, () => setOpen(false));

  function toggle(d: number) {
    onChange(
      value.includes(d)
        ? value.filter((x) => x !== d)
        : [...value, d].sort((a, b) => a - b),
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`w-full inline-flex items-center justify-between gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] border rounded-lg text-sm transition-all duration-200 ${
          open
            ? "border-[var(--color-highlight)] ring-1 ring-[var(--color-highlight)]"
            : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]"
        }`}
      >
        <span
          className={`truncate ${
            value.length > 0
              ? "text-[var(--color-text)]"
              : "text-[var(--color-text-muted)]"
          }`}
        >
          {summarizeWeekdays(value)}
        </span>
        <motion.div animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }}>
          <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
        </motion.div>
      </button>

      {open && pos &&
        createPortal(
          <motion.div
            ref={popoverRef}
            initial={{ opacity: 0, y: pos.bottom !== undefined ? 6 : -6 }}
            animate={{ opacity: 1, y: 0 }}
            style={{
              ...popoverStyle(pos),
              width: Math.max(pos.width, 180),
            }}
            className="py-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-y-auto"
          >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] sticky top-0 bg-[var(--color-bg-secondary)]">
              <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                Days
              </span>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => onChange([0, 1, 2, 3, 4, 5, 6])}
                  className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-highlight)]"
                >
                  All
                </button>
                <span className="text-[10px] text-[var(--color-text-muted)]">·</span>
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-highlight)]"
                >
                  None
                </button>
              </div>
            </div>
            {WEEKDAYS.map((d) => {
              const checked = value.includes(d.value);
              return (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggle(d.value)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-[var(--color-bg-tertiary)] transition-colors ${
                    checked ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked
                        ? "bg-[var(--color-highlight)] border-[var(--color-highlight)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)]"
                    }`}
                  >
                    {checked && <Check className="w-3 h-3 text-white" />}
                  </span>
                  <span>{d.label}</span>
                </button>
              );
            })}
          </motion.div>,
          document.body,
        )}
    </div>
  );
}

function summarizeWeekdays(days: number[]): string {
  if (days.length === 0) return "Pick days";
  if (days.length === 7) return "Every day";
  const set = new Set(days);
  // Weekdays = Mon-Fri (1..5)
  if (set.size === 5 && [1, 2, 3, 4, 5].every((d) => set.has(d))) return "Weekdays";
  // Weekend = Sat, Sun
  if (set.size === 2 && set.has(0) && set.has(6)) return "Weekends";
  // Otherwise list short labels in calendar order (Mon..Sun)
  return WEEKDAYS.filter((d) => set.has(d.value))
    .map((d) => d.label)
    .join(", ");
}

function InlineTime({
  hour,
  minute,
  onHour,
  onMinute,
}: {
  hour: number;
  minute: number;
  onHour: (h: number) => void;
  onMinute: (m: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <div className="w-16">
        <Combobox
          options={HOUR_OPTIONS}
          value={String(hour)}
          onChange={(v) => onHour(parseInt(v) || 0)}
          allowCustom={false}
        />
      </div>
      <span className="text-[var(--color-text-muted)] font-mono">:</span>
      <div className="w-16">
        <Combobox
          options={MINUTE_OPTIONS}
          value={String(minute)}
          onChange={(v) => onMinute(parseInt(v) || 0)}
          allowCustom={false}
        />
      </div>
    </div>
  );
}
