import { motion } from "framer-motion";
import { GitBranch, GitCommit, FileCode, AlertCircle } from "lucide-react";
import type { Task } from "../../../../data/types";
import { getCommitFileChanges } from "../../../../data/mockData";

interface GitTabProps {
  task: Task;
}

function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function GitTab({ task }: GitTabProps) {
  // Mock data for commits behind
  const commitsBehind = 2;

  return (
    <div className="space-y-4">
      {/* Branch Info */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h3 className="text-sm font-medium text-[var(--color-text)] mb-3 flex items-center gap-2">
          <GitBranch className="w-4 h-4" />
          Branch Info
        </h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Branch</span>
            <span className="text-[var(--color-text)] font-mono">{task.branch}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-text-muted)]">Target</span>
            <span className="text-[var(--color-text)] font-mono">{task.target}</span>
          </div>
          {commitsBehind > 0 && (
            <div className="flex justify-between items-center">
              <span className="text-[var(--color-text-muted)]">Status</span>
              <span className="flex items-center gap-1.5 text-[var(--color-warning)]">
                <AlertCircle className="w-3.5 h-3.5" />
                {commitsBehind} commits behind
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Code Changes */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h3 className="text-sm font-medium text-[var(--color-text)] mb-3 flex items-center gap-2">
          <FileCode className="w-4 h-4" />
          Changes
        </h3>
        <div className="flex gap-4 text-sm">
          <div>
            <span className="text-[var(--color-success)] font-semibold">+{task.additions}</span>
            <span className="text-[var(--color-text-muted)] ml-1">additions</span>
          </div>
          <div>
            <span className="text-[var(--color-error)] font-semibold">-{task.deletions}</span>
            <span className="text-[var(--color-text-muted)] ml-1">deletions</span>
          </div>
          <div>
            <span className="text-[var(--color-text)] font-semibold">{task.filesChanged}</span>
            <span className="text-[var(--color-text-muted)] ml-1">files</span>
          </div>
        </div>
      </div>

      {/* Recent Commits */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h3 className="text-sm font-medium text-[var(--color-text)] mb-3 flex items-center gap-2">
          <GitCommit className="w-4 h-4" />
          Recent Commits
        </h3>
        {task.commits.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No commits yet</p>
        ) : (
          <div className="space-y-2">
            {task.commits.map((commit, index) => {
              const fileChanges = getCommitFileChanges(commit.hash);
              return (
                <motion.div
                  key={commit.hash}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="group"
                >
                  <div className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-[var(--color-bg-secondary)] transition-colors">
                    <code className="text-xs text-[var(--color-highlight)] font-mono bg-[var(--color-highlight)]/10 px-1.5 py-0.5 rounded">
                      {commit.hash.slice(0, 7)}
                    </code>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[var(--color-text)] truncate">
                        {commit.message}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--color-text-muted)]">
                        <span>{formatTimeAgo(commit.date)}</span>
                        {fileChanges.length > 0 && (
                          <>
                            <span>•</span>
                            <span>{fileChanges.length} files</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
