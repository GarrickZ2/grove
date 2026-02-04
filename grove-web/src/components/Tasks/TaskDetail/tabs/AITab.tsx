import { motion } from "framer-motion";
import { Bot, CheckSquare, Square, FileText } from "lucide-react";
import type { Task } from "../../../../data/types";
import { getTaskAIData } from "../../../../data/mockData";

interface AITabProps {
  task: Task;
}

export function AITab({ task }: AITabProps) {
  const aiData = getTaskAIData(task.id);

  if (!aiData) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center">
        <Bot className="w-12 h-12 text-[var(--color-text-muted)] mb-3" />
        <p className="text-[var(--color-text-muted)]">No AI data available</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">
          AI summary and todos will appear here when the agent is active
        </p>
      </div>
    );
  }

  const completedCount = aiData.todos.filter((t) => t.completed).length;
  const totalCount = aiData.todos.length;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <h3 className="text-sm font-medium text-[var(--color-text)] mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" />
          AI Summary
        </h3>
        <p className="text-sm text-[var(--color-text-muted)] leading-relaxed">
          {aiData.summary}
        </p>
        <p className="text-xs text-[var(--color-text-muted)] mt-3">
          Updated: {aiData.updatedAt.toLocaleString()}
        </p>
      </div>

      {/* TODO List */}
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--color-text)] flex items-center gap-2">
            <CheckSquare className="w-4 h-4" />
            TODO List
          </h3>
          <span className="text-xs text-[var(--color-text-muted)]">
            {completedCount}/{totalCount} completed
          </span>
        </div>

        {/* Progress Bar */}
        <div className="h-1.5 bg-[var(--color-bg-secondary)] rounded-full mb-4 overflow-hidden">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${(completedCount / totalCount) * 100}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            className="h-full bg-[var(--color-success)] rounded-full"
          />
        </div>

        {/* Todo Items */}
        <div className="space-y-2">
          {aiData.todos.map((todo, index) => (
            <motion.div
              key={todo.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: index * 0.05 }}
              className="flex items-start gap-2.5 py-1"
            >
              {todo.completed ? (
                <CheckSquare className="w-4 h-4 text-[var(--color-success)] flex-shrink-0 mt-0.5" />
              ) : (
                <Square className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0 mt-0.5" />
              )}
              <span
                className={`text-sm ${
                  todo.completed
                    ? "text-[var(--color-text-muted)] line-through"
                    : "text-[var(--color-text)]"
                }`}
              >
                {todo.text}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
