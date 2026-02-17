import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Pencil, Trash2, Globe, Terminal } from "lucide-react";
import type { CustomAgent } from "../../api/config";

interface CustomAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents: CustomAgent[];
  onSave: (agents: CustomAgent[]) => void;
}

interface FormData {
  id: string;
  name: string;
  type: "local" | "remote";
  command: string;
  args: string;
  url: string;
  auth_header: string;
}

const emptyForm: FormData = {
  id: "",
  name: "",
  type: "local",
  command: "",
  args: "",
  url: "",
  auth_header: "",
};

function generateId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function CustomAgentModal({
  isOpen,
  onClose,
  agents,
  onSave,
}: CustomAgentModalProps) {
  const [localAgents, setLocalAgents] = useState<CustomAgent[]>(agents);
  const [viewMode, setViewMode] = useState<"list" | "form">("list");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm);
  const [idManuallyEdited, setIdManuallyEdited] = useState(false);

  // Sync when opened
  useEffect(() => {
    if (isOpen) {
      setLocalAgents(agents);
      setViewMode("list");
      setEditingIndex(null);
    }
  }, [isOpen, agents]);

  const handleAdd = () => {
    setFormData(emptyForm);
    setEditingIndex(null);
    setIdManuallyEdited(false);
    setViewMode("form");
  };

  const handleEdit = (index: number) => {
    const agent = localAgents[index];
    setFormData({
      id: agent.id,
      name: agent.name,
      type: agent.type,
      command: agent.command || "",
      args: agent.args?.join(" ") || "",
      url: agent.url || "",
      auth_header: agent.auth_header || "",
    });
    setEditingIndex(index);
    setIdManuallyEdited(true);
    setViewMode("form");
  };

  const handleDelete = (index: number) => {
    const updated = localAgents.filter((_, i) => i !== index);
    setLocalAgents(updated);
    onSave(updated);
  };

  const handleFormSave = () => {
    if (!formData.name.trim()) return;
    const id = formData.id.trim() || generateId(formData.name);
    if (!id) return;

    if (formData.type === "local" && !formData.command.trim()) return;
    if (formData.type === "remote" && !formData.url.trim()) return;

    const agent: CustomAgent = {
      id,
      name: formData.name.trim(),
      type: formData.type,
      ...(formData.type === "local"
        ? {
            command: formData.command.trim(),
            args: formData.args.trim()
              ? formData.args.trim().split(/\s+/)
              : undefined,
          }
        : {
            url: formData.url.trim(),
            auth_header: formData.auth_header.trim() || undefined,
          }),
    };

    let updated: CustomAgent[];
    if (editingIndex !== null) {
      updated = [...localAgents];
      updated[editingIndex] = agent;
    } else {
      updated = [...localAgents, agent];
    }

    setLocalAgents(updated);
    onSave(updated);
    setViewMode("list");
  };

  const handleNameChange = (name: string) => {
    setFormData((prev) => ({
      ...prev,
      name,
      ...(idManuallyEdited ? {} : { id: generateId(name) }),
    }));
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center"
        onClick={onClose}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/50" />

        {/* Panel */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 20 }}
          transition={{ duration: 0.2 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-lg mx-4 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="text-base font-semibold text-[var(--color-text)]">
              {viewMode === "form"
                ? editingIndex !== null
                  ? "Edit Agent"
                  : "Add Agent"
                : "Custom Agents"}
            </h2>
            <button
              onClick={viewMode === "form" ? () => setViewMode("list") : onClose}
              className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Content */}
          <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
            {viewMode === "list" ? (
              <div className="space-y-2">
                {localAgents.length === 0 ? (
                  <div className="text-center py-8 text-sm text-[var(--color-text-muted)]">
                    No custom agents configured.
                  </div>
                ) : (
                  localAgents.map((agent, index) => (
                    <div
                      key={agent.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                    >
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--color-bg-tertiary)]">
                        {agent.type === "remote" ? (
                          <Globe className="w-4 h-4 text-[var(--color-info)]" />
                        ) : (
                          <Terminal className="w-4 h-4 text-[var(--color-text-muted)]" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-[var(--color-text)] truncate">
                          {agent.name}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)] truncate">
                          {agent.type === "remote"
                            ? agent.url
                            : agent.command}
                        </div>
                      </div>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          agent.type === "remote"
                            ? "bg-[var(--color-info)]/15 text-[var(--color-info)]"
                            : "bg-[var(--color-text-muted)]/15 text-[var(--color-text-muted)]"
                        }`}
                      >
                        {agent.type}
                      </span>
                      <button
                        onClick={() => handleEdit(index)}
                        className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(index)}
                        className="p-1.5 rounded text-[var(--color-text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}

                <button
                  onClick={handleAdd}
                  className="w-full flex items-center justify-center gap-2 p-3 rounded-lg border border-dashed border-[var(--color-border)] text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/5 transition-all"
                >
                  <Plus className="w-4 h-4" />
                  Add Agent
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Name */}
                <div>
                  <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                    Name
                  </label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="My Agent"
                    className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                </div>

                {/* ID */}
                <div>
                  <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                    ID
                  </label>
                  <input
                    type="text"
                    value={formData.id}
                    onChange={(e) => {
                      setFormData((prev) => ({ ...prev, id: e.target.value }));
                      setIdManuallyEdited(true);
                    }}
                    placeholder="my-agent"
                    className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono"
                  />
                </div>

                {/* Type Tabs */}
                <div>
                  <label className="text-xs font-medium text-[var(--color-text-muted)] mb-2 block">
                    Type
                  </label>
                  <div className="flex gap-2">
                    {(["local", "remote"] as const).map((t) => (
                      <button
                        key={t}
                        onClick={() =>
                          setFormData((prev) => ({ ...prev, type: t }))
                        }
                        className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all ${
                          formData.type === t
                            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-text)]"
                            : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                        }`}
                      >
                        {t === "local" ? (
                          <Terminal className="w-4 h-4" />
                        ) : (
                          <Globe className="w-4 h-4" />
                        )}
                        {t === "local" ? "Local" : "Remote"}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Local Fields */}
                {formData.type === "local" && (
                  <>
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                        Command *
                      </label>
                      <input
                        type="text"
                        value={formData.command}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            command: e.target.value,
                          }))
                        }
                        placeholder="/usr/local/bin/my-agent"
                        className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                        Arguments
                      </label>
                      <input
                        type="text"
                        value={formData.args}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            args: e.target.value,
                          }))
                        }
                        placeholder="--acp --verbose"
                        className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono"
                      />
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                        Space-separated arguments
                      </p>
                    </div>
                  </>
                )}

                {/* Remote Fields */}
                {formData.type === "remote" && (
                  <>
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                        WebSocket URL *
                      </label>
                      <input
                        type="text"
                        value={formData.url}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            url: e.target.value,
                          }))
                        }
                        placeholder="wss://agent.example.com/acp"
                        className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-[var(--color-text-muted)] mb-1 block">
                        Auth Header
                      </label>
                      <input
                        type="text"
                        value={formData.auth_header}
                        onChange={(e) =>
                          setFormData((prev) => ({
                            ...prev,
                            auth_header: e.target.value,
                          }))
                        }
                        placeholder="Bearer sk-xxx"
                        className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] font-mono"
                      />
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                        Optional Authorization header value
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          {viewMode === "form" && (
            <div className="flex justify-end gap-2 px-5 py-3 border-t border-[var(--color-border)]">
              <button
                onClick={() => setViewMode("list")}
                className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleFormSave}
                className="px-4 py-2 text-sm bg-[var(--color-highlight)] text-white rounded-lg hover:opacity-90 transition-opacity"
              >
                {editingIndex !== null ? "Update" : "Add"}
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
