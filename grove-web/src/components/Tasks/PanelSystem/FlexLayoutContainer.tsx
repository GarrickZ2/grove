import { useState, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { Layout, Model, TabNode, Actions, DockLocation } from 'flexlayout-react';
import type { IJsonModel, ITabRenderValues } from 'flexlayout-react';
import { Terminal, MessageSquare, Code, FileCode, BarChart3, GitBranch, FileText, MessageSquare as CommentIcon, X, XCircle, Trash2 } from 'lucide-react';
import 'flexlayout-react/style/light.css';
import './flexlayout-theme.css';
import type { Task } from '../../../data/types';
import type { PanelType, TabNodeConfig } from './types';
import { TaskTerminal } from '../TaskView/TaskTerminal';
import { TaskChat } from '../TaskView/TaskChat';
import { TaskCodeReview } from '../TaskView/TaskCodeReview';
import { TaskEditor } from '../TaskView/TaskEditor';
import { StatsTab, GitTab, NotesTab, CommentsTab } from '../TaskInfoPanel/tabs';
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu';

interface FlexLayoutContainerProps {
  task: Task;
  projectId: string;
  initialLayout?: IJsonModel;
  onLayoutChange?: (model: IJsonModel) => void;
}

export interface FlexLayoutContainerHandle {
  addPanel: (type: PanelType) => void;
  getModel: () => Model;
}

export const FlexLayoutContainer = forwardRef<
  FlexLayoutContainerHandle,
  FlexLayoutContainerProps
>(({ task, projectId, initialLayout, onLayoutChange }, ref) => {
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
  const getPanelLabel = (type: PanelType): string => {
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
  };

  // Create default layout
  const createDefaultLayout = (): IJsonModel => {
    // Determine default panel based on task config
    let defaultPanelType: PanelType = 'terminal';
    if (task.enableChat) {
      defaultPanelType = 'chat';
    } else if (task.enableTerminal) {
      defaultPanelType = 'terminal';
    }

    instanceCounters.current[defaultPanelType] = 1;

    return {
      global: {
        tabEnableClose: true,
        tabEnableRename: false,
        tabSetEnableDeleteWhenEmpty: true,
        tabSetEnableDrop: true,
        tabSetEnableDrag: true,
        tabSetEnableDivide: true,
        tabSetEnableMaximize: true,
        splitterSize: 4,
      },
      borders: [],
      layout: {
        type: 'row',
        weight: 100,
        children: [
          {
            type: 'tabset',
            weight: 100,
            children: [
              createTabNode(defaultPanelType, 1),
            ],
          },
        ],
      },
    };
  };

  // Create tab node
  const createTabNode = (type: PanelType, instanceNumber: number) => {
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
  };

  // Load saved layout from localStorage
  const loadSavedLayout = (): IJsonModel | null => {
    try {
      const saved = localStorage.getItem(`grove-flexlayout-${task.id}`);
      if (saved) {
        const json = JSON.parse(saved) as IJsonModel;
        // Restore instance counters from saved layout
        const restoreCounters = (node: any) => {
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
  const [model] = useState<Model>(() => {
    const layoutJson = initialLayout || loadSavedLayout() || createDefaultLayout();
    return Model.fromJson(layoutJson);
  });

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    tabId: string;
  } | null>(null);

  // Add new panel
  const addPanel = useCallback((type: PanelType) => {
    instanceCounters.current[type]++;
    const instanceNumber = instanceCounters.current[type];
    const newTab = createTabNode(type, instanceNumber);

    const activeTabset = model.getActiveTabset();
    const targetTabsetId = activeTabset?.getId() ?? model.getRoot().getId();

    model.doAction(
      Actions.addNode(newTab, targetTabsetId, DockLocation.CENTER, -1)
    );
  }, [model]);

  // Expose API via ref
  useImperativeHandle(ref, () => ({
    addPanel,
    getModel: () => model,
  }), [addPanel, model]);

  // Get all tabs in the model
  const getAllTabs = useCallback(() => {
    const tabs: TabNode[] = [];
    const visit = (node: any) => {
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

  // Context menu handlers
  const handleCloseTab = useCallback((tabId: string) => {
    model.doAction(Actions.deleteTab(tabId));
    setContextMenu(null);
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

  // 获取面板类型的图标和颜色
  const getPanelIconAndColor = (type: string): { icon: typeof Terminal; color: string } => {
    switch (type) {
      case 'terminal':
        return { icon: Terminal, color: '#16a34a' }; // 绿色
      case 'chat':
        return { icon: MessageSquare, color: '#3b82f6' }; // 蓝色
      case 'review':
        return { icon: Code, color: '#a855f7' }; // 紫色
      case 'editor':
        return { icon: FileCode, color: '#f59e0b' }; // 橙色
      case 'stats':
        return { icon: BarChart3, color: '#06b6d4' }; // 青色
      case 'git':
        return { icon: GitBranch, color: '#10b981' }; // 翠绿色
      case 'notes':
        return { icon: FileText, color: '#8b5cf6' }; // 紫罗兰
      case 'comments':
        return { icon: CommentIcon, color: '#ec4899' }; // 粉色
      default:
        return { icon: Terminal, color: '#6b7280' }; // 灰色
    }
  };

  // 自定义 Tab 渲染
  const onRenderTab = useCallback((node: TabNode, renderValues: ITabRenderValues) => {
    const component = node.getComponent() || 'terminal';
    const { icon: Icon, color } = getPanelIconAndColor(component);

    renderValues.content = (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({
            position: { x: e.clientX, y: e.clientY },
            tabId: node.getId(),
          });
        }}
      >
        <Icon size={14} style={{ color, flexShrink: 0 }} />
        <span style={{ fontSize: '13px' }}>{node.getName()}</span>
      </div>
    );
  }, []);

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
              onStartSession={() => {}}
              hideHeader={true}
              fullscreen={true}
            />
          </div>
        );

      case 'chat':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }}>
            <TaskChat
              projectId={projectId}
              task={task}
              onStartSession={() => {}}
              fullscreen={true}
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
            <GitTab task={task} />
          </div>
        );

      case 'notes':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <NotesTab task={task} />
          </div>
        );

      case 'comments':
        return (
          <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', padding: '16px', overflow: 'auto' }}>
            <CommentsTab task={task} />
          </div>
        );

      default:
        return <div className="p-4 text-[var(--color-text-muted)]">Unknown panel type: {component}</div>;
    }
  }, [projectId, task, model]);

  // Handle model change (for persistence)
  const handleModelChange = (model: Model) => {
    try {
      const json = model.toJson();
      localStorage.setItem(`grove-flexlayout-${task.id}`, JSON.stringify(json));
      onLayoutChange?.(json);
    } catch (error) {
      console.error('Failed to save layout:', error);
    }
  };

  return (
    <>
      <div className="absolute inset-0">
        <Layout
          model={model}
          factory={factory}
          onRenderTab={onRenderTab}
          onModelChange={handleModelChange}
        />
      </div>

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
