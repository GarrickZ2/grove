import { useState, useEffect } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight, FolderOpen, FolderPlus, GitBranch, Palette, type LucideIcon } from "lucide-react";
import { getVersion } from "../../api";
import { GroveHeroBackground } from "../Layout/GroveHeroBackground";
import { GroveIcon } from "../Layout/GroveIcon";
import "./welcome.css";

/** How the first project is added; maps onto AddProjectDialog's mode and tab. */
export type WelcomeAction = "existing" | "git" | "new" | "studio";

interface WelcomePageProps {
  onAction: (action: WelcomeAction) => void;
}

const ACTIONS: { id: WelcomeAction; icon: LucideIcon; title: string; description: string }[] = [
  { id: "existing", icon: FolderOpen, title: "Open a folder", description: "Add a repository already on this computer" },
  { id: "git", icon: GitBranch, title: "Clone a repository", description: "From a Git URL" },
  { id: "new", icon: FolderPlus, title: "Create a project", description: "Start an empty folder" },
  { id: "studio", icon: Palette, title: "Create a Studio", description: "For design, docs, and non-code work" },
];

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * First page when Grove has no projects. Wide windows split into a brand hero
 * (growing tree, title, tagline) and the ways to add a project; narrow ones stack.
 */
export function WelcomePage({ onAction }: WelcomePageProps) {
  const [version, setVersion] = useState<string>("");
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    getVersion()
      .then((res) => setVersion(res.version))
      .catch(() => {});
  }, []);
  const isRemote = typeof window !== "undefined" && !!(window as unknown as Record<string, unknown>).__GROVE_REMOTE__;

  const rise = (delay: number, x = 0) => reduceMotion
    ? {}
    : { initial: { opacity: 0, x, y: x ? 0 : 12 }, animate: { opacity: 1, x: 0, y: 0 }, transition: { delay, duration: 0.6, ease: EASE } };

  return (
    <motion.div
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className="fixed inset-0 z-50 overflow-y-auto bg-[var(--color-bg)]"
    >
      <div className="flex min-h-full flex-col lg:flex-row">
        <section className="welcome-hero relative flex flex-col items-center justify-center overflow-hidden px-6 pb-8 pt-16 text-center lg:flex-[1.15] lg:items-start lg:px-[8vw] lg:py-16 lg:text-left">
          <GroveHeroBackground />
          <div className="relative">
            <GroveIcon size={176} grow={!reduceMotion} />
          </div>
          <motion.h1 {...rise(0.45)} className="relative mt-8 text-4xl font-semibold tracking-tight text-[var(--color-text)] lg:text-[52px] lg:leading-[1.05]">
            Welcome to Grove
          </motion.h1>
          <motion.p {...rise(0.55)} className="relative mt-4 max-w-md text-base text-[var(--color-text-muted)] lg:text-lg">
            Manage the context. Let agents do the work.
          </motion.p>
          {(version || isRemote) && (
            <motion.p {...rise(0.9)} className="relative mt-8 flex items-center gap-2 text-xs text-[var(--color-text-muted)] lg:absolute lg:bottom-8 lg:left-[8vw] lg:mt-0">
              {version && <span>v{version}</span>}
              {isRemote && (
                <span className="rounded-md border border-[var(--color-highlight)]/20 bg-[var(--color-highlight)]/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-highlight)]">
                  Remote
                </span>
              )}
            </motion.p>
          )}
        </section>

        <section className="flex flex-1 items-center justify-center px-6 pb-16 lg:border-l lg:border-[var(--color-border)] lg:px-12 lg:py-16">
          <div className="w-full max-w-[420px]">
            <motion.p {...rise(0.6, 16)} className="mb-3 text-[13px] font-medium text-[var(--color-text-muted)]">
              Add your first project
            </motion.p>
            <div className="flex flex-col gap-2.5">
              {ACTIONS.map(({ id, icon: Icon, title, description }, index) => (
                <motion.button
                  key={id}
                  type="button"
                  {...rise(0.68 + index * 0.07, 16)}
                  onClick={() => onAction(id)}
                  className="group flex w-full items-center gap-3.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3.5 text-left transition-[border-color,background-color,box-shadow] hover:border-[var(--color-highlight)]/40 hover:bg-[var(--color-bg-secondary)] hover:shadow-sm"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] transition-colors group-hover:border-[var(--color-highlight)]/30 group-hover:text-[var(--color-highlight)]">
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-[var(--color-text)]">{title}</span>
                    <span className="block text-xs text-[var(--color-text-muted)]">{description}</span>
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5" />
                </motion.button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </motion.div>
  );
}
