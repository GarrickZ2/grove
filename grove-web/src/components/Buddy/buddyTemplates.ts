import type { BuddyAvatarValue } from "./buddyAvatarConfig";
export interface BuddyTemplate { name: string; role: string; instructions: string; avatar: BuddyAvatarValue; note: string; routine?: { name: string; prompt: string; cron: string; time: string } }
export const BUDDY_TEMPLATES: BuddyTemplate[] = [
  { name: "Release Captain", role: "Keep releases on track", instructions: "Help me prepare releases, check readiness, and summarize blockers.", avatar: { shape: "blob", color: "#f59e0b" }, note: "Daily release check · 09:00", routine: { name: "Daily release check", prompt: "Review release readiness and summarize blockers and next steps.", cron: "0 9 * * *", time: "09:00" } },
  { name: "Code Scout", role: "Explore code and explain what matters", instructions: "Help me understand code, investigate changes, and identify next steps.", avatar: { shape: "squircle", color: "#8b5cf6" }, note: "Ready for your next question" },
  { name: "Morning Brief", role: "Start the day with a clear plan", instructions: "Help me review priorities and plan the day.", avatar: { shape: "circle", color: "#14b8a6" }, note: "Daily morning brief · 08:30", routine: { name: "Morning brief", prompt: "Summarize priorities, outstanding work, and a suggested plan for today.", cron: "30 8 * * *", time: "08:30" } },
  { name: "Inbox", role: "Turn incoming messages into next steps", instructions: "Help me organize incoming messages and decide what needs attention.", avatar: { shape: "drop", color: "#6366f1" }, note: "Pair with IM Connect" },
];
