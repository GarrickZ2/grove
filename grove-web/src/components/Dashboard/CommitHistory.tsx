import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight, ChevronDown, GitCommit, FileText, Plus, Minus, ArrowRight, Loader2 } from "lucide-react";
import type { Commit, CommitFileChange } from "../../data/types";

interface CommitHistoryProps {
  commits: Commit[];
  getFileChanges: (hash: string) => CommitFileChange[];
  isLoading?: boolean;
}

function formatTimeAgo(date: Date | undefined, timeAgo: string | undefined): string {
  // Prefer pre-formatted timeAgo string from API
  if (timeAgo) return timeAgo;

  // Fall back to calculating from date
  if (!date) return "";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getStatusIcon(status: CommitFileChange['status']) {
  switch (status) {
    case 'added':
      return <Plus className="w-3 h-3 text-[var(--color-success)]" />;
    case 'deleted':
      return <Minus className="w-3 h-3 text-[var(--color-error)]" />;
    case 'renamed':
      return <ArrowRight className="w-3 h-3 text-[var(--color-info)]" />;
    default:
      return <FileText className="w-3 h-3 text-[var(--color-warning)]" />;
  }
}

export function CommitHistory({ commits, getFileChanges, isLoading = false }: CommitHistoryProps) {
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null);

  const toggleExpand = (hash: string) => {
    setExpandedCommit(expandedCommit === hash ? null : hash);
  };

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-medium text-[var(--color-text)]">Recent Commits</h2>
        {isLoading && (
          <Loader2 className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />
        )}
      </div>

      {/* Commits List */}
      <div className="max-h-[400px] overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-8 text-center">
            <Loader2 className="w-8 h-8 mx-auto text-[var(--color-text-muted)] animate-spin mb-2" />
            <p className="text-sm text-[var(--color-text-muted)]">Loading commits...</p>
          </div>
        ) : commits.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <GitCommit className="w-10 h-10 mx-auto text-[var(--color-text-muted)] mb-2" />
            <p className="text-sm text-[var(--color-text-muted)]">No commits yet</p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {commits.map((commit, index) => {
              const isExpanded = expandedCommit === commit.hash;
              const fileChanges = getFileChanges(commit.hash);
              const hasFiles = fileChanges.length > 0;

              return (
                <motion.div
                  key={commit.hash}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: index * 0.05 }}
                >
                  {/* Commit Row */}
                  <button
                    onClick={() => hasFiles && toggleExpand(commit.hash)}
                    className={`w-full px-4 py-3 text-left transition-colors ${
                      hasFiles ? "hover:bg-[var(--color-bg-tertiary)] cursor-pointer" : ""
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Expand Icon */}
                      <div className="mt-0.5 w-4 h-4 flex items-center justify-center">
                        {hasFiles ? (
                          isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)]" />
                          )
                        ) : (
                          <div className="w-1.5 h-1.5 rounded-full bg-[var(--color-text-muted)]" />
                        )}
                      </div>

                      {/* Commit Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <code className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg)] text-[var(--color-highlight)] font-mono">
                            {commit.hash.substring(0, 7)}
                          </code>
                          <span className="text-sm text-[var(--color-text)] truncate">
                            {commit.message}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                          <span>{commit.author}</span>
                          <span>•</span>
                          <span>{formatTimeAgo(commit.date, commit.timeAgo)}</span>
                        </div>
                      </div>
                    </div>
                  </button>

                  {/* Expanded File Changes */}
                  <AnimatePresence>
                    {isExpanded && hasFiles && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="px-4 pb-3 pl-11">
                          <div className="rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] overflow-hidden">
                            <div className="px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
                              Changes ({fileChanges.length} files)
                            </div>
                            <div className="divide-y divide-[var(--color-border)]">
                              {fileChanges.map((file, fileIndex) => (
                                <div
                                  key={fileIndex}
                                  className="flex items-center justify-between px-3 py-2"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    {getStatusIcon(file.status)}
                                    <span className="text-xs text-[var(--color-text)] truncate font-mono">
                                      {file.path}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs flex-shrink-0">
                                    <span className="text-[var(--color-success)]">+{file.additions}</span>
                                    <span className="text-[var(--color-error)]">-{file.deletions}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                            {/* Summary */}
                            <div className="px-3 py-2 text-xs text-[var(--color-text-muted)] border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                              {fileChanges.length} files changed,{" "}
                              <span className="text-[var(--color-success)]">
                                +{fileChanges.reduce((sum, f) => sum + f.additions, 0)}
                              </span>{" "}
                              <span className="text-[var(--color-error)]">
                                -{fileChanges.reduce((sum, f) => sum + f.deletions, 0)}
                              </span>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

    </div>
  );
}
