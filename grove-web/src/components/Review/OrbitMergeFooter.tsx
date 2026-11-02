import { useEffect, useRef } from 'react';
import { GitCommit, GitMerge } from 'lucide-react';
import { Button } from '../../orbit/ui/Button';
import { useTaskGitStatus } from '../../orbit/workspace/panels/useTaskGitStatus';
import { useTaskGitActions, type TaskGitActions } from '../Tasks/TaskView/taskGitActions';
import { mergeReadiness } from './mergeReadiness';

interface OrbitMergeFooterProps {
  projectId: string;
  taskId: string;
  openComments: number;
  viewed: number;
  total: number;
  /** Changes when Review reloads, so the git status follows. */
  refreshSignal: unknown;
}

/**
 * Commit / merge readiness at the foot of the comments sidebar (Review board).
 * The buttons call the workspace's own Commit / Merge actions, which open the
 * existing dialogs; nothing here talks to git itself. Without a workspace
 * (standalone /review) there are no actions, so there is no footer.
 */
export function OrbitMergeFooter(props: OrbitMergeFooterProps) {
  const actions = useTaskGitActions();
  if (!actions || (!actions.onCommit && !actions.onMerge)) return null;
  return <MergeFooterBody {...props} actions={actions} />;
}

function MergeFooterBody({ projectId, taskId, openComments, viewed, total, refreshSignal, actions }: OrbitMergeFooterProps & { actions: TaskGitActions }) {
  const { status, reload } = useTaskGitStatus(projectId, taskId);
  const firstRef = useRef(true);
  useEffect(() => {
    // The hook loads on mount; follow Review's later reloads.
    if (firstRef.current) { firstRef.current = false; return; }
    void reload();
  }, [refreshSignal, reload]);

  const r = mergeReadiness({ openComments, viewed, total, status });
  const showCommit = !!actions.onCommit && r.uncommitted !== 0;
  const mergeBlocked = actions.mergeDisabled || openComments > 0;

  return (
    <div className={`orv-merge is-${r.tone}`}>
      <div className="orv-merge-copy">
        <b>{r.title}</b>
        <span>{r.detail}</span>
      </div>
      <div className="orv-merge-acts">
      {showCommit ? (
        <Button
          variant={r.uncommitted ? 'primary' : 'secondary'}
          size="sm"
          disabled={actions.commitDisabled}
          onClick={actions.onCommit}
          title="Commit the worktree’s changes"
        >
          <GitCommit aria-hidden="true" />Commit
        </Button>
      ) : null}
      {actions.onMerge ? (
        <Button
          variant={r.uncommitted ? 'secondary' : 'primary'}
          size="sm"
          disabled={mergeBlocked}
          onClick={actions.onMerge}
          title={actions.mergeDisabled
            ? 'This task can’t be merged from here'
            : openComments > 0 ? 'Resolve the open comments first' : 'Merge into the target branch'}
        >
          <GitMerge aria-hidden="true" />Merge
        </Button>
      ) : null}
      </div>
    </div>
  );
}
