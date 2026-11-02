import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Eye } from 'lucide-react';
import { OrbitInterfaceContext } from '../../orbit/ui/interfaceContext';
import { PanelShell } from '../../orbit/ui/PanelShell';
import { PANEL_HUES } from '../../orbit/ui/panelSlots';
import { ConversationSidebar } from './ConversationSidebar';

vi.mock('../../context', () => ({ useBanner: () => ({ showBanner: () => {} }) }));
vi.mock('../../hooks', () => ({ useFileMention: () => ({}) }));
vi.mock('../ui', () => ({ FileMentionDropdown: () => null }));
vi.mock('../Tasks/TaskView/useActiveChatId', () => ({ useGlobalActiveChatId: () => null }));

describe('ConversationSidebar heading', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const render = (orbit: boolean) => act(async () => root.render(
    <OrbitInterfaceContext.Provider value={orbit}>
      <PanelShell glyph={Eye} hue={PANEL_HUES.violet} title="Code Review" body="fill">
        <ConversationSidebar comments={[]} visible onNavigateToComment={() => {}} />
      </PanelShell>
    </OrbitInterfaceContext.Provider>,
  ));

  it('reads "Comments" in Orbit and "Conversation" in Workbench', async () => {
    await render(true);
    expect(container.querySelector('.conv-sidebar-header')?.textContent).toContain('Comments');
    await render(false);
    expect(container.querySelector('.conv-sidebar-header')?.textContent).toContain('Conversation');
  });
});
