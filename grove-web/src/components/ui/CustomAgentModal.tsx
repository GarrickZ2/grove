import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Pencil, Trash2, Globe, Terminal, Server } from "lucide-react";
import type { CustomAgentServer } from "../../api/config";
import { Button } from "./Button";
import { useIsMobile } from "../../hooks";

interface CustomAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: CustomAgentServer[];
  onSave: (agents: CustomAgentServer[]) => void;
}

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function makeUniqueId(base: string, taken: Set<string>): string {
  const id = base || `agent-${Date.now().toString(36)}`;
  if (!taken.has(id)) return id;
  let i = 2;
  while (taken.has(`${id}-${i}`)) i++;
  return `${id}-${i}`;
}

function createDefaultAgent(taken: Set<string>): CustomAgentServer {
  return {
    id: makeUniqueId("new-agent", taken),
    name: "New Server",
    type: "local",
    command: "",
  };
}

export function CustomAgentModal({
  isOpen,
  onClose,
  agents,
  onSave,
}: CustomAgentModalProps) {
  const [local, setLocal] = useState<CustomAgentServer[]>(agents);
  const [selectedId, setSelectedId] = useState<string | null>(agents[0]?.id ?? null);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [argsDraft, setArgsDraft] = useState<string>("");
  /** ID input draft — accepts any keystroke, validated visually below.
   *  We commit to the canonical `local[i].id` only when the draft is unique;
   *  this lets the user type freely without the input "freezing" on the
   *  duplicate-collision keystroke. */
  const [idDraft, setIdDraft] = useState<string>("");
  const { isMobile } = useIsMobile();

  // Reset local state when the modal opens (or `agents` prop changes while open).
  // Uses the documented "Adjusting state on prop change" pattern to avoid
  // setState inside an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [openedFor, setOpenedFor] = useState<{ isOpen: boolean; agents: typeof agents } | null>(null);
  if (isOpen && (openedFor === null || openedFor.isOpen !== isOpen || openedFor.agents !== agents)) {
    setOpenedFor({ isOpen, agents });
    setLocal(agents);
    setSelectedId(agents[0]?.id ?? null);
  } else if (!isOpen && openedFor !== null && openedFor.isOpen) {
    setOpenedFor({ isOpen, agents });
  }

  const current = local.find((a) => a.id === selectedId) ?? local[0] ?? null;

  // Sync args + id drafts when the selected agent (or its committed
  // id/args) changes. Uses the same prop-change-style pattern keyed on the
  // observed agent id + args reference so it doesn't run inside an effect.
  const [syncedAgent, setSyncedAgent] = useState<{ id: string | undefined; args: string[] | undefined } | null>(null);
  const currentId = current ? current.id : undefined;
  const currentArgs = current ? current.args : undefined;
  if (
    syncedAgent === null ||
    syncedAgent.id !== currentId ||
    syncedAgent.args !== currentArgs
  ) {
    setSyncedAgent({ id: currentId, args: currentArgs });
    setArgsDraft(currentArgs ? currentArgs.join(" ") : "");
    setIdDraft(currentId ?? "");
  }

  /** Is `idDraft` a duplicate against another agent? Drives the inline error. */
  const idDraftCollides =
    !!current && idDraft.length > 0 && idDraft !== current.id &&
    local.some((a) => a.id !== current.id && a.id === idDraft);

  const addAgent = () => {
    const taken = new Set(local.map((a) => a.id));
    const a = createDefaultAgent(taken);
    setLocal([...local, a]);
    setSelectedId(a.id);
  };

  const deleteAgent = (id: string) => {
    const next = local.filter((a) => a.id !== id);
    setLocal(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  };

  const updateAgent = (id: string, patch: Partial<CustomAgentServer>) => {
    setLocal(local.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const startEditName = (a: CustomAgentServer) => {
    setEditingNameId(a.id);
    setEditingName(a.name);
  };

  const finishEditName = () => {
    if (editingNameId && editingName.trim()) {
      const target = local.find((a) => a.id === editingNameId);
      const newName = editingName.trim();
      if (target) {
        const taken = new Set(local.filter((a) => a.id !== target.id).map((a) => a.id));
        const desiredId = generateId(newName) || target.id;
        const sameAsCurrent = desiredId === target.id;
        const newId = sameAsCurrent ? target.id : makeUniqueId(desiredId, taken);
        updateAgent(target.id, { name: newName, id: newId });
        if (!sameAsCurrent && selectedId === target.id) setSelectedId(newId);
      }
    }
    setEditingNameId(null);
  };

  const handleSave = () => {
    // Block save if the visible id draft is still in collision — the user
    // sees the inline error and the operation is no-op.
    if (idDraftCollides) return;
    // Commit any pending (non-collision) id draft into `local` first so a
    // Cmd+Enter without prior blur doesn't drop the rename.
    if (current) {
      const trimmed = idDraft.trim();
      if (trimmed && trimmed !== current.id) {
        const next = local.map((a) =>
          a.id === current.id ? { ...a, id: trimmed } : a,
        );
        onSave(next);
        onClose();
        return;
      }
    }
    onSave(local);
    onClose();
  };

  // Keyboard a11y — Esc unwinds in layers (inline rename → close).
  // Cmd/Ctrl+Enter triggers Save (blocked when ID draft is in collision).
  // We bind once on open and read the latest handlers via refs to avoid
  // re-binding on every keystroke (and to keep the React Compiler happy
  // about the deps array).
  const handleSaveRef = useRef(handleSave);
  const onCloseRef = useRef(onClose);
  const editingNameIdRef = useRef(editingNameId);
  useEffect(() => {
    handleSaveRef.current = handleSave;
    onCloseRef.current = onClose;
    editingNameIdRef.current = editingNameId;
  });
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (editingNameIdRef.current) {
          e.preventDefault();
          setEditingNameId(null);
          return;
        }
        e.preventDefault();
        onCloseRef.current();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSaveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  if (!isOpen) return null;

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
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-info)]/10">
                <Server className="w-4 h-4 text-[var(--color-info)]" />
              </div>
              <div className="min-w-0">
                <h2 className={`${isMobile ? "text-base" : "text-lg"} font-semibold text-[var(--color-text)]`}>
                  Custom Agent Servers
                </h2>
                <p className="text-xs text-[var(--color-text-muted)]">
                  Local commands or remote ACP endpoints for private and self-hosted agents
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
              height: isMobile ? "calc(92vh - 130px)" : "min(420px, calc(90vh - 140px))",
            }}
          >
            {/* Left: server list */}
            <div
              className={`${
                isMobile
                  ? "border-b border-[var(--color-border)] max-h-40 overflow-x-auto flex gap-2 p-3"
                  : "w-64 border-r border-[var(--color-border)] p-4 flex flex-col"
              }`}
            >
              {!isMobile && (
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-medium text-[var(--color-text-muted)]">Servers</span>
                  <Button variant="ghost" size="sm" onClick={addAgent}>
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              )}

              <div className={`${isMobile ? "flex gap-2" : "flex-1 space-y-2 overflow-y-auto"}`}>
                {local.map((a) => {
                  const isSelected = a.id === current?.id;
                  const isEditing = editingNameId === a.id;
                  const isRemote = a.type === "remote";
                  return (
                    <div
                      key={a.id}
                      onClick={() => !isEditing && setSelectedId(a.id)}
                      className={`p-3 rounded-lg cursor-pointer transition-all ${
                        isMobile ? "flex-shrink-0 min-w-[180px]" : ""
                      } ${
                        isSelected
                          ? "bg-[var(--color-info)]/10 border border-[var(--color-info)]"
                          : "bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                          {isRemote ? (
                            <Globe className="w-4 h-4 text-[var(--color-info)]" />
                          ) : (
                            <Terminal className="w-4 h-4 text-[var(--color-text-muted)]" />
                          )}
                        </div>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={finishEditName}
                            onKeyDown={(e) => e.key === "Enter" && finishEditName()}
                            autoFocus
                            className="flex-1 px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-info)] rounded text-[var(--color-text)] focus:outline-none"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <span
                              className={`flex-1 text-sm font-medium truncate ${
                                isSelected ? "text-[var(--color-info)]" : "text-[var(--color-text)]"
                              }`}
                            >
                              {a.name}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditName(a);
                              }}
                              className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors"
                            >
                              <Pencil className="w-3 h-3 text-[var(--color-text-muted)]" />
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                deleteAgent(a.id);
                              }}
                              className="p-1 rounded hover:bg-[var(--color-error)]/10 transition-colors"
                            >
                              <Trash2 className="w-3 h-3 text-[var(--color-error)]" />
                            </button>
                          </>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-1 truncate pl-7 font-mono">
                        {isRemote ? a.url || "—" : a.command || "—"}
                      </div>
                    </div>
                  );
                })}

                {isMobile && (
                  <button
                    onClick={addAgent}
                    className="flex-shrink-0 flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
                  >
                    <Plus className="w-4 h-4 text-[var(--color-text-muted)]" />
                  </button>
                )}
              </div>
            </div>

            {/* Right: server editor */}
            <div className={`flex-1 ${isMobile ? "p-4" : "p-6"} overflow-y-auto`}>
              {!current ? (
                <div className="h-full flex flex-col items-center justify-center text-center gap-3 text-[var(--color-text-muted)]">
                  <Server className="w-10 h-10 opacity-40" />
                  <div className="text-sm">No custom servers yet</div>
                  <Button variant="primary" size="sm" onClick={addAgent}>
                    <Plus className="w-4 h-4 mr-1" /> Create your first
                  </Button>
                </div>
              ) : (
                <div className="space-y-5">
                  {/* Identity */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                        Name
                      </label>
                      <input
                        type="text"
                        value={current.name}
                        onChange={(e) => {
                          const newName = e.target.value;
                          const taken = new Set(local.filter((x) => x.id !== current.id).map((x) => x.id));
                          const desired = generateId(newName);
                          const newId = desired && !taken.has(desired) ? desired : current.id;
                          updateAgent(current.id, { name: newName, id: newId });
                          if (newId !== current.id && selectedId === current.id) setSelectedId(newId);
                        }}
                        placeholder="My Agent"
                        className="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                        ID
                      </label>
                      <input
                        type="text"
                        value={idDraft}
                        onChange={(e) => setIdDraft(e.target.value)}
                        onBlur={() => {
                          // Commit on blur only if non-empty + unique. Empty
                          // resets to the existing id; collision keeps the
                          // draft visible (with the inline error) but does
                          // NOT mutate the canonical row id.
                          if (!current) return;
                          const trimmed = idDraft.trim();
                          if (!trimmed) {
                            setIdDraft(current.id);
                            return;
                          }
                          if (trimmed === current.id) return;
                          if (idDraftCollides) return;
                          updateAgent(current.id, { id: trimmed });
                          if (selectedId === current.id) setSelectedId(trimmed);
                        }}
                        placeholder="my-agent"
                        className={`w-full h-9 rounded-md border bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none font-mono ${
                          idDraftCollides
                            ? "border-[var(--color-error)] focus:border-[var(--color-error)]"
                            : "border-[var(--color-border)] focus:border-[var(--color-highlight)]"
                        }`}
                        aria-invalid={idDraftCollides}
                      />
                      {idDraftCollides && (
                        <p className="text-[11px] text-[var(--color-error)] mt-1">
                          ID already in use by another server.
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="border-t border-[var(--color-border)]" />

                  {/* Type tabs */}
                  <div>
                    <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-2">
                      Type
                    </label>
                    <div className="flex gap-2">
                      {(["local", "remote"] as const).map((t) => {
                        const active = current.type === t;
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() =>
                              updateAgent(current.id, t === "local"
                                ? { type: "local", url: undefined, auth_header: undefined }
                                : { type: "remote", command: undefined, args: undefined })
                            }
                            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                              active
                                ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-text)]"
                                : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                            }`}
                          >
                            {t === "local" ? <Terminal className="w-4 h-4" /> : <Globe className="w-4 h-4" />}
                            {t === "local" ? "Local" : "Remote"}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Local fields */}
                  {current.type === "local" && (
                    <>
                      <div>
                        <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                          Command
                        </label>
                        <input
                          type="text"
                          value={current.command ?? ""}
                          onChange={(e) => updateAgent(current.id, { command: e.target.value })}
                          placeholder="/usr/local/bin/my-agent"
                          className="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                          Arguments
                        </label>
                        <input
                          type="text"
                          value={argsDraft}
                          onChange={(e) => setArgsDraft(e.target.value)}
                          onBlur={() => {
                            const trimmed = argsDraft.trim();
                            updateAgent(current.id, {
                              args: trimmed ? trimmed.split(/\s+/) : undefined,
                            });
                          }}
                          placeholder="--acp --verbose"
                          className="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] font-mono"
                        />
                        <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                          Space-separated arguments
                        </p>
                      </div>
                    </>
                  )}

                  {/* Remote fields */}
                  {current.type === "remote" && (
                    <>
                      <div>
                        <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                          WebSocket URL
                        </label>
                        <input
                          type="text"
                          value={current.url ?? ""}
                          onChange={(e) => updateAgent(current.id, { url: e.target.value })}
                          placeholder="wss://agent.example.com/acp"
                          className="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider block mb-1.5">
                          Auth Header
                        </label>
                        <input
                          type="text"
                          value={current.auth_header ?? ""}
                          onChange={(e) => updateAgent(current.id, { auth_header: e.target.value })}
                          placeholder="Bearer sk-xxx"
                          className="w-full h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)] font-mono"
                        />
                        <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                          Optional Authorization header value
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className={`flex items-center justify-end gap-3 ${isMobile ? "px-4 py-3" : "px-6 py-4"} border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]`}>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave}>
              Save Custom Agent Servers
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
