import { Bot, Database, Globe, PlugZap, ShieldAlert } from "lucide-react";
import type { PluginReview as Review } from "../../api/plugins";

export type Tone = "danger" | "warning" | "neutral";

const DATA_LABELS: Record<string, string> = {
  "project:read": "Read the current task's files",
  "project:write": "Change the current task's files",
  "chat:read": "Read chats and AI activity",
  "storage:read": "Read its own storage",
  "storage:write": "Write its own storage",
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
      details: ["Its processes can send anything they can read to the internet."],
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
