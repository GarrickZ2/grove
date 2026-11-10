/**
 * Panel System Type Definitions for FlexLayout
 */

// 面板类型枚举
export type PanelType = 'terminal' | 'chat' | 'review' | 'editor' | 'graph'
  | 'stats' | 'git' | 'notes' | 'comments' | 'artifacts' | 'sketch' | 'design' | 'browser';

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
//
// 内置面板用 `panelType`(枚举);插件面板用 `'plugin'` + `pluginId`(注册表式,
// 由已安装插件列表充当注册表)。FlexLayout 的 `component` 字段对插件面板恒为
// `'plugin'`,factory 据 `pluginId` 查插件渲染 iframe。
export interface TabNodeConfig {
  panelType: PanelType | 'plugin';
  /** Set when panelType === 'plugin' — which plugin this tab hosts. */
  pluginId?: string;
  instanceConfig?: PanelInstanceConfig;
}

