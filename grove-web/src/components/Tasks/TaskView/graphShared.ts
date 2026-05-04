// Shared types/constants for TaskGraph + GraphContextToolbar. Pulled out so
// the toolbar can live in its own (Compiler-friendly) file without forcing a
// circular import back into TaskGraph.tsx.

export interface PendingMessageInfo {
  from: string;
  from_name: string;
  to: string;
  to_name: string;
  body_excerpt: string;
}

export interface GraphNode {
  chat_id: string;
  name: string;
  agent: string;
  duty?: string;
  status: string;
  pending_in: number;
  pending_out: number;
  pending_messages: PendingMessageInfo[];
}

export interface GraphEdge {
  edge_id: number;
  from: string;
  to: string;
  purpose?: string;
  state: string;
  pending_message?: PendingMessageInfo;
}

export const STATUS_COLORS: Record<string, string> = {
  // Visual hierarchy: busy / permission grab attention; idle is neutral so it
  // doesn't compete; connecting is informational; disconnected ghosts out.
  busy: "var(--color-error)",
  idle: "var(--color-border)",
  permission_required: "var(--color-warning)",
  connecting: "var(--color-info)",
  disconnected: "var(--color-text-muted)",
};
