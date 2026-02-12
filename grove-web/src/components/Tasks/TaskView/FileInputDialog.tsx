import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, FolderPlus, X } from "lucide-react";
import { Button, Input } from "../../ui";

interface FileInputDialogProps {
  isOpen: boolean;
  type: "file" | "directory";
  title: string;
  placeholder: string;
  defaultPath?: string;
  onClose: () => void;
  onSubmit: (path: string) => Promise<void>;
}

export function FileInputDialog({
  isOpen,
  type,
  title,
  placeholder,
  defaultPath = "",
  onClose,
  onSubmit,
}: FileInputDialogProps) {
  const [path, setPath] = useState(defaultPath);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (isOpen) {
      setPath(defaultPath);
      setError(null);
      setSubmitting(false);
    }
  }, [isOpen, defaultPath]);

  const handleSubmit = async () => {
    if (!path.trim()) {
      setError("Please enter a path");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await onSubmit(path.trim());
      setPath("");
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = () => {
    setPath("");
    setError(null);
    setSubmitting(false);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !submitting) {
      handleSubmit();
    }
  };

  const Icon = type === "file" ? FileText : FolderPlus;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/50 z-50"
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md"
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[var(--color-info)]/10">
                    <Icon className="w-5 h-5 text-[var(--color-info)]" />
                  </div>
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">{title}</h2>
                </div>
                <button
                  onClick={handleClose}
                  disabled={submitting}
                  className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors disabled:opacity-50"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className="px-5 py-4 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-muted)] mb-2">
                    Path
                  </label>
                  <Input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={placeholder}
                    autoFocus
                    disabled={submitting}
                  />
                  {error && (
                    <p className="mt-2 text-sm text-[var(--color-error)]">
                      {error}
                    </p>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 px-5 py-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
                <Button variant="secondary" onClick={handleClose} disabled={submitting}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleSubmit}
                  disabled={!path.trim() || submitting}
                >
                  {submitting ? "Creating..." : "Create"}
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
