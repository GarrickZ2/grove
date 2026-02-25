import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GitBranch, X, ChevronDown, Check } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";
import type { Branch } from "../../data/types";

interface NewBranchDialogProps {
  isOpen: boolean;
  branches: Branch[];
  currentBranch: string;
  onClose: () => void;
  onCreate: (branchName: string, baseBranch: string, checkoutAfter: boolean) => void;
}

export function NewBranchDialog({
  isOpen,
  branches,
  currentBranch,
  onClose,
  onCreate,
}: NewBranchDialogProps) {
  const [branchName, setBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState(currentBranch);
  const [checkoutAfter, setCheckoutAfter] = useState(true);
  const [showBranchDropdown, setShowBranchDropdown] = useState(false);

  const localBranches = branches.filter(b => b.isLocal);

  const handleCreate = () => {
    if (branchName.trim()) {
      onCreate(branchName.trim(), baseBranch, checkoutAfter);
      setBranchName("");
      setBaseBranch(currentBranch);
      setCheckoutAfter(true);
    }
  };

  const handleClose = () => {
    setBranchName("");
    setBaseBranch(currentBranch);
    setCheckoutAfter(true);
    onClose();
  };

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose}>
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-info)]/10">
                    <GitBranch className="w-5 h-5 text-[var(--color-info)]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">Create New Branch</h2>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Branch Name */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Branch name
                  </label>
                  <Input
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="feature/my-new-feature"
                    autoFocus
                  />
                </div>

                {/* Base Branch Selector */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Based on
                  </label>
                  <div className="relative">
                    <button
                      onClick={() => setShowBranchDropdown(!showBranchDropdown)}
                      className="w-full flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] text-sm hover:border-[var(--color-highlight)] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <GitBranch className="w-4 h-4 text-[var(--color-text-muted)]" />
                        <span>{baseBranch}</span>
                      </div>
                      <ChevronDown className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${showBranchDropdown ? "rotate-180" : ""}`} />
                    </button>

                    <AnimatePresence>
                      {showBranchDropdown && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className="absolute top-full left-0 right-0 mt-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-10 max-h-48 overflow-y-auto"
                        >
                          {localBranches.map((branch) => (
                            <button
                              key={branch.name}
                              onClick={() => {
                                setBaseBranch(branch.name);
                                setShowBranchDropdown(false);
                              }}
                              className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--color-bg-tertiary)] text-left transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                <GitBranch className="w-4 h-4 text-[var(--color-text-muted)]" />
                                <span className="text-sm text-[var(--color-text)]">{branch.name}</span>
                                {branch.isCurrent && (
                                  <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/20 text-[var(--color-highlight)]">
                                    current
                                  </span>
                                )}
                              </div>
                              {baseBranch === branch.name && (
                                <Check className="w-4 h-4 text-[var(--color-highlight)]" />
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Checkout After */}
                <label className="flex items-center gap-3 cursor-pointer">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={checkoutAfter}
                      onChange={(e) => setCheckoutAfter(e.target.checked)}
                      className="sr-only"
                    />
                    <div className={`w-5 h-5 rounded border-2 transition-colors flex items-center justify-center ${
                      checkoutAfter
                        ? "bg-[var(--color-highlight)] border-[var(--color-highlight)]"
                        : "border-[var(--color-border)]"
                    }`}>
                      {checkoutAfter && <Check className="w-3 h-3 text-white" />}
                    </div>
                  </div>
                  <span className="text-sm text-[var(--color-text)]">Checkout after creation</span>
                </label>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleCreate}
                  disabled={!branchName.trim()}
                >
                  Create Branch
                </Button>
              </div>
      </div>
    </DialogShell>
  );
}
