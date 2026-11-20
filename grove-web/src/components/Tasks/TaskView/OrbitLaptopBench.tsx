import { useEffect, useState, type ElementType } from "react";
import { Check, Circle, FileDiff, GitBranch, GitCommitHorizontal, ListChecks, ShieldCheck } from "lucide-react";
import { getCommits } from "../../../api";
import { useTaskGitStatus } from "../../../orbit/workspace/panels/useTaskGitStatus";
import type { LaptopBench } from "../IDELayout/LaptopBenchContext";
import type { PlanEntry } from "./planEntries";
import { SubagentAvatar } from "./SubagentAvatar";
import "./orbit-laptop-bench.css";

const STATUS_MARK: Record<string, string> = { modified: "M", added: "A", deleted: "D", renamed: "R", copied: "C", typechange: "T", untracked: "U", conflicted: "!" };

interface OrbitLaptopBenchProps {
  bench: LaptopBench;
  planEntries: readonly PlanEntry[];
  running: boolean;
  connected: boolean;
  agentLabel: string;
  AgentIcon: ElementType | null;
  /** 0–100, or null when the agent doesn't report it. */
  contextPercent: number | null;
  modeLabel: string | null;
  subagents: readonly { sessionId: string; status: string }[];
  /** A request waiting on the user (permission, question, sign-in). */
  askLabel: string | null;
  onOpenPlan: () => void;
  onOpenSubagents: () => void;
  onOpenAsk: () => void;
}

/**
 * The workbench on a laptop fold's lower screen while no panel is open:
 * the todo, the branch and the agent, each with the actions that belong to it.
 */
export function OrbitLaptopBench({ bench, planEntries, running, connected, agentLabel, AgentIcon, contextPercent, modeLabel, subagents, askLabel, onOpenPlan, onOpenSubagents, onOpenAsk }: OrbitLaptopBenchProps) {
  const { status: git } = useTaskGitStatus(bench.projectId, bench.taskId);
  const [commits, setCommits] = useState<{ hash: string; message: string; time_ago: string }[] | null>(null);
  const done = planEntries.filter((entry) => entry.status === "completed").length;

  useEffect(() => {
    let live = true;
    getCommits(bench.projectId, bench.taskId)
      .then((data) => { if (live) setCommits(data.commits.slice(0, 5)); })
      .catch(() => { if (live) setCommits([]); });
    return () => { live = false; };
  }, [bench.projectId, bench.taskId]);

  const changed = git?.uncommitted_total ?? 0;
  const lines = (git?.uncommitted ?? []).reduce((sum, entry) => ({ additions: sum.additions + (entry.additions ?? 0), deletions: sum.deletions + (entry.deletions ?? 0) }), { additions: 0, deletions: 0 });
  const agentState = askLabel ? "Needs you" : running ? "Working" : connected ? "Idle" : "Offline";

  return (
    <div className="olb">
      {planEntries.length > 0 ? (
        <button type="button" className="olb-card olb-todo" onClick={onOpenPlan}>
          <span className="olb-head"><ListChecks size={14} />Todo<b>{done}/{planEntries.length}</b></span>
          <span className="olb-bar"><i style={{ width: `${(done / planEntries.length) * 100}%` }} /></span>
          <span className="olb-list">
            {planEntries.map((entry, index) => (
              <span key={index} className={`olb-step is-${entry.status}`}>
                {entry.status === "completed" ? <Check size={14} /> : entry.status === "in_progress" ? <i className="olb-live" /> : <Circle size={13} />}
                <span>{entry.content}</span>
              </span>
            ))}
          </span>
        </button>
      ) : changed > 0 && git ? (
        <div className="olb-card olb-todo">
          <span className="olb-head"><FileDiff size={14} />Changes<b>{changed}</b></span>
          <span className="olb-list">
            {git.uncommitted.map((entry) => {
              const slash = entry.path.lastIndexOf("/");
              return (
                <span key={entry.path} className={`olb-file is-${entry.status}`}>
                  <i>{STATUS_MARK[entry.status] ?? "M"}</i>
                  <span><b>{entry.path.slice(slash + 1)}</b>{slash > 0 && <small>{entry.path.slice(0, slash)}</small>}</span>
                  {(entry.additions != null || entry.deletions != null) && <em><ins>+{entry.additions ?? 0}</ins> <del>−{entry.deletions ?? 0}</del></em>}
                </span>
              );
            })}
          </span>
        </div>
      ) : (
        <div className="olb-card olb-todo">
          <span className="olb-head"><GitCommitHorizontal size={14} />Commits{commits && commits.length > 0 && <b>{commits.length}</b>}</span>
          <span className="olb-list">
            {(commits ?? []).map((commit) => (
              <span key={commit.hash} className="olb-commit">
                <code>{commit.hash.slice(0, 7)}</code>
                <span>{commit.message}</span>
                <small>{commit.time_ago}</small>
              </span>
            ))}
          </span>
        </div>
      )}

      <div className="olb-card olb-git">
        <span className="olb-head"><GitBranch size={14} /><span className="olb-branch">{bench.branch}</span><b className={changed ? "is-dirty" : "is-clean"}>{changed ? `${changed} changed` : "Clean"}</b></span>
        {changed > 0 && <span className="olb-row"><span>Uncommitted</span><b><ins>+{lines.additions}</ins> <del>−{lines.deletions}</del></b></span>}
        {!!git?.ahead && <span className="olb-row"><span>Ahead of {git.base ?? "target"}</span><b>{git.ahead}</b></span>}
        {!!git?.behind && <span className="olb-row"><span>Behind {git.base ?? "target"}</span><b>{git.behind}</b></span>}
        {bench.actions.length > 0 && (
          <span className="olb-actions">
            {bench.actions.map(({ id, label, icon: Icon, onClick, variant, disabled }) => (
              <button key={id} type="button" disabled={disabled} className={`olb-action${variant && variant !== "default" ? ` is-${variant}` : ""}`} onClick={onClick}>
                <Icon size={14} />{label}
              </button>
            ))}
          </span>
        )}
      </div>

      <div className={`olb-card olb-agent${askLabel ? " is-ask" : ""}`}>
        <span className="olb-head">{AgentIcon && <AgentIcon size={14} />}{agentLabel}<b><i className={`olb-dot is-${askLabel ? "ask" : running ? "running" : connected ? "idle" : "off"}`} />{agentState}</b></span>
        {askLabel ? (
          <button type="button" className="olb-ask" onClick={onOpenAsk}><ShieldCheck size={15} />{askLabel}</button>
        ) : (
          <>
            {contextPercent != null && (
              <>
                <span className="olb-row"><span>Context</span><b>{contextPercent}%</b></span>
                <span className="olb-bar is-accent"><i style={{ width: `${contextPercent}%` }} /></span>
              </>
            )}
            {modeLabel && <span className="olb-row"><span>Mode</span><b>{modeLabel}</b></span>}
          </>
        )}
        {subagents.length > 0 && (
          <button type="button" className="olb-subagents" onClick={onOpenSubagents}>
            <span>Subagents</span>
            <span className="olb-stack">{subagents.slice(0, 5).map((agent) => <SubagentAvatar key={agent.sessionId} sessionId={agent.sessionId} size={20} />)}</span>
          </button>
        )}
      </div>
    </div>
  );
}
