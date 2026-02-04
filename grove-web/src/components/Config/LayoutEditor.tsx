import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  X,
  Plus,
  Trash2,
  Sparkles,
  Terminal,
  FolderSearch,
  MonitorUp,
  Command,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Pencil,
  Check,
} from "lucide-react";
import { Button } from "../ui";

// Pane types
export type PaneType = "agent" | "grove" | "file-picker" | "shell" | "custom";

// Layout node - recursive tree structure
export interface LayoutNode {
  id: string;
  type: "split" | "pane";
  // for split
  direction?: "horizontal" | "vertical";
  children?: [LayoutNode, LayoutNode];
  // for pane
  paneType?: PaneType;
  customCommand?: string;
}

export interface CustomLayoutConfig {
  id: string;
  name: string;
  root: LayoutNode;
}

interface LayoutEditorProps {
  isOpen: boolean;
  onClose: () => void;
  layouts: CustomLayoutConfig[];
  onChange: (layouts: CustomLayoutConfig[]) => void;
  selectedLayoutId: string | null;
  onSelectLayout: (id: string | null) => void;
}

const paneTypes: { type: PaneType; label: string; icon: React.ElementType; color: string }[] = [
  { type: "agent", label: "Agent", icon: Sparkles, color: "var(--color-highlight)" },
  { type: "grove", label: "Grove", icon: MonitorUp, color: "var(--color-info)" },
  { type: "file-picker", label: "File Picker", icon: FolderSearch, color: "var(--color-accent)" },
  { type: "shell", label: "Shell", icon: Terminal, color: "var(--color-text-muted)" },
  { type: "custom", label: "Custom", icon: Command, color: "var(--color-warning)" },
];

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function getPaneTypeInfo(type: PaneType) {
  return paneTypes.find((t) => t.type === type) || paneTypes[3];
}

function countPanes(node: LayoutNode): number {
  if (node.type === "pane") return 1;
  if (node.children) {
    return countPanes(node.children[0]) + countPanes(node.children[1]);
  }
  return 0;
}

function createDefaultPane(): LayoutNode {
  return { id: generateId(), type: "pane", paneType: "shell" };
}

function createDefaultLayout(): CustomLayoutConfig {
  return {
    id: generateId(),
    name: "New Layout",
    root: createDefaultPane(),
  };
}

// Action menu for a pane
interface PaneActionMenuProps {
  position: { x: number; y: number };
  onClose: () => void;
  onSplitHorizontal: () => void;
  onSplitVertical: () => void;
  onSetType: (type: PaneType) => void;
  onDelete: () => void;
  canSplitHorizontal: boolean;
  canSplitVertical: boolean;
  canDelete: boolean;
  currentType: PaneType | undefined;
}

function PaneActionMenu({
  position,
  onClose,
  onSplitHorizontal,
  onSplitVertical,
  onSetType,
  onDelete,
  canSplitHorizontal,
  canSplitVertical,
  canDelete,
  currentType,
}: PaneActionMenuProps) {
  const canSplitAny = canSplitHorizontal || canSplitVertical;

  // Calculate safe position to keep menu within viewport
  const menuWidth = 200;
  const menuHeight = 350; // Approximate max height
  const safeX = Math.min(Math.max(10, position.x - menuWidth / 2), window.innerWidth - menuWidth - 10);
  const safeY = Math.min(Math.max(10, position.y), window.innerHeight - menuHeight - 10);

  return createPortal(
    <div
      className="fixed inset-0 z-[10000]"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="absolute bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl p-2 min-w-[180px] max-h-[90vh] overflow-y-auto"
        style={{ left: safeX, top: safeY }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Split Actions */}
        {canSplitAny && (
          <>
            <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
              Split
            </div>
            {canSplitHorizontal ? (
              <button
                onClick={onSplitHorizontal}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <SplitSquareHorizontal className="w-4 h-4 text-[var(--color-info)]" />
                <span className="text-sm text-[var(--color-text)]">Split Horizontal</span>
              </button>
            ) : (
              <div className="w-full flex items-center gap-2 px-3 py-2 rounded-lg opacity-40 cursor-not-allowed">
                <SplitSquareHorizontal className="w-4 h-4 text-[var(--color-text-muted)]" />
                <span className="text-sm text-[var(--color-text-muted)]">Split Horizontal</span>
                <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">max 4</span>
              </div>
            )}
            {canSplitVertical ? (
              <button
                onClick={onSplitVertical}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
              >
                <SplitSquareVertical className="w-4 h-4 text-[var(--color-accent)]" />
                <span className="text-sm text-[var(--color-text)]">Split Vertical</span>
              </button>
            ) : (
              <div className="w-full flex items-center gap-2 px-3 py-2 rounded-lg opacity-40 cursor-not-allowed">
                <SplitSquareVertical className="w-4 h-4 text-[var(--color-text-muted)]" />
                <span className="text-sm text-[var(--color-text-muted)]">Split Vertical</span>
                <span className="text-[10px] text-[var(--color-text-muted)] ml-auto">max 2</span>
              </div>
            )}
            <div className="my-1 border-t border-[var(--color-border)]" />
          </>
        )}

        {/* Pane Types */}
        <div className="px-2 py-1 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
          Pane Type
        </div>
        {paneTypes.map((pt) => {
          const Icon = pt.icon;
          const isSelected = currentType === pt.type;
          return (
            <button
              key={pt.type}
              onClick={() => onSetType(pt.type)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors
                ${isSelected ? "bg-[var(--color-highlight)]/10" : "hover:bg-[var(--color-bg-secondary)]"}`}
            >
              <Icon className="w-4 h-4" style={{ color: pt.color }} />
              <span className={`text-sm ${isSelected ? "text-[var(--color-highlight)]" : "text-[var(--color-text)]"}`}>
                {pt.label}
              </span>
              {isSelected && <Check className="w-4 h-4 ml-auto text-[var(--color-highlight)]" />}
            </button>
          );
        })}

        {/* Delete */}
        {canDelete && (
          <>
            <div className="my-1 border-t border-[var(--color-border)]" />
            <button
              onClick={onDelete}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-[var(--color-error)]/10 transition-colors"
            >
              <Trash2 className="w-4 h-4 text-[var(--color-error)]" />
              <span className="text-sm text-[var(--color-error)]">Delete Pane</span>
            </button>
          </>
        )}
      </motion.div>
    </div>,
    document.body
  );
}

// Interactive layout preview
// Layout constraints: max 4 columns (horizontal) x 2 rows (vertical)
const MAX_HORIZONTAL_SPLITS = 2; // 2^2 = 4 columns max
const MAX_VERTICAL_SPLITS = 1;   // 2^1 = 2 rows max

interface LayoutPreviewProps {
  node: LayoutNode;
  onUpdate: (node: LayoutNode) => void;
  onDelete?: () => void;
  totalPanes: number;
  depth?: number;
  horizontalDepth?: number; // Number of horizontal splits in path
  verticalDepth?: number;   // Number of vertical splits in path
}

function LayoutPreview({
  node,
  onUpdate,
  onDelete,
  totalPanes,
  depth = 0,
  horizontalDepth = 0,
  verticalDepth = 0,
}: LayoutPreviewProps) {
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [customCommandInput, setCustomCommandInput] = useState(node.customCommand || "");

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type === "pane") {
      const rect = e.currentTarget.getBoundingClientRect();
      setMenuPosition({
        x: Math.min(rect.left + rect.width / 2, window.innerWidth - 200),
        y: Math.min(rect.top + rect.height / 2, window.innerHeight - 300),
      });
    }
  };

  const handleSplit = (direction: "horizontal" | "vertical") => {
    if (totalPanes >= 8) return;
    // Check direction-specific limits
    if (direction === "horizontal" && horizontalDepth >= MAX_HORIZONTAL_SPLITS) return;
    if (direction === "vertical" && verticalDepth >= MAX_VERTICAL_SPLITS) return;

    const newNode: LayoutNode = {
      id: generateId(),
      type: "split",
      direction,
      children: [
        { ...node, id: generateId() },
        createDefaultPane(),
      ],
    };
    onUpdate(newNode);
    setMenuPosition(null);
  };

  const handleSetType = (type: PaneType) => {
    onUpdate({ ...node, paneType: type, customCommand: type === "custom" ? node.customCommand : undefined });
    setMenuPosition(null);
  };

  const handleDelete = () => {
    if (onDelete) {
      onDelete();
    }
    setMenuPosition(null);
  };

  const handleCustomCommandChange = (cmd: string) => {
    setCustomCommandInput(cmd);
    onUpdate({ ...node, customCommand: cmd });
  };

  if (node.type === "split" && node.children) {
    const isHorizontal = node.direction === "horizontal";
    // Increment the appropriate depth counter for children
    const childHorizontalDepth = isHorizontal ? horizontalDepth + 1 : horizontalDepth;
    const childVerticalDepth = isHorizontal ? verticalDepth : verticalDepth + 1;

    return (
      <div className={`flex ${isHorizontal ? "flex-row" : "flex-col"} gap-1 w-full h-full`}>
        <div className="flex-1 min-w-0 min-h-0">
          <LayoutPreview
            node={node.children[0]}
            onUpdate={(updated) => {
              onUpdate({ ...node, children: [updated, node.children![1]] });
            }}
            onDelete={() => {
              // When deleting first child, replace this split with second child
              onUpdate(node.children![1]);
            }}
            totalPanes={totalPanes}
            depth={depth + 1}
            horizontalDepth={childHorizontalDepth}
            verticalDepth={childVerticalDepth}
          />
        </div>
        <div className="flex-1 min-w-0 min-h-0">
          <LayoutPreview
            node={node.children[1]}
            onUpdate={(updated) => {
              onUpdate({ ...node, children: [node.children![0], updated] });
            }}
            onDelete={() => {
              // When deleting second child, replace this split with first child
              onUpdate(node.children![0]);
            }}
            totalPanes={totalPanes}
            depth={depth + 1}
            horizontalDepth={childHorizontalDepth}
            verticalDepth={childVerticalDepth}
          />
        </div>
      </div>
    );
  }

  // Pane node
  const info = getPaneTypeInfo(node.paneType || "shell");
  const Icon = info.icon;
  // Check if we can split in each direction
  const canSplitHorizontal = totalPanes < 8 && horizontalDepth < MAX_HORIZONTAL_SPLITS;
  const canSplitVertical = totalPanes < 8 && verticalDepth < MAX_VERTICAL_SPLITS;
  const canDelete = depth > 0 || totalPanes > 1;

  return (
    <>
      <motion.div
        onClick={handleClick}
        whileHover={{ scale: 1.01 }}
        className="w-full h-full rounded-lg cursor-pointer transition-all border-2 border-dashed border-transparent hover:border-[var(--color-highlight)] flex flex-col items-center justify-center gap-1 p-2"
        style={{ backgroundColor: `${info.color}15` }}
      >
        <Icon className="w-6 h-6" style={{ color: info.color }} />
        <span className="text-xs font-medium" style={{ color: info.color }}>
          {info.label}
        </span>
        {node.paneType === "custom" && (
          <input
            type="text"
            value={customCommandInput}
            onChange={(e) => handleCustomCommandChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            placeholder="command..."
            className="mt-1 w-full max-w-[120px] px-2 py-1 text-[10px] bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-center text-[var(--color-text)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-warning)]"
          />
        )}
        <span className="text-[10px] text-[var(--color-text-muted)] mt-1">Click to edit</span>
      </motion.div>

      <AnimatePresence>
        {menuPosition && (
          <PaneActionMenu
            position={menuPosition}
            onClose={() => setMenuPosition(null)}
            onSplitHorizontal={() => handleSplit("horizontal")}
            onSplitVertical={() => handleSplit("vertical")}
            onSetType={handleSetType}
            onDelete={handleDelete}
            canSplitHorizontal={canSplitHorizontal}
            canSplitVertical={canSplitVertical}
            canDelete={canDelete}
            currentType={node.paneType}
          />
        )}
      </AnimatePresence>
    </>
  );
}

export function LayoutEditor({
  isOpen,
  onClose,
  layouts,
  onChange,
  selectedLayoutId,
  onSelectLayout,
}: LayoutEditorProps) {
  const [localLayouts, setLocalLayouts] = useState<CustomLayoutConfig[]>(layouts);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // Sync with external value when opening
  useEffect(() => {
    if (isOpen) {
      setLocalLayouts(layouts.length > 0 ? layouts : [createDefaultLayout()]);
    }
  }, [isOpen, layouts]);

  const currentLayout = localLayouts.find((l) => l.id === selectedLayoutId) || localLayouts[0];

  const addLayout = () => {
    const newLayout = createDefaultLayout();
    setLocalLayouts([...localLayouts, newLayout]);
    onSelectLayout(newLayout.id);
  };

  const deleteLayout = (id: string) => {
    if (localLayouts.length <= 1) return;
    const newLayouts = localLayouts.filter((l) => l.id !== id);
    setLocalLayouts(newLayouts);
    if (selectedLayoutId === id) {
      onSelectLayout(newLayouts[0]?.id || null);
    }
  };

  const updateLayout = (id: string, updates: Partial<CustomLayoutConfig>) => {
    setLocalLayouts(localLayouts.map((l) => (l.id === id ? { ...l, ...updates } : l)));
  };

  const startEditName = (layout: CustomLayoutConfig) => {
    setEditingNameId(layout.id);
    setEditingName(layout.name);
  };

  const finishEditName = () => {
    if (editingNameId && editingName.trim()) {
      updateLayout(editingNameId, { name: editingName.trim() });
    }
    setEditingNameId(null);
  };

  const handleSave = () => {
    onChange(localLayouts);
    onClose();
  };

  if (!isOpen) return null;

  const paneCount = currentLayout ? countPanes(currentLayout.root) : 0;

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />

        {/* Dialog */}
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="relative w-full max-w-4xl bg-[var(--color-bg)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
            <div>
              <h2 className="text-lg font-semibold text-[var(--color-text)]">Custom Layouts</h2>
              <p className="text-xs text-[var(--color-text-muted)]">
                Click on a pane to split or change its type (max 8 panes)
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-[var(--color-bg-secondary)] transition-colors"
            >
              <X className="w-5 h-5 text-[var(--color-text-muted)]" />
            </button>
          </div>

          {/* Content */}
          <div className="flex h-[500px]">
            {/* Left: Layout List */}
            <div className="w-64 border-r border-[var(--color-border)] p-4 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-[var(--color-text-muted)]">Layouts</span>
                <Button variant="ghost" size="sm" onClick={addLayout}>
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto">
                {localLayouts.map((layout) => {
                  const isSelected = layout.id === (selectedLayoutId || localLayouts[0]?.id);
                  const isEditing = editingNameId === layout.id;
                  const count = countPanes(layout.root);

                  return (
                    <div
                      key={layout.id}
                      onClick={() => !isEditing && onSelectLayout(layout.id)}
                      className={`p-3 rounded-lg cursor-pointer transition-all
                        ${isSelected
                          ? "bg-[var(--color-highlight)]/10 border border-[var(--color-highlight)]"
                          : "bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)]"
                        }`}
                    >
                      <div className="flex items-center gap-2">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={finishEditName}
                            onKeyDown={(e) => e.key === "Enter" && finishEditName()}
                            autoFocus
                            className="flex-1 px-2 py-1 text-sm bg-[var(--color-bg)] border border-[var(--color-highlight)] rounded
                              text-[var(--color-text)] focus:outline-none"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <span className={`flex-1 text-sm font-medium truncate ${isSelected ? "text-[var(--color-highlight)]" : "text-[var(--color-text)]"}`}>
                              {layout.name}
                            </span>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                startEditName(layout);
                              }}
                              className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] transition-colors"
                            >
                              <Pencil className="w-3 h-3 text-[var(--color-text-muted)]" />
                            </button>
                            {localLayouts.length > 1 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteLayout(layout.id);
                                }}
                                className="p-1 rounded hover:bg-[var(--color-error)]/10 transition-colors"
                              >
                                <Trash2 className="w-3 h-3 text-[var(--color-error)]" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      <div className="text-[10px] text-[var(--color-text-muted)] mt-1">
                        {count} pane{count !== 1 ? "s" : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Layout Editor */}
            <div className="flex-1 p-6 flex flex-col">
              <div className="flex items-center justify-between mb-4">
                <div className="text-sm text-[var(--color-text-muted)]">
                  <span className="font-medium text-[var(--color-text)]">{currentLayout?.name}</span>
                  <span className="ml-2">({paneCount}/8 panes)</span>
                </div>
              </div>

              {/* Layout Preview */}
              <div className="flex-1 bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border)] p-3">
                {currentLayout && (
                  <LayoutPreview
                    node={currentLayout.root}
                    onUpdate={(root) => updateLayout(currentLayout.id, { root })}
                    totalPanes={paneCount}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSave}>
              Save Layouts
            </Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

// Helper to convert old format to new format (for compatibility)
export function migrateLayoutConfig(old: unknown): CustomLayoutConfig[] {
  // If already in new format
  if (Array.isArray(old)) {
    return old as CustomLayoutConfig[];
  }
  // Create default
  return [createDefaultLayout()];
}

// Export for use in SettingsPage
export { createDefaultLayout, countPanes };
