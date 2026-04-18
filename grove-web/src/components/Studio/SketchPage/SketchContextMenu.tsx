import { Pencil, Trash2 } from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "../../ui/ContextMenu";

interface Props {
  position: { x: number; y: number } | null;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * Right-click context menu for a sketch tab.
 *
 * Thin wrapper around the shared `ContextMenu` that exposes Rename and
 * Delete actions. Deletion confirmation is handled by the parent — this
 * component only emits the intent.
 */
export function SketchContextMenu({ position, onClose, onRename, onDelete }: Props) {
  const items: ContextMenuItem[] = [
    {
      id: "rename",
      label: "Rename",
      icon: Pencil,
      onClick: onRename,
    },
    {
      id: "delete",
      label: "Delete",
      icon: Trash2,
      variant: "danger",
      onClick: onDelete,
    },
  ];
  return <ContextMenu items={items} position={position} onClose={onClose} />;
}
