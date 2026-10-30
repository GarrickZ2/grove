import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDiffStats, getSingleFileDiff } from '../../api/review';
import { getCommits, getReviewComments, getTask, getTaskFiles } from '../../api/tasks';
import { DiffReviewPage } from './DiffReviewPage';

vi.mock('../../api/review', () => ({ getDiffStats: vi.fn(), getSingleFileDiff: vi.fn() }));
vi.mock('../../api/tasks', () => ({
  getCommits: vi.fn(), getReviewComments: vi.fn(), getTask: vi.fn(), getTaskFiles: vi.fn(),
}));
vi.mock('../../hooks', () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock('../../keyboard', () => ({ useKeyboardScope: () => {}, useCommand: () => {}, useContextKey: () => {} }));
vi.mock('./FileTreeSidebar', () => ({ FileTreeSidebar: () => null }));
vi.mock('./DiffFileView', () => ({ DiffFileView: () => null, resetGlobalMatchIndex: () => {} }));
vi.mock('./ConversationSidebar', () => ({ ConversationSidebar: () => null }));
vi.mock('./CodeSearchBar', () => ({ CodeSearchBar: () => null }));
vi.mock('./VersionSelector', () => ({ VersionSelector: () => null }));
vi.mock('./previewRenderers', () => ({ getPreviewRenderer: () => null }));

describe('Review diff failures', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    for (const key of ['localStorage', 'sessionStorage']) {
      const values = new Map<string, string>();
      vi.stubGlobal(key, {
        getItem: (name: string) => values.get(name) ?? null,
        setItem: (name: string, value: string) => values.set(name, value),
        removeItem: (name: string) => values.delete(name),
      });
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getTask).mockRejectedValue(new Error('No task metadata needed'));
    vi.mocked(getCommits).mockResolvedValue({ commits: [], total: 0, skip_versions: 0 });
    vi.mocked(getReviewComments).mockResolvedValue({ comments: [], open_count: 0, resolved_count: 0, outdated_count: 0 });
    vi.mocked(getTaskFiles).mockResolvedValue({ files: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<DiffReviewPage projectId="project" taskId="task" />));
  }

  it('loads rename results without repeatedly reloading the review', async () => {
    let requests = 0;
    vi.mocked(getDiffStats).mockImplementation(async () => {
      requests += 1;
      if (requests > 5) throw new Error('Repeated review reload');
      return {
        files: [{ path: 'README123.md', old_path: 'README.md', status: 'R', additions: 0, deletions: 0, is_binary: false }],
        total_additions: 0, total_deletions: 0,
      };
    });
    vi.mocked(getSingleFileDiff).mockResolvedValue({
      old_path: 'README.md', new_path: 'README123.md', change_type: 'renamed',
      hunks: [], is_binary: false, additions: 0, deletions: 0,
    });

    await render();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(requests).toBeLessThanOrEqual(2);
    expect(vi.mocked(getCommits).mock.calls.length).toBeLessThanOrEqual(2);
    expect(getSingleFileDiff).toHaveBeenCalledWith('project', 'task', 'README123.md', undefined, undefined, 'README.md');
    expect(container.textContent).not.toContain('Repeated review reload');
    expect(container.textContent).not.toContain('Loading...');
  });

  it('shows the API error message and recovers when Retry succeeds', async () => {
    const message = "Failed to load diff: git diff failed: unknown revision 'main'";
    vi.mocked(getDiffStats).mockRejectedValue({ status: 500, message });
    await render();
    expect(container.textContent).toContain(message);
    expect(container.textContent).not.toContain('No changes found');

    vi.mocked(getDiffStats).mockResolvedValue({ files: [], total_additions: 0, total_deletions: 0 });
    const retry = container.querySelector<HTMLButtonElement>('button');
    expect(retry?.textContent).toBe('Retry');
    await act(async () => retry!.click());
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).toContain('No changes found');
  });

  it('keeps the latest failure visible after an unsuccessful Retry', async () => {
    vi.mocked(getDiffStats).mockRejectedValue({ status: 500, message: 'Initial Git failure' });
    await render();
    vi.mocked(getDiffStats).mockRejectedValue({ status: 500, message: 'Latest Git failure' });
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.textContent).toContain('Latest Git failure');
    expect(container.textContent).not.toContain('No changes found');
    expect(container.querySelector<HTMLButtonElement>('button')?.disabled).toBe(false);
  });
});
