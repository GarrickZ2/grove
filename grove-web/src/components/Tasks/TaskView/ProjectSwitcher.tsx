import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Link2 } from "lucide-react";
import { useTheme } from "../../../context";
import { getProjectStyle } from "../../../utils/projectStyle";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import { useInPanelShell } from "../../../orbit/ui/panelSlots";
import { LinkedProjectPicker } from "../TaskDetail/tabs/LinkedProjectPicker";
import { NO_LINKABLE_PROJECTS, type ProjectLinker } from "./useProjectLinker";
import type { ProjectTarget } from "./useProjectTarget";
import "../../Review/diffTheme.css";

function ProjectGlyph({ projectId }: { projectId: string }) {
  const { theme } = useTheme();
  const { color, Icon } = getProjectStyle(projectId, theme.accentPalette);
  return (
    <span className="review-project-glyph" style={{ backgroundColor: color.bg }}>
      <Icon style={{ color: color.fg }} />
    </span>
  );
}

/** Project picker that takes the place of a panel's heading, so switching
 *  Projects costs no extra row. Fixed width keeps the header from shifting
 *  as names change; it collapses to icon-only in narrow panels. */
export function ProjectSwitcher({
  targets,
  active,
  onSelect,
  verb,
  portal = false,
  linker,
}: {
  targets: ProjectTarget[];
  active: ProjectTarget;
  onSelect: (projectId: string) => void;
  /** What the panel does with the Project, for screen readers: "Reviewing". */
  verb: string;
  /** Portal the menu even outside Orbit, for hosts that clip overflow. */
  portal?: boolean;
  /** Adds a Link row to the menu. */
  linker?: ProjectLinker;
}) {
  const [open, setOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // In Orbit the switcher sits in a header / tab strip that clips overflow,
  // so the menu is portaled and fixed under the trigger.
  const orbitUi = useOrbitInterface();
  const inShell = useInPanelShell();
  const inOrbitShell = orbitUi && inShell;
  const portaled = portal || inOrbitShell;
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const own = targets.filter((t) => !t.linked);
  const linked = targets.filter((t) => t.linked);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const closeLinking = useCallback(() => setLinking(false), []);

  const renderOption = (target: ProjectTarget) => {
    const selected = target.projectId === active.projectId;
    return (
      <button
        key={target.projectId}
        type="button"
        role="option"
        aria-selected={selected}
        className="review-project-option"
        onClick={() => {
          onSelect(target.projectId);
          setOpen(false);
        }}
      >
        <ProjectGlyph projectId={target.projectId} />
        <span className="review-project-name">{target.name}</span>
        <Check className={`review-project-check ${selected ? "" : "invisible"}`} />
      </button>
    );
  };

  const menu = (
    <div className="review-project-menu">
      <div role="listbox" aria-label="Project">
        {own.map(renderOption)}
        {own.length > 0 && linked.length > 0 && (
          <div className="review-project-section">Linked projects</div>
        )}
        {linked.map(renderOption)}
      </div>
      {linker && (
        <div className="review-project-footer">
          <button
            type="button"
            className="review-project-option review-project-link"
            disabled={linker.disabled}
            onClick={() => {
              setOpen(false);
              setLinking(true);
            }}
          >
            <Link2 aria-hidden="true" />
            <span className="review-project-name">Link project</span>
          </button>
          {linker.error && <div className="review-project-error" role="alert">{linker.error}</div>}
        </div>
      )}
    </div>
  );

  return (
    <div ref={rootRef} className="review-project-switcher">
      <button
        ref={triggerRef}
        type="button"
        className="review-project-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${verb} ${active.name}. Switch project`}
        title={active.name}
        onClick={(e) => {
          if (portaled && !open) {
            const r = e.currentTarget.getBoundingClientRect();
            setAnchor({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 260)) });
          }
          setOpen((v) => !v);
        }}
      >
        <ProjectGlyph projectId={active.projectId} />
        <span className="review-project-name">{active.name}</span>
        <ChevronDown className="review-project-chevron" />
      </button>
      {open && !portaled && menu}
      {open && portaled && anchor && createPortal(
        <div ref={menuRef} className={inOrbitShell ? "orbit-ui orv-project-pop" : "review-project-pop"} style={{ top: anchor.top, left: anchor.left }}>{menu}</div>,
        document.body,
      )}
      {linker && (
        <LinkedProjectPicker
          projects={linker.projects}
          onSelect={linker.link}
          emptyLabel={NO_LINKABLE_PROJECTS}
          controlled={{ open: linking, onClose: closeLinking, anchor: triggerRef }}
        />
      )}
    </div>
  );
}
