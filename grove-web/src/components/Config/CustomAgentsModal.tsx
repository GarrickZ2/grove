import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Pencil, Trash2, UserCog, Bot, Globe, Terminal, Check, Loader2 } from "lucide-react";
import { Button, AgentPicker } from "../ui";
import {
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
  listCustomAgents,
  type CustomAgentPersona,
  type CustomAgentInput,
  type CustomAgentPatch,
  type CustomAgentServer,
} from "../../api";
import { loadCustomAgentPersonas as loadCustomAgentPersonasIcon } from "../../utils/agentIcon";
import { useIsMobile } from "../../hooks";

interface AgentOption {
  id: string;
  label: string;
  value: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
  disabledReason?: string;
}

interface CustomAgentsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Initial list (already loaded by SettingsPage). Modal reflects mutations back via onChanged. */
  agents: CustomAgentPersona[];
  baseAgentOptions: AgentOption[];
  customServers: CustomAgentServer[];
  /** Called whenever the list mutates (create/update/delete). */
  onChanged: (next: CustomAgentPersona[]) => void;
  /** True while parent's initial `listCustomAgents()` is still in flight.
   *  Modal shows a spinner instead of the empty-state CTA so users don't
   *  start creating drafts before the list arrives. */
  loading?: boolean;
}

interface DraftAgent {
  id: string;
  name: string;
  base_agent: string;
  model?: string;
  mode?: string;
  effort?: string;
  duty?: string;
  system_prompt: string;
}

type FormState = {
  name: string;
  base_agent: string;
  model: string;
  mode: string;
  effort: string;
  duty: string;
  system_prompt: string;
};

const DRAFT_PREFIX = "draft-";

function isDraft(id: string): boolean {
  return id.startsWith(DRAFT_PREFIX);
}

function makeDraftId(): string {
  return `${DRAFT_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultBase(options: AgentOption[]): string {
  return options.find((o) => !o.disabled)?.id ?? options[0]?.id ?? "claude";
}

function makeDraft(options: AgentOption[]): DraftAgent {
  return {
    id: makeDraftId(),
    name: "New Agent",
    base_agent: defaultBase(options),
    system_prompt: "",
  };
}

function toFormState(p: CustomAgentPersona | DraftAgent): FormState {
  return {
    name: p.name,
    base_agent: p.base_agent,
    model: p.model ?? "",
    mode: p.mode ?? "",
    effort: p.effort ?? "",
    duty: p.duty ?? "",
    system_prompt: p.system_prompt ?? "",
  };
}

export function CustomAgentsModal({
  isOpen,
  onClose,
  agents,
  baseAgentOptions,
  customServers,
  onChanged,
  loading = false,
}: CustomAgentsModalProps) {
  // local list mirrors props but adds drafts (not yet persisted)
  const [list, setList] = useState<(CustomAgentPersona | DraftAgent)[]>(agents);
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.id ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { isMobile } = useIsMobile();

  // Refs for keyboard handler so it always calls the latest closures without
  // re-adding the document listener on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const cancelEditRef = useRef<() => void>(() => {});
  const saveEditRef = useRef<() => Promise<void>>(async () => {});

  // Keyboard a11y — Esc unwinds inner state in layers (delete confirm →
  // editing form → modal close), so users don't lose unsaved work to a
  // single keystroke. Cmd/Ctrl+Enter saves the form when in editing mode.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDeleteId) {
          e.preventDefault();
          setConfirmDeleteId(null);
          return;
        }
        if (editingId) {
          e.preventDefault();
          cancelEditRef.current();
          return;
        }
        e.preventDefault();
        onCloseRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && editingId && form) {
        e.preventDefault();
        void saveEditRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, editingId, form, confirmDeleteId]);

  // Sync from props on open. Drafts are dropped on close.
  // Uses the documented "Adjusting state on prop change" pattern with a stored
  // marker so the reset doesn't run inside an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [openedFor, setOpenedFor] = useState<{ isOpen: boolean; agents: typeof agents } | null>(null);
  if (isOpen && (openedFor?.isOpen !== isOpen || openedFor?.agents !== agents)) {
    setOpenedFor({ isOpen, agents });
    setList(agents);
    setSelectedId(agents[0]?.id ?? null);
    setEditingId(null);
    setForm(null);
    setConfirmDeleteId(null);
    setError(null);
  } else if (!isOpen && openedFor?.isOpen) {
    setOpenedFor({ isOpen, agents });
  }

  // When external agents change (e.g. after a successful create), keep list in sync but preserve drafts.
  const agentsRef = useRef(agents);
  useEffect(() => {
    agentsRef.current = agents;
  }, [agents]);

  const current = list.find((p) => p.id === selectedId) ?? list[0] ?? null;
  const isEditingCurrent = current ? editingId === current.id : false;

  const baseLookup = useMemo(() => {
    const m = new Map<string, { label: string; icon?: AgentOption["icon"]; kind: "builtin" | "server" }>();
    for (const o of baseAgentOptions) m.set(o.id, { label: o.label, icon: o.icon, kind: "builtin" });
    for (const s of customServers) m.set(s.id, { label: s.name, icon: undefined, kind: "server" });
    return m;
  }, [baseAgentOptions, customServers]);

  const renderBaseIcon = (baseId: string) => {
    const entry = baseLookup.get(baseId);
    if (entry?.icon) {
      const Icon = entry.icon;
      return <Icon size={16} className="text-[var(--color-text)]" />;
    }
    if (entry?.kind === "server") {
      const isRemote = customServers.find((s) => s.id === baseId)?.type === "remote";
      return isRemote ? (
        <Globe className="w-4 h-4 text-[var(--color-info)]" />
      ) : (
        <Terminal className="w-4 h-4 text-[var(--color-text-muted)]" />
      );
    }
    return <Bot className="w-4 h-4 text-[var(--color-text-muted)]" />;
  };

  const baseLabel = (baseId: string) => baseLookup.get(baseId)?.label ?? baseId;

  // Helpers --------------------------------------------------------------

  /** Update local list. `skipOnChanged: true` is used by mutation flows
   *  that immediately follow up with `reconcileFromServer` — that path
   *  fires `onChanged` with the server's authoritative state, so the
   *  optimistic emit here would be a wasted re-render of every consumer. */
  const replaceList = (
    next: (CustomAgentPersona | DraftAgent)[],
    opts?: { skipOnChanged?: boolean },
  ) => {
    setList(next);
    if (!opts?.skipOnChanged) {
      onChanged(next.filter((p): p is CustomAgentPersona => !isDraft(p.id)));
    }
  };

  /** After any successful mutation, fetch the truth from the server so
   *  concurrent edits (two tabs, etc.) reconcile to a single source. Local
   *  drafts are preserved in their current slot — only persisted rows get
   *  replaced. On fetch failure we surface a quiet inline warning rather
   *  than silently letting stale local state diverge from the server. */
  const reconcileFromServer = async (selectAfter?: string | null) => {
    let fresh: CustomAgentPersona[] | null = null;
    try {
      fresh = await loadCustomAgentPersonasIcon(() => listCustomAgents());
    } catch {
      fresh = null;
    }
    if (!fresh) {
      setError(
        "Couldn't refresh from server — your view may be out of date until you reopen this dialog.",
      );
      return;
    }
    const drafts = list.filter((p) => isDraft(p.id));
    const next: (CustomAgentPersona | DraftAgent)[] = [...fresh, ...drafts];
    setList(next);
    onChanged(fresh);
    if (selectAfter !== undefined) {
      setSelectedId(selectAfter);
    } else if (selectedId && !next.some((p) => p.id === selectedId)) {
      const firstId = next[0]?.id ?? null;
      setSelectedId(firstId);
    }
  };

  // Add ------------------------------------------------------------------

  const addDraft = () => {
    if (busy) return;
    // Refuse to spawn a second draft while another draft is still being
    // edited — clicking + twice in quick succession used to silently drop
    // the first draft's work-in-progress slot. The user must Save or
    // Cancel the current draft before creating another.
    if (editingId && isDraft(editingId)) return;
    const draft = makeDraft(baseAgentOptions);
    const next = [...list, draft];
    setList(next);
    setSelectedId(draft.id);
    setEditingId(draft.id);
    setForm(toFormState(draft));
    setError(null);
  };

  // Edit / Cancel / Save -------------------------------------------------

  const startEdit = () => {
    if (!current) return;
    setEditingId(current.id);
    setForm(toFormState(current));
    setError(null);
  };

  const cancelEdit = () => {
    if (!current || !editingId) return;
    if (isDraft(editingId)) {
      // remove draft entirely
      const next = list.filter((p) => p.id !== editingId);
      setList(next);
      setSelectedId(next[0]?.id ?? null);
    }
    setEditingId(null);
    setForm(null);
    setError(null);
  };

  const saveEdit = async () => {
    if (!current || !editingId || !form) return;
    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }
    if (!form.base_agent.trim()) {
      setError("Base Agent is required");
      return;
    }
    setBusy(true);
    setError(null);
    const trimmedName = form.name.trim();
    const trimmedModel = form.model.trim();
    const trimmedMode = form.mode.trim();
    const trimmedEffort = form.effort.trim();
    const trimmedDuty = form.duty.trim();
    const modelVal = trimmedModel ? trimmedModel : null;
    const modeVal = trimmedMode ? trimmedMode : null;
    const effortVal = trimmedEffort ? trimmedEffort : null;
    const dutyVal = trimmedDuty ? trimmedDuty : null;
    const draftFlag = isDraft(editingId);
    let created: CustomAgentPersona | null = null;
    let updated: CustomAgentPersona | null = null;
    let saveErr: unknown = null;
    try {
      if (draftFlag) {
        const input: CustomAgentInput = {
          name: trimmedName,
          base_agent: form.base_agent,
          model: modelVal,
          mode: modeVal,
          effort: effortVal,
          duty: dutyVal,
          system_prompt: form.system_prompt,
        };
        created = await createCustomAgent(input);
      } else {
        const patch: CustomAgentPatch = {
          name: trimmedName,
          base_agent: form.base_agent,
          model: modelVal,
          mode: modeVal,
          effort: effortVal,
          duty: dutyVal,
          system_prompt: form.system_prompt,
        };
        updated = await updateCustomAgent(editingId, patch);
      }
    } catch (e) {
      saveErr = e;
    }
    if (saveErr !== null) {
      setError(saveErr instanceof Error ? saveErr.message : "Save failed");
      setBusy(false);
      return;
    }
    if (draftFlag && created) {
      const next = list.map((p) => (p.id === editingId ? created! : p));
      replaceList(next, { skipOnChanged: true });
      setSelectedId(created.id);
      await reconcileFromServer(created.id);
    } else if (!draftFlag && updated) {
      const next = list.map((p) => (p.id === editingId ? updated! : p));
      replaceList(next, { skipOnChanged: true });
      await reconcileFromServer(updated.id);
    }
    setEditingId(null);
    setForm(null);
    setBusy(false);
  };
  useEffect(() => {
    cancelEditRef.current = cancelEdit;
    saveEditRef.current = saveEdit;
  });

  // Inline delete --------------------------------------------------------

  const requestDelete = (id: string) => setConfirmDeleteId(id);

  const cancelDelete = () => setConfirmDeleteId(null);

  const confirmDelete = async (id: string) => {
    if (isDraft(id)) {
      const next = list.filter((p) => p.id !== id);
      setList(next);
      if (selectedId === id) setSelectedId(next[0]?.id ?? null);
      if (editingId === id) {
        setEditingId(null);
        setForm(null);
      }
      setConfirmDeleteId(null);
      return;
    }
    let delErr: unknown = null;
    try {
      await deleteCustomAgent(id);
    } catch (e) {
      delErr = e;
    }
    if (delErr !== null) {
      setError(delErr instanceof Error ? delErr.message : "Delete failed");
      setConfirmDeleteId(null);
      return;
    }
    const next = list.filter((p) => p.id !== id);
    replaceList(next, { skipOnChanged: true });
    const firstNext = next[0];
    const fallbackId = firstNext ? firstNext.id : null;
    if (selectedId === id) setSelectedId(fallbackId);
    if (editingId === id) {
      setEditingId(null);
      setForm(null);
    }
    const targetSelect = selectedId === id ? fallbackId : selectedId;
    await reconcileFromServer(targetSelect);
    setConfirmDeleteId(null);
  };

  // Row click ------------------------------------------------------------

  const onSelectRow = (id: string) => {
    if (confirmDeleteId === id) return;
    if (id === selectedId) return;
    // While a save is in flight, lock the row so an in-flight error
    // doesn't get attributed to a different (just-clicked) row's context.
    if (busy) return;
    // If currently editing some other row, drop its unsaved form silently
    if (editingId) {
      if (isDraft(editingId)) {
        // drop the draft from list
        setList((prev) => prev.filter((p) => p.id !== editingId));
      }
      setEditingId(null);
      setForm(null);
    }
    setSelectedId(id);
  };

  // Render ---------------------------------------------------------------

  if (!isOpen) return null;

  const updateForm = (patch: Partial<FormState>) => {
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-end sm:items-center justify-center sm:p-4"
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        <motion.div
          initial={isMobile ? { y: "100%" } : { scale: 0.95, opacity: 0 }}
          animate={isMobile ? { y: 0 } : { scale: 1, opacity: 1 }}
          exit={isMobile ? { y: "100%" } : { scale: 0.95, opacity: 0 }}
          transition={isMobile ? { type: "spring", damping: 30, stiffness: 300 } : undefined}
          className={`relative w-full bg-[var(--color-bg)] border border-[var(--color-border)] shadow-2xl overflow-hidden ${
            isMobile ? "max-h-[92vh] rounded-t-2xl" : "max-w-4xl rounded-xl"
          }`}
        >
          {/* Header */}
          <div className={`flex items-center justify-between ${isMobile ? "px-4 py-3" : "px-6 py-4"} border-b border-[var(--color-border)]`}>
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/10">
                <UserCog className="w-4 h-4 text-[var(--color-highlight)]" />
              </div>
              <div className="min-w-0">
                <h2 className={`${isMobile ? "text-base" : "text-lg"} font-semibold text-[var(--color-text)]`}>
                  Custom Agents
                </h2>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Personas built on top of a base agent with a preset model & system prompt
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors shrink-0"
            >
              <X className="w-5 h-5 text-[var(--color-text-muted)]" />
            </button>
          </div>

          {/* Content */}
          <div
            className={`flex ${isMobile ? "flex-col" : ""}`}
            style={{
              height: isMobile ? "calc(92vh - 130px)" : "min(620px, calc(90vh - 140px))",
            }}
          >
            {/* Left list */}
            <div
              className={`${
                isMobile
                  ? "border-b border-[var(--color-border)] max-h-40 overflow-x-auto flex gap-2 p-3"
                  : "w-64 border-r border-[var(--color-border)] p-4 flex flex-col"
              }`}
            >
              {!isMobile && (
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-[var(--color-text-muted)]">Agents</span>
                  <Button variant="ghost" size="sm" onClick={addDraft} disabled={busy}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className={`${isMobile ? "flex gap-2" : "flex-1 space-y-2 overflow-y-auto"}`}>
                {list.map((p) => {
                  const isSelected = p.id === current?.id;
                  const isConfirmingDelete = confirmDeleteId === p.id;
                  const isDraftItem = isDraft(p.id);

                  return (
                    <div
                      key={p.id}
                      onClick={() => onSelectRow(p.id)}
                      className={`p-3 rounded-lg cursor-pointer transition-all ${
                        isMobile ? "flex-shrink-0 min-w-[160px]" : ""
                      } ${
                        isSelected
                          ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]"
                          : "bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                          {renderBaseIcon(p.base_agent)}
                        </div>
                        {isConfirmingDelete ? (
                          <div className="flex-1 flex items-center gap-1.5 text-xs">
                            <span className="text-[var(--color-error)] font-medium">Delete?</span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                confirmDelete(p.id);
                              }}
                              className="px-2 py-0.5 rounded bg-[var(--color-error)] text-white hover:opacity-90"
                            >
                              Yes
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                cancelDelete();
                              }}
                              className="px-2 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <>
                            <span
                              className={`flex-1 text-sm font-medium truncate ${
                                isSelected ? "text-[var(--color-highlight)]" : "text-[var(--color-text)]"
                              }`}
                            >
                              {p.name}
                            </span>
                            {isDraftItem && (
                              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-warning)]/15 text-[var(--color-warning)] font-medium shrink-0">
                                Unsaved
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                requestDelete(p.id);
                              }}
                              className="p-1 rounded hover:bg-[var(--color-error)]/10 transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3 h-3 text-[var(--color-error)]" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate pl-7">
                        Based on {baseLabel(p.base_agent)}
                        {p.model ? ` · ${p.model}` : ""}
                      </div>
                    </div>
                  );
                })}

                {isMobile && (
                  <button
                    onClick={addDraft}
                    disabled={busy}
                    className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
                  >
                    <Plus className="w-4 h-4 text-[var(--color-text-muted)]" />
                  </button>
                )}
              </div>
            </div>

            {/* Right pane */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className={`flex-1 ${isMobile ? "p-4" : "p-6"} overflow-y-auto`}>
                {!current ? (
                  loading ? (
                    <div className="h-full flex flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]">
                      <Loader2 className="w-6 h-6 animate-spin" />
                      <div className="text-xs">Loading custom agents…</div>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-[var(--color-text-muted)]">
                      <UserCog className="w-10 h-10 opacity-40" />
                      <div className="text-sm">No custom agents yet</div>
                      <Button variant="primary" size="sm" onClick={addDraft}>
                        <Plus className="w-4 h-4 mr-1" /> Create your first
                      </Button>
                    </div>
                  )
                ) : isEditingCurrent && form ? (
                  <EditView
                    form={form}
                    onUpdate={updateForm}
                    baseAgentOptions={baseAgentOptions}
                    customServers={customServers}
                  />
                ) : !isDraft(current.id) ? (
                  <ViewView
                    agent={current as CustomAgentPersona}
                    baseLabel={baseLabel(current.base_agent)}
                    baseIcon={renderBaseIcon(current.base_agent)}
                  />
                ) : null}
              </div>

              {current && (
                <div className={`flex items-center justify-between gap-3 ${isMobile ? "px-4 py-3" : "px-6 py-3"} border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]`}>
                  <div className="text-xs text-[var(--color-error)] truncate flex-1">{error ?? ""}</div>
                  {isEditingCurrent ? (
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="secondary" size="sm" onClick={cancelEdit} disabled={busy}>
                        Cancel
                      </Button>
                      <Button variant="primary" size="sm" onClick={saveEdit} disabled={busy}>
                        {busy ? "Saving…" : (
                          <>
                            <Check className="w-4 h-4 mr-1" /> Save
                          </>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <Button variant="primary" size="sm" onClick={startEdit}>
                      <Pencil className="w-4 h-4 mr-1" /> Edit
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}

// ---------------- inner sub-views ----------------

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
      {children}
    </label>
  );
}

function ReadOnlyValue({ value, mono = false, multiline = false }: { value?: string | null; mono?: boolean; multiline?: boolean }) {
  const isEmpty = !value || !value.trim();
  return (
    <div
      className={`w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 ${multiline ? "py-2 min-h-[3.5rem] whitespace-pre-wrap" : "h-9 flex items-center"} text-sm ${
        isEmpty ? "text-[var(--color-text-muted)] italic" : "text-[var(--color-text)]"
      } ${mono ? "font-mono" : ""}`}
    >
      {isEmpty ? "—" : value}
    </div>
  );
}

function ViewView({
  agent,
  baseLabel,
  baseIcon,
}: {
  agent: CustomAgentPersona;
  baseLabel: string;
  baseIcon: React.ReactNode;
}) {
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Name</FieldLabel>
        <ReadOnlyValue value={agent.name} />
      </div>

      <div className="border-t border-[var(--color-border)]" />

      <div>
        <FieldLabel>Base Agent</FieldLabel>
        <div className="w-full h-9 flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 px-3 text-sm text-[var(--color-text)]">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">{baseIcon}</span>
          <span className="truncate">{baseLabel}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <FieldLabel>Model</FieldLabel>
          <ReadOnlyValue value={agent.model} mono />
        </div>
        <div>
          <FieldLabel>Mode</FieldLabel>
          <ReadOnlyValue value={agent.mode} mono />
        </div>
        <div>
          <FieldLabel>Effort</FieldLabel>
          <ReadOnlyValue value={agent.effort} mono />
        </div>
      </div>

      <div className="border-t border-[var(--color-border)]" />

      <div>
        <FieldLabel>Duty</FieldLabel>
        <ReadOnlyValue value={agent.duty} />
      </div>

      <div>
        <FieldLabel>System Prompt</FieldLabel>
        <ReadOnlyValue value={agent.system_prompt} mono multiline />
      </div>
    </div>
  );
}

function EditView({
  form,
  onUpdate,
  baseAgentOptions,
  customServers,
}: {
  form: FormState;
  onUpdate: (patch: Partial<FormState>) => void;
  baseAgentOptions: AgentOption[];
  customServers: CustomAgentServer[];
}) {
  const inputCls =
    "w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]";
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Name</FieldLabel>
        <input
          type="text"
          value={form.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          placeholder="e.g. Senior Engineer"
          className={inputCls}
        />
      </div>

      <div className="border-t border-[var(--color-border)]" />

      <div>
        <FieldLabel>Base Agent</FieldLabel>
        <AgentPicker
          value={form.base_agent}
          onChange={(v) => onUpdate({ base_agent: v })}
          options={baseAgentOptions}
          allowCustom={false}
          placeholder="Select base agent..."
          customAgents={customServers}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <FieldLabel>Model</FieldLabel>
          <input
            type="text"
            value={form.model}
            onChange={(e) => onUpdate({ model: e.target.value })}
            placeholder="e.g. sonnet"
            className={inputCls}
          />
        </div>
        <div>
          <FieldLabel>Mode</FieldLabel>
          <input
            type="text"
            value={form.mode}
            onChange={(e) => onUpdate({ mode: e.target.value })}
            placeholder="e.g. default"
            className={inputCls}
          />
        </div>
        <div>
          <FieldLabel>Effort</FieldLabel>
          <input
            type="text"
            value={form.effort}
            onChange={(e) => onUpdate({ effort: e.target.value })}
            placeholder="e.g. high"
            className={inputCls}
          />
        </div>
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] -mt-2">
        Free-text. Matched by name on the chosen base agent, falling back to its default if not available.
      </p>

      <div className="border-t border-[var(--color-border)]" />

      <div>
        <FieldLabel>Duty</FieldLabel>
        <input
          type="text"
          value={form.duty}
          onChange={(e) => onUpdate({ duty: e.target.value })}
          placeholder="One-line description, e.g. Plans and ships features end-to-end."
          className={inputCls}
        />
      </div>

      <div>
        <FieldLabel>System Prompt</FieldLabel>
        <textarea
          value={form.system_prompt}
          onChange={(e) => onUpdate({ system_prompt: e.target.value })}
          placeholder="You are a senior engineer..."
          rows={2}
          className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] font-mono leading-relaxed resize-y"
        />
        <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">
          Injected into the agent on session start.
        </p>
      </div>
    </div>
  );
}
