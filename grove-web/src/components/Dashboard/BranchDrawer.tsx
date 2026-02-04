import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  Edit3,
  Trash2,
  GitMerge,
  ExternalLink,
} from "lucide-react";
import type { Branch } from "../../data/types";

interface BranchDrawerProps {
  isOpen: boolean;
  branches: Branch[];
  onClose: () => void;
  onCheckout: (branch: Branch) => void;
  onNewBranch: () => void;
  onRename: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
  onMerge: (branch: Branch) => void;
  onCreatePR: (branch: Branch) => void;
}

export function BranchDrawer({
  isOpen,
  branches,
  onClose,
  onCheckout,
  onNewBranch,
  onRename,
  onDelete,
  onMerge,
  onCreatePR,
}: BranchDrawerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showRemote, setShowRemote] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);

  const localBranches = branches.filter(b => b.isLocal);
  const remoteBranches = branches.filter(b => !b.isLocal);

  const filteredLocal = localBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredRemote = remoteBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleBranchClick = (branch: Branch) => {
    if (branch.isCurrent) return;
    setSelectedBranch(selectedBranch?.name === branch.name ? null : branch);
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
            onClick={onClose}
            className="fixed inset-0 bg-black/30 z-40"
          />

          {/* Drawer */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed right-0 top-0 bottom-0 w-80 bg-[var(--color-bg-secondary)] border-l border-[var(--color-border)] shadow-xl z-50 flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
              <div className="flex items-center gap-2">
                <GitBranch className="w-5 h-5 text-[var(--color-highlight)]" />
                <h2 className="font-semibold text-[var(--color-text)]">Switch Branch</h2>
              </div>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search */}
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                <input
                  type="text"
                  placeholder="Search branches..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
                />
              </div>
            </div>

            {/* Branch List */}
            <div className="flex-1 overflow-y-auto p-2">
              {/* Local Branches */}
              <div className="text-xs font-medium text-[var(--color-text-muted)] px-2 py-1.5 uppercase tracking-wider">
                Local
              </div>
              <div className="space-y-0.5">
                {filteredLocal.map((branch) => (
                  <div key={branch.name}>
                    <button
                      onClick={() => handleBranchClick(branch)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-colors text-left
                        ${branch.isCurrent
                          ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]/30"
                          : selectedBranch?.name === branch.name
                            ? "bg-[var(--color-bg-tertiary)]"
                            : "hover:bg-[var(--color-bg-tertiary)]"
                        }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <GitBranch className={`w-4 h-4 flex-shrink-0 ${
                          branch.isCurrent ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"
                        }`} />
                        <span className={`text-sm truncate ${
                          branch.isCurrent ? "text-[var(--color-highlight)] font-medium" : "text-[var(--color-text)]"
                        }`}>
                          {branch.name}
                        </span>
                      </div>
                      {branch.isCurrent && (
                        <Check className="w-4 h-4 text-[var(--color-highlight)] flex-shrink-0" />
                      )}
                    </button>

                    {/* Actions Panel */}
                    <AnimatePresence>
                      {selectedBranch?.name === branch.name && !branch.isCurrent && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="px-2 py-2 ml-6 space-y-1">
                            <button
                              onClick={() => {
                                onCheckout(branch);
                                onClose();
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white bg-[var(--color-highlight)] hover:opacity-90 rounded-lg transition-colors"
                            >
                              <Check className="w-4 h-4" />
                              Checkout
                            </button>
                            <button
                              onClick={() => {
                                onMerge(branch);
                                onClose();
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
                            >
                              <GitMerge className="w-4 h-4" />
                              Merge into current
                            </button>
                            <button
                              onClick={() => {
                                onCreatePR(branch);
                                onClose();
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
                            >
                              <ExternalLink className="w-4 h-4" />
                              Create PR
                            </button>
                            <div className="border-t border-[var(--color-border)] my-1" />
                            <button
                              onClick={() => {
                                onRename(branch);
                                onClose();
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg)] rounded-lg transition-colors"
                            >
                              <Edit3 className="w-4 h-4" />
                              Rename
                            </button>
                            <button
                              onClick={() => {
                                onDelete(branch);
                                onClose();
                              }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-error)] hover:bg-[var(--color-error)]/10 rounded-lg transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                              Delete
                            </button>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))}
              </div>

              {/* Remote Branches */}
              {filteredRemote.length > 0 && (
                <div className="mt-4">
                  <button
                    onClick={() => setShowRemote(!showRemote)}
                    className="flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] px-2 py-1.5 hover:text-[var(--color-text)] transition-colors uppercase tracking-wider"
                  >
                    {showRemote ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Remote ({filteredRemote.length})
                  </button>
                  <AnimatePresence>
                    {showRemote && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={{ opacity: 0, height: 0 }}
                        className="space-y-0.5 overflow-hidden"
                      >
                        {filteredRemote.map((branch) => (
                          <button
                            key={branch.name}
                            onClick={() => {
                              onCheckout(branch);
                              onClose();
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors text-left"
                          >
                            <GitBranch className="w-4 h-4 text-[var(--color-text-muted)]" />
                            <span className="text-sm text-[var(--color-text)] truncate">
                              {branch.name}
                            </span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-[var(--color-border)]">
              <button
                onClick={() => {
                  onNewBranch();
                  onClose();
                }}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[var(--color-highlight)] hover:opacity-90 text-white rounded-lg text-sm font-medium transition-opacity"
              >
                <Plus className="w-4 h-4" />
                New Branch
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
