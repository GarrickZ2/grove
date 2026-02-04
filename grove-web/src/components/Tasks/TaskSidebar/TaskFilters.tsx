import { motion } from "framer-motion";
import type { TaskFilter } from "../../../data/types";

interface TaskFiltersProps {
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
}

const filters: { value: TaskFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function TaskFilters({ filter, onChange }: TaskFiltersProps) {
  return (
    <div className="flex gap-1">
      {filters.map(({ value, label }) => (
        <motion.button
          key={value}
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => onChange(value)}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            filter === value
              ? "bg-[var(--color-highlight)] text-white"
              : "bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
          }`}
        >
          {label}
        </motion.button>
      ))}
    </div>
  );
}
