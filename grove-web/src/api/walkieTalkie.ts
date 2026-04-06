import type { GroupSnapshot, ChatRef } from "../data/types";

// ─── Client → Server ────────────────────────────────────────────────────────

export type WalkieTalkieClientMessage =
  | { type: "switch_group"; group_id: string }
  | { type: "select_task"; group_id: string; position: number }
  | { type: "send_prompt"; group_id: string; position: number; text: string; chat_id?: string | null }
  | { type: "switch_chat"; group_id: string; position: number; direction: "next" | "prev" };

// ─── Server → Client ────────────────────────────────────────────────────────

export type WalkieTalkieServerMessage =
  | { type: "connected"; groups: GroupSnapshot[]; theme: string }
  | { type: "task_status"; project_id: string; task_id: string; agent_status: "idle" | "busy" | "disconnected" }
  | { type: "prompt_sent"; group_id: string; position: number; status: "ok" | "error"; error?: string }
  | { type: "chat_info"; position: number; active_chat: ChatRef | null; available_chats: ChatRef[] }
  | { type: "group_updated"; groups: GroupSnapshot[] }
  | { type: "theme_changed"; theme: string };

// ─── Radio Events (Desktop ← Radio) ───────────────────────────────────────

export type RadioEvent =
  | { type: "focus_task"; project_id: string; task_id: string }
  | { type: "prompt_sent"; project_id: string; task_id: string }
  | { type: "client_connected" }
  | { type: "client_disconnected" }
  | { type: "client_count"; count: number }
  | { type: "group_changed" }
  | { type: "theme_changed" };
