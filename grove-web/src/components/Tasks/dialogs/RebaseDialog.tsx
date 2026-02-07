import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GitBranchPlus, Check, Search } from "lucide-react";
import { Button } from "../../ui";

interface RebaseDialogProps {
  isOpen: boolean;
  taskName?: string;
  currentTarget: string;
  availableBranches: string[];
  onClose: () => void;
  onRebase: (targetBranch: string) => void;
}

export function RebaseDialog({
  isOpen,
  taskName,
  currentTarget,
  availableBranches,
  onClose,
  onRebase,
}: RebaseDialogProps) {
  const [selectedBranch, setSelectedBranch] = useState(currentTarget);
  const [searchQuery, setSearchQuery] = useState("");

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen]);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedBranch(currentTarget);
      setSearchQuery("");
    }
  }, [isOpen, currentTarget]);

  // Filter branches by search query
  const filteredBranches = useMemo(() => {
    if (!searchQuery) return availableBranches;
    const query = searchQuery.toLowerCase();
    return availableBranches.filter((branch) =>
      branch.toLowerCase().includes(query)
    );
  }, [availableBranches, searchQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedBranch && selectedBranch !== currentTarget) {
      onRebase(selectedBranch);
      onClose();
    }
  };

  const handleClose = () => {
    setSelectedBranch(currentTarget);
    setSearchQuery("");
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md z-50"
          >
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-2">
                  <GitBranchPlus className="w-5 h-5 text-[var(--color-highlight)]" />
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">
                    Change Target Branch
                  </h2>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <form onSubmit={handleSubmit} className="p-4">
                <div className="space-y-4">
                  {/* Task Info */}
                  {taskName && (
                    <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
                      <div className="text-sm text-[var(--color-text-muted)]">
                        Task: <span className="text-[var(--color-text)] font-medium">{taskName}</span>
                      </div>
                      <div className="text-sm text-[var(--color-text-muted)] mt-1">
                        Current target: <code className="font-mono text-[var(--color-text)]">{currentTarget}</code>
                      </div>
                    </div>
                  )}

                  {/* Search Input */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                    <input
                      type="text"
                      placeholder="Search branches..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full pl-9 pr-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text)] text-sm placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-highlight)]/50"
                    />
                  </div>

                  {/* Branch List */}
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text)] mb-2">
                      Select Target Branch
                    </label>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {filteredBranches.length === 0 ? (
                        <div className="text-sm text-[var(--color-text-muted)] text-center py-4">
                          No branches found
                        </div>
                      ) : (
                        filteredBranches.map((branch) => {
                          const isCurrent = branch === currentTarget;
                          const isSelected = selectedBranch === branch;
                          return (
                            <button
                              key={branch}
                              type="button"
                              onClick={() => setSelectedBranch(branch)}
                              disabled={isCurrent}
                              className={`
                                w-full flex items-center justify-between px-3 py-2 rounded-lg text-sm
                                transition-colors text-left
                                ${
                                  isCurrent
                                    ? "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)] cursor-not-allowed opacity-60"
                                    : isSelected
                                    ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)] text-[var(--color-text)]"
                                    : "border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                                }
                              `}
                            >
                              <span className="font-mono truncate">
                                {branch}
                                {isCurrent && (
                                  <span className="ml-2 text-xs text-[var(--color-text-muted)]">(current)</span>
                                )}
                              </span>
                              {isSelected && !isCurrent && (
                                <Check className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Change Info */}
                  {selectedBranch !== currentTarget && (
                    <p className="text-sm text-[var(--color-text-muted)]">
                      This will change the target branch from{" "}
                      <code className="font-mono text-[var(--color-text)]">
                        {currentTarget}
                      </code>{" "}
                      to{" "}
                      <code className="font-mono text-[var(--color-highlight)]">
                        {selectedBranch}
                      </code>
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="secondary" type="button" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={selectedBranch === currentTarget}
                  >
                    <GitBranchPlus className="w-4 h-4 mr-1.5" />
                    Change Target
                  </Button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
