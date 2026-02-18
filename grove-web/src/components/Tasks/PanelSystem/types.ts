/**
 * Panel System Type Definitions for FlexLayout
 */

// 面板类型枚举
export type PanelType = 'terminal' | 'chat' | 'review' | 'editor';

// 面板实例配置
export interface PanelInstanceConfig {
  // Terminal: 无特殊配置 (连接到同一个 tmux session)
  // Chat: 无特殊配置 (连接到同一个 Chat backend)
  // Review: 可选的 diff 路径
  diffPath?: string;
  // Editor: 可选的打开文件路径
  filePath?: string;
}

// Tab 节点扩展配置 (FlexLayout 的 config 字段)
export interface TabNodeConfig {
  panelType: PanelType;
  instanceConfig?: PanelInstanceConfig;
}

// Panel 标题映射
export const PANEL_TYPE_LABELS: Record<PanelType, string> = {
  terminal: 'Terminal',
  chat: 'Chat',
  review: 'Code Review',
  editor: 'Editor',
};
