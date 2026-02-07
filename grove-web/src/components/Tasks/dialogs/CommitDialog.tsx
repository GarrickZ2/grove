import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, GitCommit } from "lucide-react";
import { Button } from "../../ui";

interface CommitDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCommit: (message: string) => void;
}

export function CommitDialog({ isOpen, onClose, onCommit }: CommitDialogProps) {
  const [message, setMessage] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      onCommit(message.trim());
      setMessage("");
      onClose();
    }
  };

  const handleClose = () => {
    setMessage("");
    onClose();
  };

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
            data-hotkeys-dialog
          />

          {/* Dialog */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md z-50"
          >
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-xl overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
                <div className="flex items-center gap-2">
                  <GitCommit className="w-5 h-5 text-[var(--color-highlight)]" />
                  <h2 className="text-lg font-semibold text-[var(--color-text)]">
                    Commit Changes
                  </h2>
                </div>
                <button
                  onClick={handleClose}
                  className="p-1 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <form onSubmit={handleSubmit} className="p-4">
                <div className="space-y-4">
                  <div>
                    <label
                      htmlFor="commit-message"
                      className="block text-sm font-medium text-[var(--color-text)] mb-1.5"
                    >
                      Commit Message
                    </label>
                    <textarea
                      id="commit-message"
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="Enter commit message..."
                      rows={4}
                      className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-highlight)] resize-none"
                      autoFocus
                    />
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-2 mt-4">
                  <Button variant="secondary" type="button" onClick={handleClose}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!message.trim()}>
                    <GitCommit className="w-4 h-4 mr-1.5" />
                    Commit
                  </Button>
                </div>
              </form>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
