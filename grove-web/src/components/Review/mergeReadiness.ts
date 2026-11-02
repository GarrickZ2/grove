import type { TaskGitStatusResponse } from '../../api';

export interface MergeReadiness {
  /** `blocked`: open comments; `pending`: uncommitted changes; `ready`; `idle`: nothing to merge; `unknown`: no git status. */
  tone: 'blocked' | 'pending' | 'ready' | 'idle' | 'unknown';
  title: string;
  detail: string;
  /** Uncommitted file count; null when the git status isn't available. */
  uncommitted: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the Review footer says about commit / merge, from real state only. */
export function mergeReadiness({ openComments, viewed, total, status }: {
  openComments: number;
  viewed: number;
  total: number;
  status: TaskGitStatusResponse | null;
}): MergeReadiness {
  const uncommitted = status ? status.uncommitted_total : null;
  const parts = [`${viewed} of ${plural(total, 'file')} reviewed`];
  if (status && status.ahead !== null && status.behind !== null) {
    const base = status.base ? ` ${status.base}` : '';
    parts.push(status.behind > 0 ? `${status.ahead} ahead, ${status.behind} behind${base}` : `${status.ahead} ahead of${base || ' target'}`);
  }
  const detail = parts.join(' · ');

  if (openComments > 0) return { tone: 'blocked', title: `${plural(openComments, 'comment')} unresolved`, detail, uncommitted };
  // Without git status we can't claim it's ready; say only what we know.
  if (!status) return { tone: 'unknown', title: 'No open comments', detail, uncommitted };
  if (uncommitted) return { tone: 'pending', title: `${plural(uncommitted, 'uncommitted change')}`, detail, uncommitted };
  if (status.ahead === 0) return { tone: 'idle', title: 'Nothing to merge yet', detail, uncommitted };
  return { tone: 'ready', title: 'Ready to merge', detail, uncommitted };
}
