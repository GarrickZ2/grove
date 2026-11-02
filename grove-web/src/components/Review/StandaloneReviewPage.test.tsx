import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../../api/config';
import { StandaloneReviewPage } from './StandaloneReviewPage';
import { useOrbitReview } from './useOrbitReview';

vi.mock('../../api/config', () => ({ getConfig: vi.fn() }));
const theme = { mode: 'auto', lightThemeId: 'light', darkThemeId: 'dark' };
vi.mock('../../context', () => ({ useTheme: () => theme }));
vi.mock('../../orbit/firstrun/storage', () => ({ readCachedOrbit: () => false, writeCachedInterface: () => {} }));
vi.mock('./DiffReviewPage', () => ({
  DiffReviewPage: () => <div data-review={useOrbitReview() ? 'orbit' : 'legacy'} />,
}));

describe('standalone /review page', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(theme, { mode: 'auto', lightThemeId: 'light', darkThemeId: 'dark' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => root.render(<StandaloneReviewPage projectId="p" taskId="t" />));
    await act(async () => { await Promise.resolve(); });
  }

  it('uses the Orbit Review UI when the interface is Orbit', async () => {
    vi.mocked(getConfig).mockResolvedValue({ web: { interface: 'orbit' }, theme: { mode: 'auto', light_theme: 'light', dark_theme: 'dark' } } as never);
    await render();
    expect(container.querySelector('.oui-panel')).not.toBeNull();
    expect(container.querySelector('[data-review]')?.getAttribute('data-review')).toBe('orbit');
  });

  it('keeps the legacy page for Workbench', async () => {
    vi.mocked(getConfig).mockResolvedValue({ web: { interface: 'workbench' }, theme: { mode: 'auto', light_theme: 'light', dark_theme: 'dark' } } as never);
    await render();
    expect(container.querySelector('.oui-panel')).toBeNull();
    expect(container.querySelector('[data-review]')?.getAttribute('data-review')).toBe('legacy');
  });

  it('waits for the saved theme before painting the review', async () => {
    vi.mocked(getConfig).mockResolvedValue({ web: { interface: 'orbit' }, theme: { mode: 'dark', light_theme: 'light', dark_theme: 'nord' } } as never);
    await render();
    expect(container.querySelector('[data-review]')).toBeNull();
    expect(container.querySelector('.orv-standalone-wait')).not.toBeNull();
    // ThemeProvider has applied the saved appearance.
    Object.assign(theme, { mode: 'dark', darkThemeId: 'nord' });
    await render();
    expect(container.querySelector('[data-review]')?.getAttribute('data-review')).toBe('orbit');
  });
});
