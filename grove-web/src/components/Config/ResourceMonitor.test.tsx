import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceMonitor } from './ResourceMonitor';
import { getResourceProcesses, getResourceStorage, getStorageChildren, refreshResourceStorage, type ProcessNode, type StorageNode, type StorageStatus } from '../../api/resourceMonitor';

vi.mock('../../api/resourceMonitor', () => ({ getResourceProcesses: vi.fn(), getResourceStorage: vi.fn(), getStorageChildren: vi.fn(), refreshResourceStorage: vi.fn() }));
vi.mock('../../context', () => ({ useTheme: () => ({ theme: { accentPalette: ['#3370ff', '#33aa88'] } }) }));

const node = (id: number, name: string, kind: string, detail: string, bytes: number, childCount = 0): StorageNode => ({ id, name, kind, detail, bytes, files: 1, child_count: childCount, shared: false, unreadable: false });
const project = node(1, 'Example project', 'project', 'p', 800, 1);
const shared = node(2, 'Shared & other', 'shared', 'Shared files', 200, 1);
const task = node(3, 'Example task', 'task', 'p/t', 800, 1);
const workspace = node(4, 'Worktree', 'directory', 'worktrees/p/t', 800, 1);
const snapshot = (scan = 'first'): StorageStatus => ({ scanning: false, error: null, scan_id: scan, scanned_at: '2026-10-18T00:00:00Z', root: node(0, 'Grove storage', 'root', '~/.grove', 1000, 2), groups: [project, shared], read_errors: 0, size_basis: 'allocated' });

describe('Resource Monitor', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(getResourceProcesses).mockResolvedValue({ sampled_at: '2026-10-18T00:00:00Z', logical_cpus: 8, memory_basis: 'physical_footprint' as const, cpu_percent: 12.5, memory_unavailable_count: 0, memory_bytes: 1024 ** 3, process_count: 2, groups: [{ id: 'project:p', name: 'Example project', kind: 'project', detail: '', cpu_percent: 12.5, memory_unavailable_count: 0, memory_bytes: 1024 ** 3, children: [{ id: 'task:p:t', name: 'Example task', kind: 'task', detail: '', cpu_percent: 12.5, memory_unavailable_count: 0, memory_bytes: 1024 ** 3, children: [] }] }] });
    vi.mocked(getResourceStorage).mockResolvedValue(snapshot());
    vi.mocked(refreshResourceStorage).mockResolvedValue({ ...snapshot(), scanning: true });
    vi.mocked(getStorageChildren).mockImplementation(async (_scan, id) => {
      const nodes = id === 0 ? [project, shared] : id === 1 ? [task] : id === 3 ? [workspace] : [];
      return { nodes, total: nodes.length };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render() { await act(async () => root.render(<ResourceMonitor />)); }
  function button(label: string) {
    const found = [...container.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === label || button.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
  }
  async function click(label: string) { await act(async () => button(label).click()); }

  it('labels macOS footprint and explains why it is not installed RAM usage', async () => {
    const sample = await vi.mocked(getResourceProcesses)();
    vi.mocked(getResourceProcesses).mockResolvedValue({ ...sample, memory_bytes: 40 * 1024 ** 3 });
    await render();
    const card = [...container.querySelectorAll('button[aria-pressed]')].find(button => button.textContent?.startsWith('Memory footprint'))!;
    expect(card.textContent).toContain('40 GiB');
    expect(card.textContent).toContain('includes compressed / swapped');
    await act(async () => (card as HTMLButtonElement).click());
    expect(container.textContent).toContain('not current physical RAM usage');
    expect(container.textContent).toContain('may exceed installed RAM');
    expect(container.textContent).not.toContain('Resident memory');
  });

  it('labels RSS explicitly on other platforms', async () => {
    const sample = await vi.mocked(getResourceProcesses)();
    vi.mocked(getResourceProcesses).mockResolvedValue({ ...sample, memory_basis: 'rss_sum' });
    await render();
    const card = [...container.querySelectorAll('button[aria-pressed]')].find(button => button.textContent?.startsWith('Memory (RSS sum)'))!;
    expect(card.textContent).toContain('Shared pages may be counted repeatedly');
    await act(async () => (card as HTMLButtonElement).click());
    expect(container.textContent).toContain('not host RAM usage');
  });

  it('marks incomplete footprint totals and unavailable rows instead of displaying zero', async () => {
    const sample = await vi.mocked(getResourceProcesses)();
    const missing: ProcessNode = { id: 'missing', name: 'Unreadable agent', kind: 'process', detail: 'PID 999', cpu_percent: 0, memory_bytes: 0, memory_unavailable_count: 1, children: [] };
    vi.mocked(getResourceProcesses).mockResolvedValue({ ...sample, memory_unavailable_count: 1, groups: [...sample.groups, missing] });
    await render();
    const card = [...container.querySelectorAll('button[aria-pressed]')].find(button => button.textContent?.startsWith('Memory footprint'))!;
    expect(card.textContent).toContain('1 GiB (partial)');
    await act(async () => (card as HTMLButtonElement).click());
    expect(container.textContent).toContain('Memory unavailable for 1 process;');
    expect(button('Expand Unreadable agent').parentElement?.textContent).toContain('Unavailable');
    vi.mocked(getResourceProcesses).mockResolvedValue({ ...sample, memory_bytes: 0, memory_unavailable_count: 1, groups: [missing] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(card.textContent).toContain('Unavailable');
    expect(card.textContent).not.toContain('0 B');
    expect(button('Expand Unreadable agent').parentElement?.textContent).toContain('Share unavailable');
  });

  it('updates every ten seconds without reordering rows or chart segments until explicitly sorted', async () => {
    const agent = (id: string, value: number): ProcessNode => ({ id, name: 'Codex', kind: 'process', detail: `Session ${id} · PID ${id}`, cpu_percent: value, memory_unavailable_count: 0, memory_bytes: value * 1024, children: [] });
    const sample = (a: number, b: number, shared: number) => ({ sampled_at: `${a}-${b}`, logical_cpus: 8, memory_basis: 'physical_footprint' as const, cpu_percent: a + b + shared, memory_unavailable_count: 0, memory_bytes: (a + b + shared) * 1024, process_count: 3, groups: [
      { id: 'project:p', name: 'Project', kind: 'project' as const, detail: '', cpu_percent: a + b, memory_unavailable_count: 0, memory_bytes: (a + b) * 1024, children: [
        { id: 'task:t', name: 'Task', kind: 'task' as const, detail: '', cpu_percent: a + b, memory_unavailable_count: 0, memory_bytes: (a + b) * 1024, children: [agent('a', a), agent('b', b)] },
      ] },
      { id: 'shared', name: 'Grove runtime', kind: 'shared' as const, detail: '', cpu_percent: shared, memory_unavailable_count: 0, memory_bytes: shared * 1024, children: [] },
    ] });
    vi.mocked(getResourceProcesses).mockResolvedValue(sample(9, 1, 1));
    await render();
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.textContent?.startsWith('Memory'))!.click());
    await click('Expand Project');
    await click('Expand Task');
    const agentDetails = () => [...container.querySelectorAll('button[aria-label="Expand Codex"]')].map(row => row.textContent);
    const arcs = () => [...container.querySelectorAll('circle[role="button"]')].map(circle => circle.getAttribute('aria-label'));
    expect(agentDetails()[0]).toContain('Session a');
    const initialArcs = arcs();
    vi.mocked(getResourceProcesses).mockResolvedValue(sample(1, 9, 20));
    await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
    expect(getResourceProcesses).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getResourceProcesses).toHaveBeenCalledTimes(2);
    expect(agentDetails()[0]).toContain('Session a');
    expect(arcs()).toEqual(initialArcs);
    const firstAgentRow = container.querySelector('button[aria-label="Expand Codex"]')!.parentElement!;
    expect(firstAgentRow.textContent).toContain('1 KiB');
    expect(button('Collapse Task')).toBeDefined();
    await click('Sort by usage');
    expect(agentDetails()[0]).toContain('Session b');
    expect(arcs()[0]).toBe('Select Grove runtime');
    expect(container.textContent).toContain('updates every 10s');
  });

  it('shows a database as one item with a database icon and drills into its files', async () => {
    const database = node(10, 'Code Index', 'database', 'projects/p/index.db', 800, 3);
    const files = [node(11, 'index.db', 'file', 'projects/p/index.db', 500), node(12, 'index.db-wal', 'file', 'projects/p/index.db-wal', 280), node(13, 'index.db-shm', 'file', 'projects/p/index.db-shm', 20)];
    vi.mocked(getStorageChildren).mockImplementation(async (_scan, id) => {
      const nodes = id === 0 ? [project, shared] : id === 1 ? [database] : id === 10 ? files : [];
      return { nodes, total: nodes.length };
    });
    await render();
    await click('Explore Example project');
    expect(button('Expand Code Index').querySelector('.lucide-database')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand index.db-wal"]')).toBeNull();
    await click('Explore Code Index');
    expect(container.querySelector('svg[aria-label="storage distribution for Code Index"]')).not.toBeNull();
    for (const file of files) expect(button(`Expand ${file.name}`)).toBeDefined();
    await click('Back to parent');
    expect(button('Expand Code Index')).toBeDefined();
  });

  it('shows a hover card with usage and the current scope share, including after drilldown', async () => {
    await render();
    const arc = container.querySelector('circle[aria-label="Select Example project"]')!;
    await act(async () => arc.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 100, clientY: 200 })));
    let tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain('Example project');
    expect(tooltip.textContent).toContain('800 B');
    expect(tooltip.textContent).toContain('Share of Grove total');
    expect(tooltip.textContent).toContain('80.0%');
    expect(arc.getAttribute('aria-describedby')).toBe(tooltip.id);
    await act(async () => arc.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await click('Explore Example project');
    const childArc = container.querySelector('circle[aria-label="Select Example task"]')!;
    await act(async () => childArc.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    tooltip = document.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain('Example task');
    expect(tooltip.textContent).toContain('Share of Example project');
    expect(tooltip.textContent).toContain('100.0%');
    await act(async () => childArc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(container.querySelector('svg[aria-label="storage distribution for Example task"]')).not.toBeNull();
  });

  it('includes the remainder segment and supports focus, Escape, and scroll dismissal', async () => {
    vi.mocked(getResourceStorage).mockResolvedValue({ ...snapshot(), groups: [project] });
    await render();
    const arc = container.querySelector('circle[aria-label="Other groups"]')!;
    await act(async () => arc.dispatchEvent(new FocusEvent('focusin', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Other groups');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('200 B');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('20.0%');
    await act(async () => arc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => arc.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    await act(async () => window.dispatchEvent(new Event('scroll')));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps the overview visible while expanding projects and tasks in place', async () => {
    await render();
    expect(container.textContent).toContain('12.5%');
    expect(container.textContent).toContain('1 GiB');
    expect(container.textContent).toContain('1,000 B');
    await click('Expand Example project');
    expect(container.textContent).toContain('Example task');
    await click('Expand Example task');
    expect(container.textContent).toContain('Worktree');
    expect(container.textContent).toContain('Where resources go');
    expect(container.textContent).toContain('Grove total');
    expect(button('Collapse Example project').getAttribute('aria-expanded')).toBe('true');
  });

  it('shows selected group children directly without repeating the selected parent', async () => {
    await render();
    const legend = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.textContent?.includes('Example project'))!;
    await act(async () => legend.click());
    expect(container.querySelector('[aria-label="Expand Shared & other"]')).toBeNull();
    expect(container.textContent).toContain('Contents of Example project');
    expect(container.querySelector('[aria-label="Expand Example project"]')).toBeNull();
    expect(container.querySelector('[aria-label="Expand Example task"]')).not.toBeNull();
    expect(container.querySelector('svg[aria-label="storage distribution for Grove total"]')).not.toBeNull();
    await click('Show all in this level');
    expect(container.querySelector('[aria-label="Expand Shared & other"]')).not.toBeNull();
  });

  it('drills the pie and details together on double-click, then returns through parents and breadcrumbs', async () => {
    await render();
    await act(async () => {
      const legend = button('Select Example project');
      legend.click(); legend.click();
      legend.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(container.querySelector('svg[aria-label="storage distribution for Example project"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand Example project"]')).toBeNull();
    expect(container.querySelector('[aria-label="Expand Example task"]')).not.toBeNull();
    expect(container.textContent).toContain('1,000 B'); // overview stays global
    const arc = container.querySelector('circle[aria-label="Select Example task"]')!;
    await act(async () => arc.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector('svg[aria-label="storage distribution for Example task"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand Worktree"]')).not.toBeNull();
    await click('Back to parent');
    expect(container.querySelector('svg[aria-label="storage distribution for Example project"]')).not.toBeNull();
    await click('All resources');
    expect(container.querySelector('svg[aria-label="storage distribution for Grove total"]')).not.toBeNull();
    expect(button('Back to parent').disabled).toBe(true);
  });

  it('supports explicit drill buttons and resolves the current location after a rescan', async () => {
    await render();
    await click('Explore Example project');
    const nextProject = { ...project, id: 11 };
    const nextTask = { ...task, id: 13 };
    vi.mocked(getStorageChildren).mockImplementation(async (scan, id) => {
      const nodes = id === 0 ? [scan === 'second' ? nextProject : project, shared] : id === 11 ? [nextTask] : id === 13 ? [workspace] : [];
      return { nodes, total: nodes.length };
    });
    vi.mocked(getResourceStorage).mockResolvedValue({ ...snapshot('second'), groups: [nextProject, shared] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.querySelector('svg[aria-label="storage distribution for Example project"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand Example task"]')).not.toBeNull();
    expect(getStorageChildren).toHaveBeenCalledWith('second', 11, 0, '', expect.any(AbortSignal));
  });

  it('drills from a nested detail row using its full ancestor path', async () => {
    await render();
    await click('Expand Example project');
    await act(async () => button('Expand Example task').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector('svg[aria-label="storage distribution for Example task"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Resource location"]')?.textContent).toContain('Example project');
    expect(container.querySelector('[aria-label="Expand Worktree"]')).not.toBeNull();
  });

  it('resolves drilldown ancestors beyond the first storage page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => node(1000 + index, `File ${index}`, 'file', `file-${index}`, 1));
    vi.mocked(getStorageChildren).mockImplementation(async (_scan, id, offset) => {
      if (id === 0) return { nodes: offset === 0 ? firstPage : [project], total: 101 };
      return { nodes: [task], total: 1 };
    });
    await render();
    await click('Show more · 1 remaining');
    await act(async () => button('Expand Example project').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(container.querySelector('svg[aria-label="storage distribution for Example project"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand Example task"]')).not.toBeNull();
    expect(getStorageChildren).toHaveBeenCalledWith('first', 0, 100, '', expect.any(AbortSignal));
  });

  it('uses the same direct-selection and drilldown behavior for process metrics', async () => {
    await render();
    const memoryCard = [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(button => button.textContent?.startsWith('Memory'))!;
    await act(async () => memoryCard.click());
    await click('Select Example project');
    const detailRows = container.querySelector('[aria-label="Resource detail rows"]')!;
    expect(detailRows.textContent).toContain('Example task');
    expect(detailRows.textContent).not.toContain('Example project');
    await click('Explore Example project');
    expect(container.querySelector('svg[aria-label="memory distribution for Example project"]')).not.toBeNull();
    await click('Back to parent');
    expect(container.querySelector('svg[aria-label="memory distribution for Grove total"]')).not.toBeNull();
  });

  it('returns to the available parent when a drilled resource disappears after scanning', async () => {
    await render();
    await click('Explore Example project');
    vi.mocked(getStorageChildren).mockResolvedValue({ nodes: [shared], total: 1 });
    vi.mocked(getResourceStorage).mockResolvedValue({ ...snapshot('second'), groups: [shared], root: node(0, 'Grove storage', 'root', '~/.grove', 200, 1) });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain('nearest available parent');
    expect(container.querySelector('svg[aria-label="storage distribution for Grove total"]')).not.toBeNull();
    expect(button('Back to parent').disabled).toBe(true);
  });

  it('preserves expanded groups when a refreshed snapshot replaces numeric node IDs', async () => {
    await render();
    await click('Expand Example project');
    const nextProject = { ...project, id: 11 };
    vi.mocked(getStorageChildren).mockImplementation(async (scan, id) => {
      const nodes = id === 0 ? [scan === 'second' ? nextProject : project, shared] : id === 11 ? [task] : [];
      return { nodes, total: nodes.length };
    });
    vi.mocked(getResourceStorage).mockResolvedValue({ ...snapshot('second'), groups: [nextProject, shared] });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(container.textContent).toContain('Example task');
    expect(button('Collapse Example project').getAttribute('aria-expanded')).toBe('true');
    expect(getStorageChildren).toHaveBeenCalledWith('second', 11, 0, '', expect.any(AbortSignal));
  });

  it('searches the snapshot beyond already loaded rows', async () => {
    await render();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search resources"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'deep-file');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(getStorageChildren).toHaveBeenLastCalledWith('first', 0, 0, 'deep-file', expect.any(AbortSignal));
  });

  it('keeps the last successful process sample on failure and stops requests while hidden', async () => {
    await render();
    vi.mocked(getResourceProcesses).mockRejectedValue({ message: 'Temporarily offline' });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(container.textContent).toContain('Temporarily offline');
    expect(container.textContent).toContain('1 GiB');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const count = vi.mocked(getResourceProcesses).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(getResourceProcesses).toHaveBeenCalledTimes(count);
  });

  it('retains existing storage detail during a manual rescan', async () => {
    await render();
    await click('Expand Example project');
    await click('Refresh scan');
    expect(refreshResourceStorage).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Example task');
    expect(container.textContent).toContain('Scanning…');
    expect(button('Scanning…').disabled).toBe(true);
  });
});
