import { Bot, Clock, Database, Globe, PlugZap, ShieldAlert } from "lucide-react";
import type { PluginReview as Review } from "../../api/plugins";

export type Tone = "danger" | "warning" | "neutral";

const DATA_LABELS: Record<string, string> = {
  "project:read": "Read the current task's files",
  "project:write": "Change the current task's files",
  "chat:read": "Read chats and AI activity",
  "storage:read": "Read its own storage",
  "storage:write": "Write its own storage",
  "workspace:read": "List your projects and tasks",
  "sessions:read": "Read every Session's conversation",
  "buddies:read": "List your Buddies and their status",
  "view:list": "See what you are viewing, on every device",
  "memory:read": "Read project memory",
  "memory:write": "Add to project memory",
  "notes:read": "Read task notes",
  "notes:write": "Change task notes",
  "review:read": "Read review comments",
};

export interface Risk {
  id: string;
  tone: Tone;
  icon: typeof ShieldAlert;
  title: string;
  details: string[];
}

/** Capabilities the user grants by enabling the plugin, most dangerous first. */
export function reviewRisks(review: Review): Risk[] {
  const agent = [
    review.agent.skills && "Adds skills to every agent",
    review.agent.mcp && "Gives agents its MCP tools",
    review.agent.prompt_middleware && "Can inspect, block or rewrite your prompts",
    review.agent.chat_write && "Can send prompts to agents on your behalf",
    review.agent.sessions_write && "Can send prompts to any Session",
    review.agent.buddies_write && "Can send prompts to your Buddies",
    review.agent.ui_interact && "Can show you forms inside a Session",
  ].filter((item): item is string => Boolean(item));
  const risks: Array<Risk | false> = [
    review.full_trust && {
      id: "full-trust",
      tone: "danger",
      icon: ShieldAlert,
      title: "Full access to this Mac",
      details: ["Can run any command with your user's permissions."],
    },
    agent.length > 0 && {
      id: "agent",
      tone: "warning",
      icon: Bot,
      title: "Can steer your agents",
      details: [...agent, "Agents can run commands, so this reaches as far as they do."],
    },
    review.network && {
      id: "network",
      tone: "warning",
      icon: Globe,
      title: "Can reach the network",
      details: [
        "Its processes can send anything they can read to the internet.",
        "Grove cannot limit this, and it includes Grove's own local API.",
        ...(review.listeners ?? []).map((listener) =>
          `Says it opens ${listener.port ? `port ${listener.port}` : "a port"} (not enforced)`),
      ],
    },
    (review.service || review.activation?.on_startup || (review.activation?.schedules.length ?? 0) > 0) && {
      id: "background",
      tone: "neutral",
      icon: Clock,
      title: "Runs in the background",
      details: [
        ...(review.service ? ["Stays running while Grove is open"] : []),
        ...(review.activation?.on_startup && !review.service ? ["Starts with Grove"] : []),
        ...(review.activation?.schedules ?? []).map((cron) => `Runs on a schedule: ${cron}`),
      ],
    },
    review.data.length > 0 && {
      id: "data",
      tone: "neutral",
      icon: Database,
      title: "Uses your data",
      details: review.data.map((permission) => DATA_LABELS[permission] ?? permission),
    },
    review.connect_provider && {
      id: "connect",
      tone: "neutral",
      icon: PlugZap,
      title: "Accepts external callbacks",
      details: ["Receives requests from messaging services it connects to."],
    },
  ];
  return risks.filter((risk): risk is Risk => Boolean(risk));
}
