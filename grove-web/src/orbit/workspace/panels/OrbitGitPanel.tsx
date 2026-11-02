import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, GitCommit, GitCompare, RotateCw } from "lucide-react";
import type { Task } from "../../../data/types";
import type { DiffResponse, TaskGitStatusResponse, UncommittedEntry } from "../../../api";
import { useTaskGit } from "../../../components/Tasks/TaskInfoPanel/tabs/useTaskGit";
import { EmptyState } from "../../ui/Surface";
import { Button } from "../../ui/Button";
import { PanelError, PanelHeaderContext, PanelLoading } from "../../ui/PanelShell";
import { useInPanelShell } from "../../ui/panelSlots";
import { plural, splitPath } from "./panelModel";
import { HeaderActions, PanelBody, PanelSection, ShowMore } from "./PanelStates";
import { useTaskGitStatus } from "./useTaskGitStatus";

const FILES_SHOWN = 10;

const STATUS_LABEL: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", U: "Untracked" };

function ChangedFile({ file }: { file: DiffResponse["files"][number] }) {
  const { dir, name } = splitPath(file.path);
  const status = file.status in STATUS_LABEL ? file.status : "M";
  return (
    <div className="owp-chg">
      <span className={`owp-st is-${status}`} title={STATUS_LABEL[status]} aria-label={STATUS_LABEL[status]}>{status === "U" ? "?" : status}</span>
      <span className="owp-path" title={file.path}>
        {dir ? <span>{dir}</span> : null}
        <b>{name}</b>
      </span>
      <span className="owp-delta">
        {file.additions ? <span className="owp-add">+{file.additions}</span> : null}
        {file.deletions ? <span className="owp-del">−{file.deletions}</span> : null}
      </span>
    </div>
  );
}

const UNCOMMITTED_SHOWN = 8;

/** Uncommitted status → the one-letter code and label the changed-file rows use. */
const UNCOMMITTED_CODE: Record<UncommittedEntry["status"], { code: string; cls: string; label: string }> = {
  modified: { code: "M", cls: "M", label: "Modified" },
  added: { code: "A", cls: "A", label: "Added" },
  deleted: { code: "D", cls: "D", label: "Deleted" },
  renamed: { code: "R", cls: "R", label: "Renamed" },
  copied: { code: "C", cls: "A", label: "Copied" },
  typechange: { code: "T", cls: "M", label: "Type changed" },
  untracked: { code: "?", cls: "U", label: "Untracked" },
  conflicted: { code: "!", cls: "X", label: "Conflicted" },
};

function UncommittedFile({ entry }: { entry: UncommittedEntry }) {
  const { dir, name } = splitPath(entry.path);
  const st = UNCOMMITTED_CODE[entry.status] ?? UNCOMMITTED_CODE.modified;
  const label = entry.status === "untracked" ? st.label : `${st.label}, ${entry.staged ? "staged" : "not staged"}`;
  return (
    <div className="owp-chg">
      <span className={`owp-st is-${st.cls}`} title={label} aria-label={label}>{st.code}</span>
      <span className="owp-path" title={entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path}>
        {dir ? <span>{dir}</span> : null}
        <b>{name}</b>
      </span>
      {entry.staged ? <span className="owp-stage" title="Staged in the index">staged</span> : null}
      <span className="owp-delta">
        {entry.additions ? <span className="owp-add">+{entry.additions}</span> : null}
        {entry.deletions ? <span className="owp-del">−{entry.deletions}</span> : null}
      </span>
    </div>
  );
}

function uncommittedHint(entries: UncommittedEntry[]): string {
  const staged = entries.filter((e) => e.staged).length;
  const untracked = entries.filter((e) => e.status === "untracked").length;
  const unstaged = entries.length - staged - untracked;
  return [
    staged ? `${staged} staged` : null,
    unstaged ? `${unstaged} unstaged` : null,
    untracked ? `${untracked} untracked` : null,
  ].filter(Boolean).join(" · ");
}

/** ↑ahead ↓behind against the base, from local refs. Hidden when unknown. */
function AheadBehind({ status, target }: { status: TaskGitStatusResponse | null; target: string }) {
  if (!status || status.ahead === null || status.behind === null) return null;
  const base = status.base ?? target;
  if (status.ahead === 0 && status.behind === 0) {
    return <span className="owp-ab is-even" title={`Even with ${base} (local refs)`}>up to date</span>;
  }
  return (
    <span className="owp-ab" title={`${plural(status.ahead, "commit")} ahead of, ${plural(status.behind, "commit")} behind ${base} (local refs, not fetched)`}>
      {status.ahead ? <span className="owp-ab-up"><ArrowUp aria-hidden="true" />{status.ahead}<span className="owp-sr"> ahead</span></span> : null}
      {status.behind ? <span className="owp-ab-down"><ArrowDown aria-hidden="true" />{status.behind}<span className="owp-sr"> behind</span></span> : null}
    </span>
  );
}

/** Outside a panel shell the refresh button stays in the branch row. */
function InBodyRefresh({ children }: { children: ReactNode }) {
  return useInPanelShell() ? null : <span className="owp-gflow-end">{children}</span>;
}

/** Git panel body: branch → target, what changed against the target, and the branch's commits. */
export function OrbitGitPanel({ projectId, task }: { projectId?: string; task: Task }) {
  const { diffData, commitsData, isLoading, error, reload: reloadGit } = useTaskGit(projectId, task.id);
  const { status: gitStatus, reload: reloadStatus } = useTaskGitStatus(projectId, task.id);
  const reload = async () => { await Promise.all([reloadGit(), reloadStatus()]); };
  const [allFiles, setAllFiles] = useState(false);
  const [allUncommitted, setAllUncommitted] = useState(false);
  const loaded = diffData !== null || commitsData !== null;
  const refresh = (
    <Button variant="ghost" size="sm" iconOnly onClick={() => void reload()} disabled={isLoading} aria-label="Refresh" title="Refresh">
      <RotateCw className={isLoading ? "oui-spin" : undefined} aria-hidden="true" />
    </Button>
  );

  if (isLoading && !loaded) {
    return (
      <PanelBody label="Git">
        <PanelLoading label="Loading git info" boxes={3} />
      </PanelBody>
    );
  }

  if (error) {
    return (
      <PanelBody label="Git">
        <PanelError title="Couldn’t read this task’s branch" onRetry={() => void reload()} retrying={isLoading}>
          Grove couldn’t diff <code className="owp-mono">{task.branch}</code> against <code className="owp-mono">{task.target}</code>. The task may have been archived or its worktree removed.
        </PanelError>
      </PanelBody>
    );
  }

  const files = diffData?.files ?? [];
  const additions = diffData?.total_additions ?? 0;
  const deletions = diffData?.total_deletions ?? 0;
  const commits = commitsData?.commits ?? [];
  const commitTotal = commitsData?.total ?? commits.length;
  const shownFiles = allFiles ? files : files.slice(0, FILES_SHOWN);
  const uncommitted = gitStatus?.uncommitted ?? [];
  const uncommittedTotal = gitStatus?.uncommitted_total ?? uncommitted.length;
  const shownUncommitted = allUncommitted ? uncommitted : uncommitted.slice(0, UNCOMMITTED_SHOWN);

  return (
    <PanelBody label="Git">
      <HeaderActions fallback={null}>{refresh}</HeaderActions>
      {additions || deletions ? (
        <PanelHeaderContext><span className="owp-tnum">+{additions} −{deletions}</span></PanelHeaderContext>
      ) : null}
      <div className="owp-scroll">
        <section className="owp-sec">
          <div className="owp-box owp-gstate">
            <div className="owp-gflow">
              <code title={task.branch}>{task.branch}</code>
              <ArrowRight aria-label="into" />
              <code title={task.target}>{task.target}</code>
              <AheadBehind status={gitStatus} target={task.target} />
              <InBodyRefresh>{refresh}</InBodyRefresh>
            </div>
            <div className="owp-chips">
              <span className="owp-chip"><b>{commitTotal}</b> {commitTotal === 1 ? "commit" : "commits"}</span>
              <span className="owp-chip"><b>{files.length}</b> {files.length === 1 ? "file" : "files"}</span>
              {additions || deletions ? (
                <span className="owp-chip owp-tnum"><span className="owp-add">+{additions}</span><span className="owp-del">−{deletions}</span></span>
              ) : null}
            </div>
          </div>
        </section>

        {uncommitted.length ? (
          <PanelSection label="Uncommitted" hint={uncommittedHint(uncommitted)} end={<span className="owp-tnum">{uncommittedTotal}</span>}>
            <div className="owp-box">
              {shownUncommitted.map((entry) => <UncommittedFile key={`${entry.staged ? "i" : "w"}:${entry.path}`} entry={entry} />)}
              <ShowMore shown={UNCOMMITTED_SHOWN} total={uncommitted.length} expanded={allUncommitted} onToggle={() => setAllUncommitted((value) => !value)} />
              {gitStatus?.uncommitted_truncated && allUncommitted ? (
                <p className="owp-trunc">Showing the first {uncommitted.length.toLocaleString()} of {uncommittedTotal.toLocaleString()}.</p>
              ) : null}
            </div>
          </PanelSection>
        ) : null}

        <PanelSection label="Changes" hint={`against ${task.target}`} end={files.length ? <span className="owp-tnum">{files.length}</span> : undefined}>
          <div className="owp-box">
            {files.length === 0 ? (
              <EmptyState icon={GitCompare}>No changes against {task.target} yet.</EmptyState>
            ) : (
              <>
                {shownFiles.map((file) => <ChangedFile key={file.path} file={file} />)}
                <ShowMore shown={FILES_SHOWN} total={files.length} expanded={allFiles} onToggle={() => setAllFiles((value) => !value)} />
              </>
            )}
          </div>
        </PanelSection>

        <PanelSection
          label="Commits on this branch"
          hint={commitsData?.truncated ? `latest ${commits.length} of ${commitTotal}` : undefined}
          end={commitTotal ? <span className="owp-tnum">{commitTotal}</span> : undefined}
        >
          <div className="owp-box">
            {commits.length === 0 ? (
              <EmptyState icon={GitCommit}>{files.length ? `No commits yet. ${plural(files.length, "changed file")} not committed.` : "No commits yet."}</EmptyState>
            ) : (
              <div className="owp-commits">
                {commits.map((commit, index) => (
                  <div key={commit.hash || index} className="owp-commit">
                    <span className="owp-node" aria-hidden="true"><i /></span>
                    <span className="owp-cmsg">
                      <p title={commit.message}>{commit.message}</p>
                      {commit.hash ? <code>{commit.hash.slice(0, 7)}</code> : null}
                    </span>
                    <span className="owp-ctime">{commit.time_ago}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PanelSection>
      </div>
    </PanelBody>
  );
}
