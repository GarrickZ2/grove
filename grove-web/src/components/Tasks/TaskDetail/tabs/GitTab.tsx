import { useState, useEffect, useCallback } from "react";
import { motion } from "framer-motion";
import { GitBranch, GitCommit, FileCode, Loader2 } from "lucide-react";
import type { Task } from "../../../../data/types";
import { useProject } from "../../../../context/ProjectContext";
import { getDiff, getCommits, type DiffResponse, type CommitsResponse } from "../../../../api";

interface GitTabProps {
  task: Task;
}

export function GitTab({ task }: GitTabProps) {
  const { selectedProject } = useProject();
  const [diffData, setDiffData] = useState<DiffResponse | null>(null);
  const [commitsData, setCommitsData] = useState<CommitsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadGitData = useCallback(async () => {
    if (!selectedProject) return;

    try {
      setIsLoading(true);
      setError(null);
      const [diff, commits] = await Promise.all([
        getDiff(selectedProject.id, task.id),
        getCommits(selectedProject.id, task.id),
      ]);
      setDiffData(diff);
      setCommitsData(commits);
    } catch (err) {
      console.error("Failed to load git data:", err);
      setError("Failed to load git data. The task may have been deleted or archived.");
    } finally {
      setIsLoading(false);
    }
  }, [selectedProject, task.id]);

  useEffect(() => {
    loadGitData();
  }, [loadGitData]);

  if (isLoading) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] mb-3 animate-spin" />
        <p className="text-[var(--color-text-muted)]">Loading git info...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-4">
        <p className="text-[var(--color-error)] mb-2">{error}</p>
        <p className="text-sm text-[var(--color-text-muted)]">
          Please refresh the page or select another task.
        </p>
      </div>
    );
  }

  const additions = diffData?.total_additions ?? task.additions;
  const deletions = diffData?.total_deletions ?? task.deletions;
  const filesChanged = diffData?.files.length ?? task.filesChanged;
  const commits = commitsData?.commits ?? [];

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
            <span className="text-[var(--color-success)] font-semibold">+{additions}</span>
            <span className="text-[var(--color-text-muted)] ml-1">additions</span>
          </div>
          <div>
            <span className="text-[var(--color-error)] font-semibold">-{deletions}</span>
            <span className="text-[var(--color-text-muted)] ml-1">deletions</span>
          </div>
          <div>
            <span className="text-[var(--color-text)] font-semibold">{filesChanged}</span>
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
        {commits.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)]">No commits yet</p>
        ) : (
          <div className="space-y-2">
            {commits.map((commit, index) => (
              <motion.div
                key={commit.hash || index}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.05 }}
                className="group"
              >
                <div className="flex items-start gap-3 py-2 px-2 rounded-md hover:bg-[var(--color-bg-secondary)] transition-colors">
                  {commit.hash && (
                    <code className="text-xs text-[var(--color-highlight)] font-mono bg-[var(--color-highlight)]/10 px-1.5 py-0.5 rounded">
                      {commit.hash.slice(0, 7)}
                    </code>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--color-text)] truncate">
                      {commit.message}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--color-text-muted)]">
                      <span>{commit.time_ago}</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
