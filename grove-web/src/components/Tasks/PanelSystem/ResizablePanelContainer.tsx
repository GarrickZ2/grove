// @ts-nocheck
// DEPRECATED: This file is no longer used and will be removed
import { Panel, Group, Separator } from 'react-resizable-panels';
import type { Task } from '../../../data/types';
import type { PanelId } from './types';
import { TaskTerminal } from '../TaskView/TaskTerminal';
import { TaskChat } from '../TaskView/TaskChat';
import { TaskCodeReview } from '../TaskView/TaskCodeReview';
import { TaskEditor } from '../TaskView/TaskEditor';

interface ResizablePanelContainerProps {
  openPanels: Set<PanelId>;
  task: Task;
  projectId: string;
  onClosePanel: (panelId: PanelId) => void;
}

export function ResizablePanelContainer({
  openPanels,
  task,
  projectId,
  onClosePanel,
}: ResizablePanelContainerProps) {
  const panelArray = Array.from(openPanels);

  if (panelArray.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-secondary)] bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
        <p>请点击工具栏按钮打开面板</p>
      </div>
    );
  }

  // 渲染单个面板内容(不带额外标题栏)
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

  // 单面板: 全屏显示
  if (panelArray.length === 1) {
    return (
      <div className="h-full">
        {renderPanel(panelArray[0])}
      </div>
    );
  }

  // 双面板: 左右分割或上下分割
  if (panelArray.length === 2) {
    // Terminal/Chat 与 Review/Editor 组合 → 左右分割
    const hasTerminalOrChat = panelArray.some(p => p === 'terminal' || p === 'chat');
    const hasReviewOrEditor = panelArray.some(p => p === 'review' || p === 'editor');
    const direction = (hasTerminalOrChat && hasReviewOrEditor) ? 'horizontal' : 'vertical';

    return (
      <Group orientation={direction}>
        <Panel defaultSize={50} minSize={20}>
          {renderPanel(panelArray[0])}
        </Panel>
        <Separator className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
        <Panel defaultSize={50} minSize={20}>
          {renderPanel(panelArray[1])}
        </Panel>
      </Group>
    );
  }

  // 三面板: 左侧一个大面板,右侧两个小面板
  if (panelArray.length === 3) {
    const primaryPanels = panelArray.filter(p => p === 'terminal' || p === 'chat');

    // 如果有 Terminal/Chat,放左边;其他面板右侧垂直分割
    if (primaryPanels.length > 0) {
      const leftPanel = primaryPanels[0];
      const rightPanels = panelArray.filter(p => p !== leftPanel);

      return (
        <Group orientation="horizontal">
          <Panel defaultSize={60} minSize={30}>
            {renderPanel(leftPanel)}
          </Panel>
          <Separator className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
          <Panel defaultSize={40} minSize={20}>
            <Group orientation="vertical">
              <Panel defaultSize={50} minSize={20}>
                {renderPanel(rightPanels[0])}
              </Panel>
              <Separator className="h-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
              <Panel defaultSize={50} minSize={20}>
                {renderPanel(rightPanels[1])}
              </Panel>
            </Group>
          </Panel>
        </Group>
      );
    }

    // 否则:第一个面板占左侧,其他两个垂直分割右侧
    return (
      <Group orientation="horizontal">
        <Panel defaultSize={50} minSize={30}>
          {renderPanel(panelArray[0])}
        </Panel>
        <Separator className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
        <Panel defaultSize={50} minSize={20}>
          <Group orientation="vertical">
            <Panel defaultSize={50} minSize={20}>
              {renderPanel(panelArray[1])}
            </Panel>
            <Separator className="h-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
            <Panel defaultSize={50} minSize={20}>
              {renderPanel(panelArray[2])}
            </Panel>
          </Group>
        </Panel>
      </Group>
    );
  }

  // 四面板: 2x2 网格布局
  return (
    <Group orientation="horizontal">
      <Panel defaultSize={50} minSize={25}>
        <Group orientation="vertical">
          <Panel defaultSize={50} minSize={20}>
            {renderPanel(panelArray[0])}
          </Panel>
          <Separator className="h-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
          <Panel defaultSize={50} minSize={20}>
            {renderPanel(panelArray[1])}
          </Panel>
        </Group>
      </Panel>
      <Separator className="w-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
      <Panel defaultSize={50} minSize={25}>
        <Group orientation="vertical">
          <Panel defaultSize={50} minSize={20}>
            {renderPanel(panelArray[2])}
          </Panel>
          <Separator className="h-1 bg-[var(--color-border)] hover:bg-[var(--color-highlight)] transition-colors" />
          <Panel defaultSize={50} minSize={20}>
            {renderPanel(panelArray[3])}
          </Panel>
        </Group>
      </Panel>
    </Group>
  );
}
