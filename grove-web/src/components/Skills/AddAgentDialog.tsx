import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import { addAgent, updateAgent } from "../../api";
import type { AgentDef } from "../../api";

interface AddAgentDialogProps {
  isOpen: boolean;
  editingAgent: AgentDef | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AddAgentDialog({ isOpen, editingAgent, onClose, onSaved }: AddAgentDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const [globalDir, setGlobalDir] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEditing = editingAgent !== null;

  useEffect(() => {
    if (editingAgent) {
      setDisplayName(editingAgent.display_name);
      setGlobalDir(editingAgent.global_skills_dir);
      setProjectDir(editingAgent.project_skills_dir);
    } else {
      setDisplayName("");
      setGlobalDir("");
      setProjectDir("");
    }
    setError(null);
  }, [editingAgent, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Auto-generate directory paths from name
  useEffect(() => {
    if (!isEditing && displayName && !globalDir && !projectDir) {
      const slug = displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
      setGlobalDir(`~/.${slug}/skills`);
      setProjectDir(`.${slug}/skills`);
    }
  }, [displayName, isEditing, globalDir, projectDir]);

  const handleSubmit = async () => {
    if (!displayName.trim()) { setError("Name is required"); return; }
    if (!globalDir.trim()) { setError("Global skills directory is required"); return; }
    if (!projectDir.trim()) { setError("Project skills directory is required"); return; }

    setIsSaving(true);
    setError(null);
    try {
      const req = {
        display_name: displayName.trim(),
        global_skills_dir: globalDir.trim(),
        project_skills_dir: projectDir.trim(),
      };
      if (isEditing) {
        await updateAgent(editingAgent!.id, req);
      } else {
        await addAgent(req);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save agent");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="text-lg font-semibold text-[var(--color-text)]">
                  {isEditing ? "Edit Agent" : "Add Custom Agent"}
                </h2>
                <button
                  onClick={onClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Form */}
              <div className="px-5 py-4 space-y-4">
                {/* Name */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Name
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g., My Agent"
                    className="w-full px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                </div>

                {/* Global Skills Dir */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Global Skills Directory
                  </label>
                  <input
                    type="text"
                    value={globalDir}
                    onChange={(e) => setGlobalDir(e.target.value)}
                    placeholder="~/.my-agent/skills"
                    className="w-full px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    Where skills are installed globally for this agent.
                  </p>
                </div>

                {/* Project Skills Dir */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Project Skills Directory
                  </label>
                  <input
                    type="text"
                    value={projectDir}
                    onChange={(e) => setProjectDir(e.target.value)}
                    placeholder=".my-agent/skills"
                    className="w-full px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    Relative path from project root for project-scoped skills.
                  </p>
                </div>

                {error && (
                  <p className="text-xs text-[var(--color-error)]">{error}</p>
                )}
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={onClose}>Cancel</Button>
                <Button variant="primary" onClick={handleSubmit} disabled={isSaving}>
                  {isSaving ? "Saving..." : isEditing ? "Save" : "Add Agent"}
                </Button>
              </div>
      </div>
    </DialogShell>
  );
}
