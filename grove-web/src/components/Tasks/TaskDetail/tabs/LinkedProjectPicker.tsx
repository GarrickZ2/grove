import { useEscapeScope } from "../../../../keyboard/useEscapeScope";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, Link2 } from "lucide-react";
import type { ProjectListItem } from "../../../../api";
import { useTheme } from "../../../../context";
import { getProjectStyle } from "../../../../utils/projectStyle";
import { ProjectTypeBadge } from "../../../ui/ProjectTypeBadge";

interface LinkedProjectPickerProps {
  projects: ProjectListItem[];
  disabled?: boolean;
  onSelect: (project: ProjectListItem) => void;
}

interface PickerPosition {
  top: number;
  left: number;
  width: number;
  maxListHeight: number;
}

export function LinkedProjectPicker({
  projects,
  disabled = false,
  onSelect,
}: LinkedProjectPickerProps) {
  const { theme } = useTheme();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [position, setPosition] = useState<PickerPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter((project) =>
      project.name.toLocaleLowerCase().includes(normalized),
    );
  }, [projects, query]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const viewportPadding = 12;
    const gap = 6;
    const width = Math.min(360, window.innerWidth - viewportPadding * 2);
    const headerHeight = 49;
    const preferredListHeight = 280;
    const availableBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
    const availableAbove = rect.top - gap - viewportPadding;
    const openAbove = availableBelow < 180 && availableAbove > availableBelow;
    const availableHeight = openAbove ? availableAbove : availableBelow;
    const maxListHeight = Math.max(
      0,
      Math.min(preferredListHeight, availableHeight - headerHeight),
    );
    const totalHeight = headerHeight + maxListHeight;
    const left = Math.min(
      Math.max(viewportPadding, rect.right - width),
      window.innerWidth - width - viewportPadding,
    );

    const rawTop = openAbove ? rect.top - gap - totalHeight : rect.bottom + gap;
    const maxTop = Math.max(viewportPadding, window.innerHeight - totalHeight - viewportPadding);

    setPosition({
      top: Math.max(viewportPadding, Math.min(rawTop, maxTop)),
      left,
      width,
      maxListHeight,
    });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHighlightedIndex(0);
  }, []);

  useEscapeScope(open, close);

  const select = useCallback(
    (project: ProjectListItem) => {
      if (disabled) return;
      onSelect(project);
      close();
    },
    [close, disabled, onSelect],
  );

  useEffect(() => {
    if (!open) return;
    updatePosition();
    requestAnimationFrame(() => inputRef.current?.focus());

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        close();
      }
    };
    const handleViewportChange = () => updatePosition();

    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [close, open, updatePosition]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(
      `[data-project-index="${highlightedIndex}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((index) =>
          filteredProjects.length === 0 ? 0 : (index + 1) % filteredProjects.length,
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex((index) =>
          filteredProjects.length === 0
            ? 0
            : (index - 1 + filteredProjects.length) % filteredProjects.length,
        );
        break;
      case "Enter": {
        event.preventDefault();
        const project = filteredProjects[highlightedIndex];
        if (project) select(project);
        break;
      }
      case "Escape":
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            setQuery("");
            setHighlightedIndex(0);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Link2 className="h-3.5 w-3.5" />
        <span>Link Project</span>
      </button>

      {open && position && typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            role="dialog"
            aria-label="Link Project"
            onKeyDown={handleKeyDown}
            onWheel={(event) => event.stopPropagation()}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
              zIndex: 9999,
            }}
            className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
          >
            <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
              <Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setHighlightedIndex(0);
                }}
                placeholder="Search projects..."
                aria-label="Search projects"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
              />
            </div>

            <div
              ref={listRef}
              role="listbox"
              style={{ maxHeight: position.maxListHeight }}
              className="overflow-y-auto overscroll-contain py-1"
            >
              {filteredProjects.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
                  No projects found
                </div>
              ) : (
                filteredProjects.map((project, index) => {
                  const { color, Icon } = getProjectStyle(project.id, theme.accentPalette);
                  return (
                    <button
                      key={project.id}
                      type="button"
                      role="option"
                      aria-selected={index === highlightedIndex}
                      data-project-index={index}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => select(project)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${
                        index === highlightedIndex
                          ? "bg-[var(--color-highlight)]/10"
                          : "hover:bg-[var(--color-bg-tertiary)]"
                      }`}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                        style={{ backgroundColor: color.bg }}
                      >
                        <Icon className="h-4 w-4" style={{ color: color.fg }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm font-medium text-[var(--color-text)]">
                            {project.name}
                          </span>
                          <ProjectTypeBadge type={project.project_type} />
                        </span>
                        <span className="block text-xs text-[var(--color-text-muted)]">
                          {project.task_count} task{project.task_count === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
