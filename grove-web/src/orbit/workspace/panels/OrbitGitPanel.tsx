import { useState, type ReactNode } from "react";
import { ArrowRight, GitCommit, GitCompare, RotateCw } from "lucide-react";
import type { Task } from "../../../data/types";
import type { DiffResponse } from "../../../api";
import { useTaskGit } from "../../../components/Tasks/TaskInfoPanel/tabs/useTaskGit";
import { EmptyState } from "../../ui/Surface";
import { Button } from "../../ui/Button";
import { PanelError, PanelHeaderContext, PanelLoading } from "../../ui/PanelShell";
import { useInPanelShell } from "../../ui/panelSlots";
import { plural, splitPath } from "./panelModel";
import { HeaderActions, PanelBody, PanelSection, ShowMore } from "./PanelStates";

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

/** Outside a panel shell the refresh button stays in the branch row. */
function InBodyRefresh({ children }: { children: ReactNode }) {
  return useInPanelShell() ? null : <span className="owp-gflow-end">{children}</span>;
}

/** Git panel body: branch → target, what changed against the target, and the branch's commits. */
export function OrbitGitPanel({ projectId, task }: { projectId?: string; task: Task }) {
  const { diffData, commitsData, isLoading, error, reload } = useTaskGit(projectId, task.id);
  const [allFiles, setAllFiles] = useState(false);
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
