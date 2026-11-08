import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eye } from 'lucide-react';
import { getDiffStats } from '../../api/review';
import { getCommits, getReviewComments, getTask, getTaskDirEntries, getTaskFiles } from '../../api/tasks';
import { OrbitInterfaceContext } from '../../orbit/ui/interfaceContext';
import { PanelShell } from '../../orbit/ui/PanelShell';
import { PANEL_HUES } from '../../orbit/ui/panelSlots';
import { DiffReviewPage } from './DiffReviewPage';
import { reviewHeaderDensity } from './reviewHeaderDensity';

vi.mock('../../api/review', () => ({ getDiffStats: vi.fn(), getSingleFileDiff: vi.fn() }));
vi.mock('../../api/tasks', () => ({
  getCommits: vi.fn(), getReviewComments: vi.fn(), getTask: vi.fn(), getTaskFiles: vi.fn(), getTaskDirEntries: vi.fn(),
}));
vi.mock('../../hooks', () => ({ useIsMobile: () => ({ isMobile: false }) }));
vi.mock('../../keyboard', () => ({
  useKeyboardScope: () => {}, useCommand: () => {}, useContextKey: () => {},
  commandRegistry: { listCommands: () => [{ id: 'diffReview.openSearch' }] },
  userKeymapStore: { subscribe: () => () => {}, getVersion: () => 0, getAllOverrides: () => new Map() },
  effectiveBindings: () => [{ key: 'Mod+f' }],
  formatKeyDisplay: () => '⌘F',
}));
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
    vi.mocked(getTaskDirEntries).mockResolvedValue({ entries: [] } as never);
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

  it('puts the whole toolbar in the one shell header row', async () => {
    await render(true);
    const actions = container.querySelector('.oui-panel-actions')!;
    const radios = [...actions.querySelectorAll('[role="radio"]')].map((r) => r.textContent);
    expect(radios).toEqual(['Changes', 'All files', 'Unified', 'Split']);
    expect(actions.querySelector('[aria-label="Refresh review"]')).not.toBeNull();
    expect(actions.querySelector('[aria-label="Next file"]')).not.toBeNull();
    expect(actions.querySelector('[aria-label="Show comments"]')).not.toBeNull();
    expect(container.querySelector('.diff-page-header')).toBeNull();
    expect(container.querySelector('.diff-review-page.is-orbit')).not.toBeNull();
    expect(container.querySelector('.orv-bar')).toBeNull();
    expect(container.querySelector('[data-tree]')?.textContent).toContain('0 of 1 reviewed');

    // View options live in the ⋯ menu.
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Panel actions"]')!.click());
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent);
    expect(items).toEqual(['Send comments to agent', 'Find in review⌘F', 'Hide file tree', 'Focus on one file']);
    // No open comments and no active chat: nothing to send.
    expect(document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Panel actions"]')!.click());

    // Switching scope still goes through Review's own state.
    await act(async () => (actions.querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]).click());
    expect(sessionStorage.getItem('grove:review-mode:project:task')).toBe('full');
  });

  it('folds Unified/Split, then prev/next and comments, as the panel narrows', () => {
    expect(reviewHeaderDensity(null)).toBe('wide');
    expect(reviewHeaderDensity(1100)).toBe('wide');
    expect(reviewHeaderDensity(800)).toBe('medium');
    expect(reviewHeaderDensity(720)).toBe('narrow');
    expect(reviewHeaderDensity(500)).toBe('compact');
  });

  it('keeps the legacy header outside Orbit', async () => {
    await render(false);
    expect(container.querySelector('.diff-page-header')).not.toBeNull();
    expect(container.querySelector('.is-orbit')).toBeNull();
    expect(container.querySelector('.orv-bar')).toBeNull();
  });
});
