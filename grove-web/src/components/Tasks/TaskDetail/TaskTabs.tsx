import { motion } from "framer-motion";
import { GitBranch, FileText, MessageSquare, Bot, BarChart3 } from "lucide-react";
import type { TabType } from "./TaskDetail";

interface TaskTabsProps {
  activeTab: TabType;
  onTabChange: (tab: TabType) => void;
}

const tabs: { id: TabType; label: string; icon: typeof GitBranch }[] = [
  { id: "git", label: "Git", icon: GitBranch },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "review", label: "Review", icon: MessageSquare },
  { id: "ai", label: "AI", icon: Bot },
  { id: "stats", label: "Stats", icon: BarChart3 },
];

export function TaskTabs({ activeTab, onTabChange }: TaskTabsProps) {
  return (
    <div className="flex gap-1 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
      {tabs.map(({ id, label, icon: Icon }) => (
        <motion.button
          key={id}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => onTabChange(id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
            activeTab === id
              ? "bg-[var(--color-highlight)] text-white"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]"
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
          {label}
        </motion.button>
      ))}
    </div>
  );
}
