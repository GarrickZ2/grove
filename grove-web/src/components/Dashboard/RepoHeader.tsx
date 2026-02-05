import { motion } from "framer-motion";
import { Code, Terminal } from "lucide-react";
import { getProjectStyle } from "../../utils/projectStyle";
import { useTheme } from "../../context";

interface RepoHeaderProps {
  projectId: string;
  name: string;
  path: string;
  onOpenIDE: () => void;
  onOpenTerminal: () => void;
}

export function RepoHeader({ projectId, name, path, onOpenIDE, onOpenTerminal }: RepoHeaderProps) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(projectId, theme.accentPalette);

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center justify-between"
    >
      {/* Left: Project Info */}
      <div className="flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: color.bg }}
        >
          <Icon className="w-6 h-6" style={{ color: color.fg }} />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-[var(--color-text)]">{name}</h1>
          <p className="text-sm text-[var(--color-text-muted)] font-mono">{path}</p>
        </div>
      </div>

      {/* Right: Quick Actions */}
      <div className="flex items-center gap-2">
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onOpenIDE}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] text-sm transition-colors"
        >
          <Code className="w-4 h-4" />
          IDE
        </motion.button>
        <motion.button
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          onClick={onOpenTerminal}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] text-sm transition-colors"
        >
          <Terminal className="w-4 h-4" />
          Terminal
        </motion.button>
      </div>
    </motion.div>
  );
}
