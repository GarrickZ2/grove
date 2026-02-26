import { useState, useEffect } from "react";
import { Edit3, X } from "lucide-react";
import { Button, Input } from "../ui";
import { DialogShell } from "../ui/DialogShell";

interface RenameBranchDialogProps {
  isOpen: boolean;
  branchName: string;
  onClose: () => void;
  onRename: (oldName: string, newName: string) => void;
}

export function RenameBranchDialog({
  isOpen,
  branchName,
  onClose,
  onRename,
}: RenameBranchDialogProps) {
  const [newName, setNewName] = useState(branchName);

  useEffect(() => {
    setNewName(branchName);
  }, [branchName]);

  const handleRename = () => {
    if (newName.trim() && newName !== branchName) {
      onRename(branchName, newName.trim());
    }
  };

  const handleClose = () => {
    setNewName(branchName);
    onClose();
  };

  return (
    <DialogShell isOpen={isOpen} onClose={handleClose}>
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-warning)]/10">
                    <Edit3 className="w-5 h-5 text-[var(--color-warning)]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">Rename Branch</h2>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                {/* Current Name */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Current name
                  </label>
                  <div className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm text-[var(--color-text-muted)]">
                    {branchName}
                  </div>
                </div>

                {/* New Name */}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    New name
                  </label>
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Enter new branch name"
                    autoFocus
                  />
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={handleClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleRename}
                  disabled={!newName.trim() || newName === branchName}
                >
                  Rename
                </Button>
              </div>
      </div>
    </DialogShell>
  );
}
