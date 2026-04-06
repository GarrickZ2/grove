import { useState, useRef, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { createPortal } from 'react-dom';
import { Layout, Model, TabNode, Actions, DockLocation, TabSetNode, BorderNode, Node as FlexNode } from 'flexlayout-react';
import type { IJsonModel, ITabRenderValues, ITabSetRenderValues, IJsonRowNode, IJsonTabSetNode, IJsonTabNode } from 'flexlayout-react';
import {
  Terminal, MessageSquare, Code, FileCode, BarChart3, GitBranch, FileText,
  MessageCircle, X, XCircle, Trash2,
  Plus, Maximize, Minimize2,
} from 'lucide-react';
import 'flexlayout-react/style/light.css';
import './flexlayout-theme.css';
import type { Task } from '../../../data/types';
import type { PanelType, TabNodeConfig } from './types';
import type { FileNavRequest } from '../../Review';
import { TaskTerminal } from '../TaskView/TaskTerminal';
import { TaskChat } from '../TaskView/TaskChat';
import { TaskCodeReview } from '../TaskView/TaskCodeReview';
import { TaskEditor } from '../TaskView/TaskEditor';
import { StatsTab, GitTab, NotesTab, CommentsTab } from '../TaskInfoPanel/tabs';
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';
import { useConfig } from '../../../context';

// --- TabBar Dropdown Menu ---
interface DropdownItem {
  id: string;
  label: string;
  icon: typeof Plus;
  onClick: () => void;
  shortcut?: string;
  variant?: 'default' | 'warning' | 'danger';
  disabled?: boolean;
  separator?: boolean;
}

// Shared inline-button style for tab bar controls
const tabBarBtnStyle = (active = false): React.CSSProperties => ({
  padding: '3px 6px',
  background: active ? 'var(--color-bg-tertiary)' : 'transparent',
  border: '1px solid transparent',
  cursor: 'pointer',
  color: 'var(--color-text-muted)',
  display: 'flex',
  alignItems: 'center',
  gap: '3px',
  borderRadius: '5px',
  fontSize: '11px',
  fontWeight: 500,
  lineHeight: 1,
  transition: 'all 0.15s ease',
});

function TabBarDropdown({ icon: TriggerIcon, items, title, label }: {
  icon: typeof Plus;
  items: DropdownItem[];
  title: string;
  label?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (closeTimer.current) clearTimeout(closeTimer.current); };
  }, []);

  // Close when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const openMenu = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (!isOpen && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setMenuPos({ top: rect.bottom + 4, left: rect.right });
    }
    setIsOpen(true);
  };

  const scheduleClose = () => {
    closeTimer.current = setTimeout(() => setIsOpen(false), 150);
  };

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };

  const getVariantColor = (variant?: string) => {
    switch (variant) {
      case 'warning': return 'var(--color-warning)';
      case 'danger': return 'var(--color-error)';
      default: return 'var(--color-text)';
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        title={title}
        style={tabBarBtnStyle(isOpen)}
      >
        <TriggerIcon size={13} />
        {label && <span>{label}</span>}
      </button>
      {isOpen && createPortal(
        <div
          ref={menuRef}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{
            position: 'fixed',
            top: menuPos.top,
            left: menuPos.left,
            transform: 'translateX(-100%)',
            zIndex: 10000,
            minWidth: '200px',
            padding: '5px',
            borderRadius: '10px',
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)',
          }}
        >
          {items.map((item, i) => (
            <div key={item.id}>
              {item.separator && i > 0 && (
                <div style={{ height: '1px', background: 'var(--color-border)', margin: '4px 6px' }} />
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (!item.disabled) {
                    item.onClick();
                    setIsOpen(false);
                  }
                }}
                disabled={item.disabled}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12.5px] font-medium rounded-md transition-colors ${item.disabled ? 'opacity-35 cursor-not-allowed' : 'cursor-pointer hover:bg-[var(--color-bg-tertiary)]'}`}
                style={{ border: 'none', background: 'none', textAlign: 'left', color: getVariantColor(item.variant) }}
              >
                <item.icon size={14} style={{ flexShrink: 0, opacity: 0.8 }} />
                <span style={{ flex: 1 }}>{item.label}</span>
                {item.shortcut && (
                  <kbd style={{
                    fontSize: '10px',
                    fontFamily: 'SF Mono, Menlo, monospace',
                    padding: '2px 5px',
                    borderRadius: '4px',
                    border: '1px solid var(--color-border)',
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text-muted)',
                    lineHeight: 1,
                  }}>
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

interface FlexLayoutContainerProps {
  task: Task;
  projectId: string;
  initialLayout?: IJsonModel;
  onLayoutChange?: (model: IJsonModel) => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export interface FlexLayoutContainerHandle {
  addPanel: (type: PanelType) => void;
  /** Select an existing tab of this type, or create one if none exists. */
  ensurePanel: (type: PanelType) => void;
  getModel: () => Model;
  selectTabByIndex: (index: number) => "handled" | "no_tabs" | "out_of_range";
  selectAdjacentTab: (delta: number) => boolean;
  closeActiveTab: () => void;
  /** Navigate to a file (optionally at a line) in the Review panel */
  navigateToFile: (filePath: string, line?: number, mode?: 'diff' | 'full') => void;
}

export const FlexLayoutContainer = forwardRef<
  FlexLayoutContainerHandle,
  FlexLayoutContainerProps
>(({ task, projectId, initialLayout, onLayoutChange, fullscreen = false, onToggleFullscreen }, ref) => {
  const { terminalAvailable, chatAvailable } = useConfig();

  // Panel instance counters
  const instanceCounters = useRef<Record<PanelType, number>>({
    terminal: 0,
    chat: 0,
    review: 0,
    editor: 0,
    stats: 0,
    git: 0,
    notes: 0,
    comments: 0,
  });

  // Get panel label
  const getPanelLabel = useCallback((type: PanelType): string => {
    const labels: Record<PanelType, string> = {
      terminal: 'Terminal',
      chat: 'Chat',
      review: 'Code Review',
      editor: 'Editor',
      stats: 'Stats',
      git: 'Git',
      notes: 'Notes',
      comments: 'Comments',
    };
    return labels[type];
  }, []);

  // Create default layout — empty, user chooses what to open
  const createDefaultLayout = (): IJsonModel => ({
    global: {
      tabEnableClose: true,
      tabEnableRename: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetEnableDrop: true,
      tabSetEnableDrag: true,
      tabSetEnableDivide: true,
      tabSetEnableMaximize: false,
      splitterSize: 4,
    },
    borders: [],
    layout: {
      type: 'row',
      weight: 100,
      children: [],
    },
  });

  // Create tab node
  const createTabNode = useCallback((type: PanelType, instanceNumber: number) => {
    const id = `${type}-${instanceNumber}`;
    const name = `${getPanelLabel(type)} #${instanceNumber}`;
    return {
      type: 'tab',
      id,
      name,
      component: type,
      config: {
        panelType: type,
      } as TabNodeConfig,
    };
  }, [getPanelLabel]);

  const layoutStorageKey = `grove-flexlayout-${projectId}-${task.id}`;
  // Load saved layout from localStorage
  const loadSavedLayout = (): IJsonModel | null => {
    try {
      const saved = localStorage.getItem(layoutStorageKey);
      if (saved) {
        const json = JSON.parse(saved) as IJsonModel;
        // Strip any persisted maximized state (transient, not saved).
        // Must recurse into nested rows/tabsets for split layouts.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stripMaximized = (node: any) => {
          if (node?.type === 'tabset' && node.maximized) {
            delete node.maximized;
          }
          if (node?.children) {
            node.children.forEach(stripMaximized);
          }
        };
        stripMaximized(json.layout);
        // Restore instance counters from saved layout
        type JsonNode = (IJsonRowNode | IJsonTabSetNode | IJsonTabNode) & { children?: JsonNode[] };
        const restoreCounters = (node: JsonNode) => {
          if (node.type === 'tab' && node.id) {
            const match = node.id.match(/^(\w+)-(\d+)$/);
            if (match) {
              const panelType = match[1] as PanelType;
              const num = parseInt(match[2], 10);
              if (instanceCounters.current[panelType] < num) {
                instanceCounters.current[panelType] = num;
              }
            }
          }
          if (node.children) {
            node.children.forEach(restoreCounters);
          }
        };
        restoreCounters(json.layout);
        return json;
      }
    } catch (error) {
      console.error('Failed to load saved layout:', error);
    }
    return null;
  };

  // Initialize model
  // eslint-disable-next-line react-hooks/refs -- reading ref in lazy initializer is safe (runs once on mount)
  const [model] = useState<Model>(() => {
    const layoutJson = initialLayout || loadSavedLayout() || createDefaultLayout();
    return Model.fromJson(layoutJson);
  });

  // Tab rename state
  const [editingTabId, setEditingTabId] = useState<string | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    tabId: string;
  } | null>(null);

  // Fullscreen panel state (tracks which tabset is maximized)
  const [fullscreenPanelId, setFullscreenPanelId] = useState<string | null>(null);

  // Auto-focus the content inside a panel after switching to it
  const focusPanelContent = useCallback(() => {
    requestAnimationFrame(() => {
      // Find visible FlexLayout tab contents and focus the appropriate element
      const tabContents = document.querySelectorAll('.flexlayout__tab');
      for (const tabContent of tabContents) {
        if ((tabContent as HTMLElement).offsetParent === null) continue;

        // Priority: xterm textarea > chat input > diff-content > any focusable
        const xterm = tabContent.querySelector('.xterm-helper-textarea') as HTMLElement;
        if (xterm) { xterm.focus(); return; }

        const chatInput = tabContent.querySelector('textarea, [contenteditable="true"]') as HTMLElement;
        if (chatInput) { chatInput.focus(); return; }

        const diffContent = tabContent.querySelector('.diff-content[tabindex]') as HTMLElement;
        if (diffContent) { diffContent.focus(); return; }
      }
    });
  }, []);

  // Get all tabs in the model
  const getAllTabs = useCallback(() => {
    const tabs: TabNode[] = [];
    const visit = (node: FlexNode) => {
      if (node.getType() === 'tab') {
        tabs.push(node as TabNode);
      }
      if (node.getChildren) {
        node.getChildren().forEach(visit);
      }
    };
    visit(model.getRoot());
    return tabs;
  }, [model]);

  // Add new panel — always creates a new tab in the active tabset.
  const addPanel = useCallback((type: PanelType) => {
    const activeTabset = model.getActiveTabset();

    // Find max existing number for this type from current tabs
    let maxNum = 0;
    const allTabs = getAllTabs();
    for (const tab of allTabs) {
      const match = tab.getId().match(new RegExp(`^${type}-(\\d+)$`));
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10));
      }
    }
    const instanceNumber = maxNum + 1;

    const newTab = createTabNode(type, instanceNumber);
    const targetTabsetId = activeTabset?.getId() ?? model.getRoot().getId();

    model.doAction(
      Actions.addNode(newTab, targetTabsetId, DockLocation.CENTER, -1)
    );
    focusPanelContent();
  }, [model, focusPanelContent, getAllTabs, createTabNode]);

  // Ensure a panel of the given type exists. If one already exists, select it.
  // Otherwise, create a new one.
  const ensurePanel = useCallback((type: PanelType) => {
    const allTabs = getAllTabs();
    const existing = allTabs.find((tab) => tab.getId().startsWith(`${type}-`));
    if (existing) {
      model.doAction(Actions.selectTab(existing.getId()));
      focusPanelContent();
    } else {
      addPanel(type);
    }
  }, [model, getAllTabs, addPanel, focusPanelContent]);

  // Select a tab by its visual index (0-based) across all tabsets.
  // Returns: "handled" if tab was selected, "no_tabs" if workspace has no tabs,
  // "out_of_range" if index exceeds the number of open tabs.
  const selectTabByIndex = useCallback((index: number): "handled" | "no_tabs" | "out_of_range" => {
    const tabs: TabNode[] = [];
    const visit = (node: FlexNode) => {
      if (node.getType() === 'tab') {
        tabs.push(node as TabNode);
      }
      if (node.getChildren) {
        node.getChildren().forEach(visit);
      }
    };
    visit(model.getRoot());
    if (tabs.length === 0) return "no_tabs";
    if (index >= 0 && index < tabs.length) {
      model.doAction(Actions.selectTab(tabs[index].getId()));
      focusPanelContent();
      return "handled";
    }
    return "out_of_range";
  }, [model, focusPanelContent]);

  // Select next/previous tab relative to the current one (delta: +1 or -1)
  const selectAdjacentTab = useCallback((delta: number): boolean => {
    const tabs: TabNode[] = [];
    const visit = (node: FlexNode) => {
      if (node.getType() === 'tab') tabs.push(node as TabNode);
      if (node.getChildren) node.getChildren().forEach(visit);
    };
    visit(model.getRoot());
    if (tabs.length === 0) return false;
    const activeTabset = model.getActiveTabset();
    const selectedNode = activeTabset?.getSelectedNode();
    const currentIndex = selectedNode ? tabs.findIndex(t => t.getId() === selectedNode.getId()) : -1;
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + tabs.length) % tabs.length;
    model.doAction(Actions.selectTab(tabs[nextIndex].getId()));
    focusPanelContent();
    return true;
  }, [model, focusPanelContent]);

  // Close the currently active/selected tab
  const closeActiveTab = useCallback(() => {
    const activeTabset = model.getActiveTabset();
    if (!activeTabset) return;
    const selectedNode = activeTabset.getSelectedNode();
    if (selectedNode) {
      model.doAction(Actions.deleteTab(selectedNode.getId()));
    }
  }, [model]);

  // --- File navigation for Review panel ---
  const navSeqRef = useRef(0);
  const [fileNavRequest, setFileNavRequest] = useState<FileNavRequest | null>(null);

  const navigateToFile = useCallback((filePath: string, line?: number, mode: 'diff' | 'full' = 'full') => {
    const seq = ++navSeqRef.current;
    setFileNavRequest({ file: filePath, line, mode, seq });

    // Ensure a review tab exists and is selected
    const allTabs = getAllTabs();
    const reviewTab = allTabs.find((t) => t.getComponent() === 'review');
    if (reviewTab) {
      // Select the existing review tab
      model.doAction(Actions.selectTab(reviewTab.getId()));
    } else {
      // Create a new review tab
      addPanel('review');
    }
  }, [model, getAllTabs, addPanel]);

  // Expose API via ref
  useImperativeHandle(ref, () => ({
    addPanel,
    ensurePanel,
    getModel: () => model,
    selectTabByIndex,
    selectAdjacentTab,
    closeActiveTab,
    navigateToFile,
  }), [addPanel, ensurePanel, model, selectTabByIndex, selectAdjacentTab, closeActiveTab, navigateToFile]);

  // Context menu handlers
  const handleCloseTab = useCallback((tabId: string) => {
    model.doAction(Actions.deleteTab(tabId));
    setContextMenu(null);
  }, [model]);

  const closeTabById = useCallback((tabId: string) => {
    const tab = model.getNodeById(tabId);
    if (tab?.getType() === 'tab') {
      model.doAction(Actions.deleteTab(tabId));
    }
  }, [model]);

  const handleCloseOthers = useCallback((tabId: string) => {
    const allTabs = getAllTabs();
    allTabs.forEach(tab => {
      if (tab.getId() !== tabId) {
        model.doAction(Actions.deleteTab(tab.getId()));
      }
    });
    setContextMenu(null);
  }, [model, getAllTabs]);

  const handleCloseAll = useCallback(() => {
    const allTabs = getAllTabs();
    allTabs.forEach(tab => {
      model.doAction(Actions.deleteTab(tab.getId()));
    });
    setContextMenu(null);
  }, [model, getAllTabs]);

  // Generate context menu items
  const getContextMenuItems = useCallback((tabId: string): ContextMenuItem[] => {
    const allTabs = getAllTabs();
    const hasOtherTabs = allTabs.length > 1;

    return [
      {
        id: 'close',
        label: 'Close',
        icon: X,
        onClick: () => handleCloseTab(tabId),
      },
      {
        id: 'close-others',
        label: 'Close Others',
        icon: XCircle,
        onClick: () => handleCloseOthers(tabId),
        disabled: !hasOtherTabs,
      },
      {
        id: 'close-all',
        label: 'Close All',
        icon: Trash2,
        onClick: handleCloseAll,
        variant: 'danger' as const,
      },
    ];
  }, [getAllTabs, handleCloseTab, handleCloseOthers, handleCloseAll]);

  // Get panel icon and color by type
  const getPanelIconAndColor = (type: string): { icon: typeof Terminal; color: string } => {
    switch (type) {
      case 'terminal':
        return { icon: Terminal, color: 'var(--color-success)' };
      case 'chat':
        return { icon: MessageSquare, color: 'var(--color-info)' };
      case 'review':
        return { icon: Code, color: 'var(--color-highlight)' };
      case 'editor':
        return { icon: FileCode, color: 'var(--color-warning)' };
      case 'stats':
        return { icon: BarChart3, color: 'var(--color-accent)' };
      case 'git':
        return { icon: GitBranch, color: 'var(--color-success)' };
      case 'notes':
        return { icon: FileText, color: 'var(--color-info)' };
      case 'comments':
        return { icon: MessageCircle, color: 'var(--color-error)' };
      default:
        return { icon: Terminal, color: 'var(--color-text-muted)' };
    }
  };

  // Custom tab rendering (supports double-click rename)
  const renameBlurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const onRenderTab = useCallback((node: TabNode, renderValues: ITabRenderValues) => {
    const component = node.getComponent() || 'terminal';
    const { icon: Icon, color } = getPanelIconAndColor(component);
    const tabId = node.getId();
    const isEditing = editingTabId === tabId;

    renderValues.content = (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        onMouseDown={(e) => {
          // Middle-click to close tab
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            model.doAction(Actions.deleteTab(tabId));
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({
            position: { x: e.clientX, y: e.clientY },
            tabId,
          });
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setEditingTabId(tabId);
        }}
      >
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        {isEditing ? (
          <input
            autoFocus
            defaultValue={node.getName()}
            style={{
              fontSize: '13px',
              width: '100px',
              padding: '0 4px',
              border: '1px solid var(--color-highlight)',
              borderRadius: '3px',
              background: 'var(--color-bg)',
              color: 'var(--color-text)',
              outline: 'none',
            }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={() => {
              // Clear blur timer to prevent immediate cancellation on focus
              if (renameBlurTimer.current) clearTimeout(renameBlurTimer.current);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const val = (e.target as HTMLInputElement).value.trim();
                if (val) model.doAction(Actions.renameTab(tabId, val));
                setEditingTabId(null);
              } else if (e.key === 'Escape') {
                setEditingTabId(null);
              }
            }}
            onBlur={(e) => {
              const val = e.target.value.trim();
              // Delay blur handling to prevent flexlayout's internal focus stealing
              renameBlurTimer.current = setTimeout(() => {
                if (val) model.doAction(Actions.renameTab(tabId, val));
                setEditingTabId(null);
              }, 150);
            }}
          />
        ) : (
          <span style={{ fontSize: '13px' }}>{node.getName()}</span>
        )}
      </div>
    );
  }, [editingTabId, model]);

  // Build dropdown items for [+] Add Panel button
  const addPanelItems = useCallback((): DropdownItem[] => {
    const items: DropdownItem[] = [];
    if (chatAvailable) {
      items.push({ id: 'chat', label: 'Chat', icon: MessageSquare, onClick: () => addPanel('chat'), shortcut: 'i' });
    }
    if (terminalAvailable) {
      items.push({ id: 'terminal', label: 'Terminal', icon: Terminal, onClick: () => addPanel('terminal'), shortcut: 't' });
    }
    items.push(
      { id: 'review', label: 'Review', icon: Code, onClick: () => addPanel('review'), shortcut: 'r' },
      { id: 'editor', label: 'Editor', icon: FileCode, onClick: () => addPanel('editor'), shortcut: 'e' },
      { id: 'stats', label: 'Stats', icon: BarChart3, onClick: () => addPanel('stats'), separator: true },
      { id: 'git', label: 'Git', icon: GitBranch, onClick: () => addPanel('git') },
      { id: 'notes', label: 'Notes', icon: FileText, onClick: () => addPanel('notes') },
      { id: 'comments', label: 'Comments', icon: MessageCircle, onClick: () => addPanel('comments') },
    );
    return items;
  }, [chatAvailable, terminalAvailable, addPanel]);

  // Custom TabSet rendering ([+] add panel + maximize button)
  const onRenderTabSet = useCallback((tabSetNode: TabSetNode | BorderNode, renderValues: ITabSetRenderValues) => {
    const panelId = tabSetNode.getId();
    const isMaximized = fullscreenPanelId === panelId;

    renderValues.buttons = renderValues.buttons || [];

    // [+] Add Panel dropdown
    renderValues.buttons.push(
      <TabBarDropdown
        key="add-panel"
        icon={Plus}
        items={addPanelItems()}
        title="Add Panel"
      />
    );

    // Maximize this tabset (FlexLayout maximize + page-level fullscreen)
    renderValues.buttons.push(
      <button
        key="maximize-panel"
        onClick={(e) => {
          e.stopPropagation();
          model.doAction(Actions.maximizeToggle(panelId));
          if (isMaximized) {
            setFullscreenPanelId(null);
          } else {
            setFullscreenPanelId(panelId);
          }
          onToggleFullscreen?.();
        }}
        style={tabBarBtnStyle(false)}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-bg-tertiary)';
          e.currentTarget.style.color = 'var(--color-text)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--color-text-muted)';
        }}
        title={isMaximized ? "Restore" : "Maximize"}
      >
        {isMaximized ? <Minimize2 size={13} /> : <Maximize size={13} />}
      </button>
    );
  }, [addPanelItems, model, fullscreenPanelId, onToggleFullscreen]);

  // Factory function: render panel components based on tab type
  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();

    switch (component) {
      case 'terminal':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <TaskTerminal
              projectId={projectId}
              task={task}
              hideHeader={true}
              fullscreen={true}
              onDisconnected={() => closeTabById(node.getId())}
              instanceId={node.getId()}
            />
          </div>
        );

      case 'chat':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <TaskChat
              projectId={projectId}
              task={task}
              fullscreen={true}
              onNavigateToFile={navigateToFile}
            />
          </div>
        );

      case 'review':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <TaskCodeReview
              projectId={projectId}
              taskId={task.id}
              onClose={() => {
                model.doAction(Actions.deleteTab(node.getId()));
              }}
              navigateToFile={fileNavRequest}
              hideHeader={true}
              fullscreen={true}
            />
          </div>
        );

      case 'editor':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <TaskEditor
              projectId={projectId}
              taskId={task.id}
              onClose={() => {
                model.doAction(Actions.deleteTab(node.getId()));
              }}
              hideHeader={true}
              fullscreen={true}
            />
          </div>
        );

      case 'stats':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <StatsTab projectId={projectId} task={task} />
          </div>
        );

      case 'git':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <GitTab projectId={projectId} task={task} />
          </div>
        );

      case 'notes':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <NotesTab projectId={projectId} task={task} />
          </div>
        );

      case 'comments':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <CommentsTab projectId={projectId} task={task} />
          </div>
        );

      default:
        return <div className="p-4 text-[var(--color-text-muted)]">Unknown panel type: {component}</div>;
    }
  }, [projectId, task, model, closeTabById, navigateToFile, fileNavRequest]);

  // Track empty state
  const [isEmpty, setIsEmpty] = useState(() => getAllTabs().length === 0);

  // Handle model change (for persistence)
  const handleModelChange = useCallback((m: Model) => {
    try {
      const json = m.toJson();
      // Strip maximized state from all tabsets before saving — maximized is a
      // transient UI state managed by fullscreenPanelId, not persisted.
      // Must recurse into nested rows/tabsets for split layouts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stripMaximized = (node: any) => {
        if (node?.type === 'tabset' && node.maximized) {
          delete node.maximized;
        }
        if (node?.children) {
          node.children.forEach(stripMaximized);
        }
      };
      stripMaximized(json.layout);
      localStorage.setItem(layoutStorageKey, JSON.stringify(json));
      onLayoutChange?.(json);
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
    setIsEmpty(getAllTabs().length === 0);
  }, [layoutStorageKey, onLayoutChange, getAllTabs]);

  // Fullscreen: maximize panel to fill entire container
  if (fullscreenPanelId && fullscreen) {
    const fullscreenTabSet = model.getNodeById(fullscreenPanelId);
    if (fullscreenTabSet && fullscreenTabSet.getType() === 'tabset') {
      return (
        <div className="absolute inset-0 bg-[var(--color-bg)]">
          <Layout
            model={model}
            factory={factory}
            onRenderTab={onRenderTab}
            onRenderTabSet={onRenderTabSet}
            onModelChange={handleModelChange}
          />
        </div>
      );
    }
  }

  return (
    <>
      <div className="absolute inset-0">
        <Layout
          model={model}
          factory={factory}
          onRenderTab={onRenderTab}
          onRenderTabSet={onRenderTabSet}
          onModelChange={handleModelChange}
        />
      </div>

      {/* Empty state overlay */}
      {isEmpty && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="pointer-events-auto flex flex-col items-center gap-4 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Open a panel to get started
            </p>
            <div className="flex items-center gap-2">
              {chatAvailable && (
                <button onClick={() => addPanel('chat')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                  <MessageSquare size={13} /> Chat
                </button>
              )}
              {terminalAvailable && (
                <button onClick={() => addPanel('terminal')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                  <Terminal size={13} /> Terminal
                </button>
              )}
              <button onClick={() => addPanel('review')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                <Code size={13} /> Review
              </button>
              <button onClick={() => addPanel('editor')} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                <FileCode size={13} /> Editor
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] opacity-60">
              <kbd className="px-1.5 py-0.5 text-[10px] font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">⌘K</kbd> for all actions
            </p>
          </div>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          items={getContextMenuItems(contextMenu.tabId)}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
});

FlexLayoutContainer.displayName = 'FlexLayoutContainer';
