// @ts-nocheck
// DEPRECATED: This file is no longer used and will be removed
import { X } from 'lucide-react';
import type { Task } from '../../../data/types';
import type { PanelId } from './types';
import { PANEL_TITLES } from './types';
import { TaskTerminal } from '../TaskView/TaskTerminal';
import { TaskChat } from '../TaskView/TaskChat';
import { TaskCodeReview } from '../TaskView/TaskCodeReview';
import { TaskEditor } from '../TaskView/TaskEditor';

interface SimplePanelContainerProps {
  openPanels: Set<PanelId>;
  task: Task;
  projectId: string;
  onClosePanel: (panelId: PanelId) => void;
}

export function SimplePanelContainer({
  openPanels,
  task,
  projectId,
  onClosePanel,
}: SimplePanelContainerProps) {
  const panelArray = Array.from(openPanels);

  if (panelArray.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
        <p>请点击工具栏按钮打开面板</p>
      </div>
    );
  }

  // 渲染单个面板
  const renderPanel = (id: PanelId) => {
    switch (id) {
      case 'terminal':
        return (
          <TaskTerminal
            projectId={projectId}
            task={task}
            onStartSession={() => {}}
          />
        );
      case 'chat':
        return (
          <TaskChat
            projectId={projectId}
            task={task}
            onStartSession={() => {}}
          />
        );
      case 'review':
        return (
          <TaskCodeReview
            projectId={projectId}
            taskId={task.id}
            onClose={() => onClosePanel('review')}
          />
        );
      case 'editor':
        return (
          <TaskEditor
            projectId={projectId}
            taskId={task.id}
            onClose={() => onClosePanel('editor')}
          />
        );
    }
  };

  // 单面板:全屏显示
  if (panelArray.length === 1) {
    return (
      <div className="h-full flex flex-col bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
          <span className="text-sm font-medium text-[var(--color-text)]">
            {PANEL_TITLES[panelArray[0]]}
          </span>
          <button
            onClick={() => onClosePanel(panelArray[0])}
            className="p-1 hover:bg-[var(--color-bg-hover)] rounded transition-colors"
            title="关闭面板"
          >
            <X className="w-4 h-4 text-[var(--color-text-muted)]" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          {renderPanel(panelArray[0])}
        </div>
      </div>
    );
  }

  // 多面板:CSS Grid 布局
  const gridClass = panelArray.length === 2
    ? 'grid grid-cols-2 gap-3'
    : panelArray.length === 3
    ? 'grid grid-cols-2 grid-rows-2 gap-3'
    : 'grid grid-cols-2 grid-rows-2 gap-3';

  return (
    <div className={`h-full ${gridClass}`}>
      {panelArray.map((id, index) => (
        <div
          key={id}
          className={`flex flex-col bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] overflow-hidden ${
            panelArray.length === 3 && index === 0 ? 'row-span-2' : ''
          }`}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] flex-shrink-0">
            <span className="text-sm font-medium text-[var(--color-text)]">
              {PANEL_TITLES[id]}
            </span>
            <button
              onClick={() => onClosePanel(id)}
              className="p-1 hover:bg-[var(--color-bg-hover)] rounded transition-colors"
              title="关闭面板"
            >
              <X className="w-4 h-4 text-[var(--color-text-muted)]" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {renderPanel(id)}
          </div>
        </div>
      ))}
    </div>
  );
}
