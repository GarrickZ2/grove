import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitBranch,
  Search,
  Plus,
  ChevronDown,
  ChevronRight,
  MoreVertical,
  Check,
  Edit3,
  Trash2,
  GitMerge,
  ExternalLink,
} from "lucide-react";
import type { Branch } from "../../data/types";

interface BranchListProps {
  branches: Branch[];
  onCheckout: (branch: Branch) => void;
  onNewBranch: () => void;
  onRename: (branch: Branch) => void;
  onDelete: (branch: Branch) => void;
  onMerge: (branch: Branch) => void;
  onCreatePR: (branch: Branch) => void;
}

export function BranchList({
  branches,
  onCheckout,
  onNewBranch,
  onRename,
  onDelete,
  onMerge,
  onCreatePR,
}: BranchListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [showRemote, setShowRemote] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  const localBranches = branches.filter(b => b.isLocal);
  const remoteBranches = branches.filter(b => !b.isLocal);

  const filteredLocal = localBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredRemote = remoteBranches.filter(b =>
    b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleMenuClick = (branchName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenMenu(openMenu === branchName ? null : branchName);
  };

  const renderBranchItem = (branch: Branch, index: number) => {
    const isMenuOpen = openMenu === branch.name;

    return (
      <motion.div
        key={branch.name}
        initial={{ opacity: 0, x: -10 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.03 }}
        className="relative group"
      >
        <div
          className={`flex items-center justify-between px-3 py-2 rounded-lg transition-colors
            ${branch.isCurrent
              ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]/30"
              : "hover:bg-[var(--color-bg-tertiary)]"
            }`}
        >
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <GitBranch className={`w-4 h-4 flex-shrink-0 ${
              branch.isCurrent ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"
            }`} />
            <span className={`text-sm truncate ${
              branch.isCurrent ? "text-[var(--color-highlight)] font-medium" : "text-[var(--color-text)]"
            }`}>
              {branch.name}
            </span>
            {branch.isCurrent && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/20 text-[var(--color-highlight)] flex-shrink-0">
                current
              </span>
            )}
          </div>

          {/* Actions */}
          {!branch.isCurrent && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => onCheckout(branch)}
                className="px-2 py-1 text-xs rounded bg-[var(--color-bg)] hover:bg-[var(--color-highlight)] hover:text-white text-[var(--color-text-muted)] border border-[var(--color-border)] transition-colors"
              >
                checkout
              </motion.button>

              {branch.isLocal && (
                <div className="relative">
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={(e) => handleMenuClick(branch.name, e)}
                    className="p-1 rounded hover:bg-[var(--color-bg)] text-[var(--color-text-muted)] transition-colors"
                  >
                    <MoreVertical className="w-4 h-4" />
                  </motion.button>

                  {/* Dropdown Menu */}
                  <AnimatePresence>
                    {isMenuOpen && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.95, y: -5 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: -5 }}
                        className="absolute right-0 top-full mt-1 w-48 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg shadow-lg overflow-hidden z-20"
                      >
                        <button
                          onClick={() => {
                            onRename(branch);
                            setOpenMenu(null);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                        >
                          <Edit3 className="w-4 h-4" />
                          Rename
                        </button>
                        <button
                          onClick={() => {
                            onMerge(branch);
                            setOpenMenu(null);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                        >
                          <GitMerge className="w-4 h-4" />
                          Merge into current
                        </button>
                        <button
                          onClick={() => {
                            onCreatePR(branch);
                            setOpenMenu(null);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                          Create PR
                        </button>
                        <div className="border-t border-[var(--color-border)]" />
                        <button
                          onClick={() => {
                            onDelete(branch);
                            setOpenMenu(null);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-error)] hover:bg-[var(--color-error)]/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                          Delete
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </div>
          )}

          {branch.isCurrent && (
            <Check className="w-4 h-4 text-[var(--color-highlight)]" />
          )}
        </div>
      </motion.div>
    );
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-medium text-[var(--color-text)]">Branches</h2>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onNewBranch}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-[var(--color-highlight)] text-white hover:opacity-90 transition-opacity"
        >
          <Plus className="w-3 h-3" />
          New
        </motion.button>
      </div>

      {/* Search */}
      <div className="px-3 py-2 border-b border-[var(--color-border)]">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            type="text"
            placeholder="Search branches..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)]"
          />
        </div>
      </div>

      {/* Local Branches */}
      <div className="p-2 max-h-[280px] overflow-y-auto">
        <div className="text-xs font-medium text-[var(--color-text-muted)] px-3 py-1.5">Local</div>
        <div className="space-y-0.5">
          {filteredLocal.map((branch, index) => renderBranchItem(branch, index))}
        </div>

        {/* Remote Branches */}
        {filteredRemote.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowRemote(!showRemote)}
              className="flex items-center gap-1 text-xs font-medium text-[var(--color-text-muted)] px-3 py-1.5 hover:text-[var(--color-text)] transition-colors"
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
                  {filteredRemote.map((branch, index) => renderBranchItem(branch, index))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </div>

      {/* Click outside to close menu */}
      {openMenu && (
        <div
          className="fixed inset-0 z-10"
          onClick={() => setOpenMenu(null)}
        />
      )}
    </div>
  );
}
