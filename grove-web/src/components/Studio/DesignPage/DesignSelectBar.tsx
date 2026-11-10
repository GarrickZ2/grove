import { Copy, MessageSquarePlus, Trash2, X } from "lucide-react";
import type { PickedElement } from "./DesignFrame";
import { toHex } from "./designEdit";

interface Props {
  /** The chosen element, in page pixels. */
  selection: PickedElement;
  /** How much the page is scaled on screen; the bar keeps its own size. */
  scale: number;
  /** Absent where the reader cannot comment. */
  onComment?: () => void;
  /** Absent where there is no chat of the reader's to add to. */
  onClear: () => void;
  /** Present where the element can be changed: the quick edits, ahead of the comment buttons. */
  edit?: {
    onStyle: (props: Record<string, string>) => void;
    onDuplicate: () => void;
    onRemove: () => void;
  };
}

/** What to do with the element the user pointed at. Sits above it, or below when there is no room. */
export function DesignSelectBar({ selection, scale, onComment, onClear, edit }: Props) {
  const above = selection.y > 48 / scale;
  return (
    <div
      className="design-select-bar"
      style={{
        left: Math.max(0, selection.x),
        top: above ? selection.y - 8 / scale : selection.y + selection.height + 8 / scale,
        transform: `scale(${1 / scale}) translateY(${above ? "-100%" : "0"})`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {edit ? (
        <>
          {selection.text ? (
            <label className="design-well" title="Text color">
              <span style={{ background: selection.styles.color }} />
              <input type="color" value={toHex(selection.styles.color) ?? "#000000"} onChange={(event) => edit.onStyle({ color: event.target.value })} />
            </label>
          ) : null}
          <label className="design-well" title="Fill">
            <span className={toHex(selection.styles.backgroundColor) ? "" : "is-none"} style={{ background: selection.styles.backgroundColor }} />
            <input type="color" value={toHex(selection.styles.backgroundColor) ?? "#ffffff"} onChange={(event) => edit.onStyle({ "background-color": event.target.value })} />
          </label>
          <span className="design-select-rule" />
        </>
      ) : null}
      {onComment ? (
        <button type="button" onClick={onComment}>
          <MessageSquarePlus size={13} />
          Comment
        </button>
      ) : null}
      {edit ? (
        <>
          <span className="design-select-rule" />
          <button type="button" className="is-icon" onClick={edit.onDuplicate} title="Duplicate" aria-label="Duplicate"><Copy size={13} /></button>
          <button type="button" className="is-icon" onClick={edit.onRemove} title="Delete" aria-label="Delete"><Trash2 size={13} /></button>
        </>
      ) : null}
      <button type="button" className="is-icon" onClick={onClear} title="Clear" aria-label="Clear selection">
        <X size={13} />
      </button>
    </div>
  );
}
