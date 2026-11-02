import { describe, expect, it } from 'vitest';
import { mergeReadiness } from './mergeReadiness';

const status = (over = {}) => ({ is_git: true, base: 'master', ahead: 3, behind: 0, uncommitted: [], uncommitted_truncated: false, uncommitted_total: 0, ...over });

describe('mergeReadiness', () => {
  it('blocks on open comments first', () => {
    const r = mergeReadiness({ openComments: 2, viewed: 1, total: 4, status: status({ uncommitted_total: 5 }) });
    expect(r).toMatchObject({ tone: 'blocked', title: '2 comments unresolved', uncommitted: 5 });
    expect(r.detail).toBe('1 of 4 files reviewed · 3 ahead of master');
  });

  it('asks to commit uncommitted changes, then reports ready or nothing to merge', () => {
    expect(mergeReadiness({ openComments: 0, viewed: 0, total: 1, status: status({ uncommitted_total: 1 }) }).title).toBe('1 uncommitted change');
    expect(mergeReadiness({ openComments: 0, viewed: 1, total: 1, status: status({ behind: 2 }) })).toMatchObject({
      tone: 'ready', detail: '1 of 1 file reviewed · 3 ahead, 2 behind master',
    });
    expect(mergeReadiness({ openComments: 0, viewed: 0, total: 0, status: status({ ahead: 0 }) }).tone).toBe('idle');
  });

  it('degrades without the git status endpoint', () => {
    const r = mergeReadiness({ openComments: 0, viewed: 2, total: 3, status: null });
    expect(r).toMatchObject({ tone: 'unknown', title: 'No open comments', uncommitted: null, detail: '2 of 3 files reviewed' });
  });
});
