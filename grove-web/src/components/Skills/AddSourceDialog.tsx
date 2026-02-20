import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GitBranch, FolderOpen } from "lucide-react";
import { Button } from "../ui";
import { addSource, updateSource } from "../../api";
import type { SkillSource } from "../../api";

function extractNameFromUrl(url: string): string {
  let cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const segments = cleaned.split(/[/:\\]/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

interface AddSourceDialogProps {
  isOpen: boolean;
  editingSource: SkillSource | null;
  onClose: () => void;
  onSaved: () => void;
}

export function AddSourceDialog({ isOpen, editingSource, onClose, onSaved }: AddSourceDialogProps) {
  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"git" | "local">("git");
  const [url, setUrl] = useState("");
  const [subpath, setSubpath] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isNameAutoFilled, setIsNameAutoFilled] = useState(false);

  const isEditing = editingSource !== null;

  useEffect(() => {
    if (editingSource) {
      setName(editingSource.name);
      setSourceType(editingSource.source_type);
      setUrl(editingSource.url);
      setSubpath(editingSource.subpath || "");
      setIsNameAutoFilled(false);
    } else {
      setName("");
      setSourceType("git");
      setUrl("");
      setSubpath("");
      setIsNameAutoFilled(false);
    }
    setError(null);
  }, [editingSource, isOpen]);

  // Auto-fill name from URL when name is empty or was auto-filled
  useEffect(() => {
    if (isEditing) return;
    if (!url.trim()) return;
    if (name && !isNameAutoFilled) return;
    const extracted = extractNameFromUrl(url);
    if (extracted) {
      setName(extracted);
      setIsNameAutoFilled(true);
    }
  }, [url, isEditing, isNameAutoFilled, name]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const handleBrowse = async () => {
    setIsBrowsing(true);
    try {
      const response = await fetch("/api/v1/browse-folder");
      if (response.ok) {
        const data = await response.json();
        if (data.path) {
          // Remove trailing slash
          setUrl(data.path.replace(/\/+$/, ""));
        }
      }
    } catch {
      // User cancelled or command failed — ignore
    } finally {
      setIsBrowsing(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) { setError("Name is required"); return; }
    if (!url.trim()) { setError(sourceType === "git" ? "Repository URL is required" : "Path is required"); return; }

    setIsSaving(true);
    setError(null);
    try {
      const req = {
        name: name.trim(),
        source_type: sourceType,
        url: url.trim(),
        subpath: subpath.trim() || undefined,
      };
      if (isEditing) {
        await updateSource(editingSource!.name, req);
      } else {
        await addSource(req);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save source");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-50"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="text-lg font-semibold text-[var(--color-text)]">
                  {isEditing ? "Edit Source" : "Add Source"}
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
                    value={name}
                    onChange={(e) => { setName(e.target.value); setIsNameAutoFilled(false); }}
                    placeholder="Auto-filled from URL"
                    disabled={isEditing}
                    className="w-full px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] disabled:opacity-50"
                  />
                </div>

                {/* Type Toggle */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Type
                  </label>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setSourceType("git")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                        sourceType === "git"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <GitBranch className="w-4 h-4" />
                      Git
                    </button>
                    <button
                      onClick={() => setSourceType("local")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border transition-colors ${
                        sourceType === "local"
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                      }`}
                    >
                      <FolderOpen className="w-4 h-4" />
                      Local
                    </button>
                  </div>
                </div>

                {/* URL / Path */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    {sourceType === "git" ? "Repository URL" : "Local Path"}
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder={
                        sourceType === "git"
                          ? "https://github.com/org/skills-repo.git"
                          : "/home/user/my-skills"
                      }
                      className="flex-1 px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                    />
                    {sourceType === "local" && (
                      <Button variant="secondary" onClick={handleBrowse} disabled={isBrowsing}>
                        <FolderOpen className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </div>

                {/* Subpath */}
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1.5">
                    Subpath <span className="text-[var(--color-text-muted)]/50">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={subpath}
                    onChange={(e) => setSubpath(e.target.value)}
                    placeholder="e.g., skills/coding"
                    className="w-full px-3 py-2 text-sm font-mono bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]/50 focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)]"
                  />
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    Only scan skills from this subdirectory within the repository.
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
                  {isSaving ? "Saving..." : isEditing ? "Save" : "Add Source"}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
