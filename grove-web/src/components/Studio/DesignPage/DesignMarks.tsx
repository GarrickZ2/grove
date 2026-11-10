import type { PointerEvent as ReactPointerEvent } from "react";
import { X } from "lucide-react";
import type { DesignMark } from "../../../api/designs";

interface Props {
  marks: DesignMark[];
  /** How far the board is zoomed; strokes and controls keep their size on screen. */
  zoom: number;
  /** Marks take the pointer: the Select tool is on. */
  active: boolean;
  selected: string | null;
  /** The note or text being typed in. */
  editing: string | null;
  onPointerDown: (mark: DesignMark, event: ReactPointerEvent) => void;
  onEdit: (id: string) => void;
  /** Typing ended; an empty text removes the mark. */
  onText: (id: string, text: string) => void;
  onRemove: (id: string) => void;
  onColor: (id: string, color: string) => void;
  onStroke: (id: string, stroke: number) => void;
}

const INK = "#e5484d";
/** Line weights on offer: thin, the default, heavy. */
const STROKES = [1.5, 2.5, 5];
const DEFAULT_STROKE = 2.5;
const COLORS = [INK, "#f5a524", "#30a46c", "#3e63dd", "#18181b"];
/** A note takes its color as a light tint; with none it is the usual yellow. */
const noteFill = (color: string | undefined) => (color ? `color-mix(in oklab, ${color} 30%, #fff)` : undefined);

function shape(mark: DesignMark, zoom: number) {
  const points = mark.points ?? [];
  switch (mark.kind) {
    case "rect":
      return <rect x={0} y={0} width={mark.width} height={mark.height} rx={4 / zoom} />;
    case "ellipse":
      return <ellipse cx={mark.width / 2} cy={mark.height / 2} rx={mark.width / 2} ry={mark.height / 2} />;
    case "arrow": {
      const [x1 = 0, y1 = 0, x2 = mark.width, y2 = mark.height] = points;
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const head = 14 / zoom;
      const wing = (turn: number) => `${x2 - head * Math.cos(angle + turn)},${y2 - head * Math.sin(angle + turn)}`;
      return <path d={`M${x1},${y1} L${x2},${y2} M${wing(0.45)} L${x2},${y2} L${wing(-0.45)}`} />;
    }
    default: {
      const pairs: string[] = [];
      for (let index = 0; index + 1 < points.length; index += 2) pairs.push(`${points[index]},${points[index + 1]}`);
      return <polyline points={pairs.join(" ")} />;
    }
  }
}

/**
 * What the user wrote and drew on the board: sticky notes, text, shapes and
 * pen strokes. They are kept in `design.json`, where the agent reads them.
 */
export function DesignMarks({ marks, zoom, active, selected, editing, onPointerDown, onEdit, onText, onRemove, onColor, onStroke }: Props) {
  return (
    <>
      {marks.map((mark) => {
        const chosen = selected === mark.id;
        const remove = chosen && editing !== mark.id ? (
          <>
          <div className="design-mark-colors" style={{ transform: `scale(${1 / zoom})` }} onPointerDown={(event) => event.stopPropagation()}>
            {COLORS.map((color) => (
              <button key={color} type="button" style={{ background: color }} onClick={() => onColor(mark.id, color)} title="Color" aria-label={`Color ${color}`} />
            ))}
            {mark.kind === "note" || mark.kind === "text" ? null : (
              <>
                <span className="design-mark-rule" />
                {STROKES.map((stroke) => (
                  <button
                    key={stroke}
                    type="button"
                    className={`design-mark-weight${(mark.stroke ?? DEFAULT_STROKE) === stroke ? " is-on" : ""}`}
                    onClick={() => onStroke(mark.id, stroke)}
                    title={stroke < DEFAULT_STROKE ? "Thin line" : stroke > DEFAULT_STROKE ? "Heavy line" : "Medium line"}
                    aria-label={`Line weight ${stroke}`}
                  >
                    <i style={{ height: stroke }} />
                  </button>
                ))}
              </>
            )}
          </div>
          <button
            type="button"
            className="design-mark-remove"
            style={{ transform: `translate(50%, -50%) scale(${1 / zoom})` }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onRemove(mark.id)}
            title="Delete"
            aria-label="Delete"
          >
            <X size={11} />
          </button>
          </>
        ) : null;
        const common = {
          onPointerDown: (event: ReactPointerEvent) => {
            if (active && editing !== mark.id) onPointerDown(mark, event);
            else if (editing === mark.id) event.stopPropagation();
          },
          onDoubleClick: () => {
            if (active && (mark.kind === "note" || mark.kind === "text")) onEdit(mark.id);
          },
        };
        if (mark.kind === "note" || mark.kind === "text") {
          return (
            <div
              key={mark.id}
              className={`design-mark is-${mark.kind}${chosen ? " is-chosen" : ""}${active ? " is-active" : ""}`}
              style={mark.kind === "note"
                ? { left: mark.x, top: mark.y, width: mark.width, minHeight: mark.height, background: noteFill(mark.color) }
                : { left: mark.x, top: mark.y, color: mark.color }}
              {...common}
            >
              {editing === mark.id ? (
                <textarea
                  autoFocus
                  defaultValue={mark.text ?? ""}
                  placeholder={mark.kind === "note" ? "Write a note" : "Text"}
                  rows={mark.kind === "note" ? 4 : 1}
                  onBlur={(event) => onText(mark.id, event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) event.currentTarget.blur();
                  }}
                />
              ) : (mark.text ?? "")}
              {remove}
            </div>
          );
        }
        return (
          <div
            key={mark.id}
            className={`design-mark is-ink${chosen ? " is-chosen" : ""}`}
            style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
          >
            <svg width={Math.max(1, mark.width)} height={Math.max(1, mark.height)} overflow="visible">
              <g fill="none" stroke={mark.color ?? INK} strokeWidth={mark.stroke ?? DEFAULT_STROKE} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
                {shape(mark, zoom)}
              </g>
              {/* A wide, unseen stroke to point at. */}
              <g fill="none" stroke="transparent" strokeWidth={14} vectorEffect="non-scaling-stroke" pointerEvents={active ? "stroke" : "none"} {...common}>
                {shape(mark, zoom)}
              </g>
            </svg>
            {remove}
          </div>
        );
      })}
    </>
  );
}
