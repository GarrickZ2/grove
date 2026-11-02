import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eye } from 'lucide-react';
import { getDiffStats } from '../../api/review';
import { getCommits, getReviewComments, getTask, getTaskFiles } from '../../api/tasks';
import { OrbitInterfaceContext } from '../../orbit/ui/interfaceContext';
import { PanelShell } from '../../orbit/ui/PanelShell';
import { PANEL_HUES } from '../../orbit/ui/panelSlots';
import { DiffReviewPage } from './DiffReviewPage';

vi.mock('../../api/review', () => ({ getDiffStats: vi.fn(), getSingleFileDiff: vi.fn() }));
vi.mock('../../api/tasks', () => ({
  getCommits: vi.fn(), getReviewComments: vi.fn(), getTask: vi.fn(), getTaskFiles: vi.fn(),
}));
vi.mock('../../hooks', () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock('../../keyboard', () => ({ useKeyboardScope: () => {}, useCommand: () => {}, useContextKey: () => {} }));
vi.mock('./FileTreeSidebar', () => ({ FileTreeSidebar: ({ summary }: { summary?: React.ReactNode }) => <div data-tree>{summary}</div> }));
vi.mock('./DiffFileView', () => ({ DiffFileView: () => null, resetGlobalMatchIndex: () => {} }));
vi.mock('./ConversationSidebar', () => ({ ConversationSidebar: () => null }));
vi.mock('./CodeSearchBar', () => ({ CodeSearchBar: () => null }));
vi.mock('./VersionSelector', () => ({ VersionSelector: () => <span data-version /> }));
vi.mock('./previewRenderers', () => ({ getPreviewRenderer: () => null }));

describe('Review in an Orbit panel', () => {
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
    vi.mocked(getDiffStats).mockResolvedValue({
      files: [{ path: 'src/a.ts', old_path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, is_binary: false }],
      total_additions: 3, total_deletions: 1,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(orbit: boolean) {
    await act(async () => root.render(
      <OrbitInterfaceContext.Provider value={orbit}>
        <PanelShell glyph={Eye} hue={PANEL_HUES.violet} title="Code Review" body="fill">
          <DiffReviewPage projectId="project" taskId="task" embedded />
        </PanelShell>
      </OrbitInterfaceContext.Provider>,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  }

  it('moves the scope switch and refresh into the shell header', async () => {
    await render(true);
    const actions = container.querySelector('.oui-panel-actions')!;
    const radios = [...actions.querySelectorAll('[role="radio"]')].map((r) => r.textContent);
    expect(radios).toEqual(['Changes', 'All files']);
    expect(actions.querySelector('[aria-label="Refresh review"]')).not.toBeNull();
    expect(container.querySelector('.diff-page-header')).toBeNull();
    expect(container.querySelector('.diff-review-page.is-orbit')).not.toBeNull();
    expect(container.querySelector('.orv-bar')).not.toBeNull();
    expect(container.querySelector('[data-tree]')?.textContent).toContain('0 of 1 reviewed');

    // View options live in the ⋯ menu.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Panel actions"]')!.click());
    const items = [...container.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual(expect.arrayContaining(['Find in review', 'Hide file tree', 'Show comments', 'Show code']));

    // Switching scope still goes through Review's own state.
    await act(async () => (actions.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]).click());
    expect(sessionStorage.getItem('grove:review-mode:project:task')).toBe('full');
  });

  it('keeps the legacy header outside Orbit', async () => {
    await render(false);
    expect(container.querySelector('.diff-page-header')).not.toBeNull();
    expect(container.querySelector('.is-orbit')).toBeNull();
    expect(container.querySelector('.orv-bar')).toBeNull();
  });
});
