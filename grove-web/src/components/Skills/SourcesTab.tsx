import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Plus, RefreshCw, Trash2, Edit3, GitBranch, FolderOpen, ExternalLink, ArrowUpCircle, AlertTriangle } from "lucide-react";
import { Button } from "../ui";
import { AddSourceDialog } from "./AddSourceDialog";
import { syncSource, syncAllSources, deleteSource as apiDeleteSource, checkSourceUpdates } from "../../api";
import type { SkillSource } from "../../api";

interface SourcesTabProps {
  sources: SkillSource[];
  onRefresh: () => Promise<void>;
}

export function SourcesTab({ sources, onRefresh }: SourcesTabProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [editSource, setEditSource] = useState<SkillSource | null>(null);
  const [syncingName, setSyncingName] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<SkillSource | null>(null);

  const gitSourcesWithUpdates = sources.filter((s) => s.source_type === "git" && s.has_remote_updates);
  const hasAnyUpdates = gitSourcesWithUpdates.length > 0;

  const handleSync = async (name: string) => {
    setSyncingName(name);
    try {
      await syncSource(name);
      await onRefresh();
    } catch (err) {
      console.error("Sync failed:", err);
    } finally {
      setSyncingName(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    const name = deleteConfirm.name;
    setDeletingName(name);
    setDeleteConfirm(null);
    try {
      await apiDeleteSource(name);
      await onRefresh();
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeletingName(null);
    }
  };

  const handleCheckUpdates = async () => {
    setIsChecking(true);
    try {
      await checkSourceUpdates();
      await onRefresh();
    } catch (err) {
      console.error("Check updates failed:", err);
    } finally {
      setIsChecking(false);
    }
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      await syncAllSources();
      await onRefresh();
    } catch (err) {
      console.error("Sync all failed:", err);
    } finally {
      setSyncingAll(false);
    }
  };

  const handleAdded = async () => {
    setShowAdd(false);
    setEditSource(null);
    await onRefresh();
  };

  const formatRelativeTime = (iso: string | null) => {
    if (!iso) return "Never";
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Skill Sources</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
            Manage git repositories and local directories where skills are discovered.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={handleCheckUpdates} disabled={isChecking}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isChecking ? "animate-spin" : ""}`} />
            Check Updates
          </Button>
          {hasAnyUpdates && (
            <Button variant="secondary" size="sm" onClick={handleSyncAll} disabled={syncingAll}>
              <ArrowUpCircle className={`w-3.5 h-3.5 mr-1.5 ${syncingAll ? "animate-spin" : ""}`} />
              Sync All
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Source
          </Button>
        </div>
      </div>

      {/* Source List */}
      {sources.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <FolderOpen className="w-12 h-12 text-[var(--color-text-muted)] mb-3 opacity-40" />
          <p className="text-sm text-[var(--color-text-muted)] mb-4">No sources configured yet.</p>
          <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add Your First Source
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <motion.div
              key={source.name}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`border rounded-lg bg-[var(--color-bg-secondary)] p-4 ${
                source.has_remote_updates
                  ? "border-[var(--color-warning)]/50"
                  : "border-[var(--color-border)]"
              }`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">
                      {source.name}
                    </h3>
                    {source.has_remote_updates && (
                      <span className="px-1.5 py-0.5 text-[9px] font-semibold rounded-md bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
                        Update available
                      </span>
                    )}
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-medium rounded-md ${
                        source.source_type === "git"
                          ? "bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
                          : "bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
                      }`}
                    >
                      {source.source_type === "git" ? (
                        <span className="flex items-center gap-0.5">
                          <GitBranch className="w-3 h-3" /> Git
                        </span>
                      ) : (
                        <span className="flex items-center gap-0.5">
                          <FolderOpen className="w-3 h-3" /> Local
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] mb-2">
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                    <span className="truncate font-mono">{source.url}</span>
                    {source.subpath && (
                      <span className="text-[var(--color-highlight)] font-mono">/{source.subpath}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
                    <span>{source.skill_count} skill{source.skill_count !== 1 ? "s" : ""}</span>
                    <span>Synced {formatRelativeTime(source.last_synced)}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 ml-3">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleSync(source.name)}
                    disabled={syncingName === source.name}
                    title="Sync"
                    className="p-1.5 rounded-md hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={`w-4 h-4 ${syncingName === source.name ? "animate-spin" : ""}`} />
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setEditSource(source)}
                    title="Edit"
                    className="p-1.5 rounded-md hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  >
                    <Edit3 className="w-4 h-4" />
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setDeleteConfirm(source)}
                    disabled={deletingName === source.name}
                    title="Remove"
                    className="p-1.5 rounded-md hover:bg-[var(--color-error)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors disabled:opacity-50"
                  >
                    <Trash2 className="w-4 h-4" />
                  </motion.button>
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <AddSourceDialog
        isOpen={showAdd || editSource !== null}
        editingSource={editSource}
        onClose={() => { setShowAdd(false); setEditSource(null); }}
        onSaved={handleAdded}
      />

      {/* Delete Confirmation Dialog */}
      <DeleteSourceDialog
        source={deleteConfirm}
        onConfirm={handleDelete}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

function DeleteSourceDialog({
  source,
  onConfirm,
  onCancel,
}: {
  source: SkillSource | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!source) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [source, onCancel]);

  return (
    <AnimatePresence>
      {source && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onCancel}
            className="fixed inset-0 bg-black/50 z-50"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-sm"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              <div className="px-5 py-5">
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-error)]/10 flex-shrink-0">
                    <AlertTriangle className="w-5 h-5 text-[var(--color-error)]" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--color-text)]">Remove Source</h3>
                    <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                      This action cannot be undone.
                    </p>
                  </div>
                </div>
                <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
                  Are you sure you want to remove <span className="font-medium text-[var(--color-text)]">{source.name}</span>?
                  {source.skill_count > 0 && (
                    <> This source contains {source.skill_count} skill{source.skill_count !== 1 ? "s" : ""}.</>
                  )}
                </p>
              </div>
              <div className="flex justify-end gap-2 px-5 py-3 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={onConfirm}
                  className="px-3 py-1.5 rounded-lg text-sm font-medium text-white bg-[var(--color-error)] hover:bg-[var(--color-error)]/90 transition-colors"
                >
                  Remove
                </motion.button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
