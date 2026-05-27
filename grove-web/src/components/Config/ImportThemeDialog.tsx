import { useState } from "react";
import { X, Download } from "lucide-react";
import { Button, DialogShell } from "../ui";
import { type Theme } from "../../context/ThemeContext";

interface ImportThemeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onImport: (theme: Theme) => void;
}

export function ImportThemeDialog({ isOpen, onClose, onImport }: ImportThemeDialogProps) {
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    try {
      const parsed = JSON.parse(json);
      
      // Basic validation
      if (!parsed.name || !parsed.colors || typeof parsed.isLight !== 'boolean') {
        throw new Error("Invalid theme format. Missing required fields.");
      }

      const newTheme: Theme = {
        ...parsed,
        id: `custom-${Date.now()}`, // Generate new ID to avoid collisions
        isCustom: true
      };

      onImport(newTheme);
      onClose();
      setJson("");
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to parse theme JSON.");
    }
  };

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-lg">
      <div className="bg-[var(--color-bg)] rounded-xl overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <Download className="w-4 h-4 text-[var(--color-highlight)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text)]">Import Theme</h2>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-[var(--color-bg-secondary)] rounded-lg transition-colors text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-[var(--color-text-muted)]">Paste the theme JSON string below to import it into your collection.</p>
          
          <textarea
            value={json}
            onChange={(e) => {
              setJson(e.target.value);
              setError(null);
            }}
            placeholder='{ "name": "My Shared Theme", "colors": { ... }, "isLight": true }'
            className="w-full h-48 px-3 py-2 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[10px] font-mono text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] resize-none"
          />

          {error && (
            <div className="p-2 rounded bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 text-[10px] text-[var(--color-error)] font-medium">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} size="sm">Cancel</Button>
          <Button variant="primary" onClick={handleImport} disabled={!json.trim()} size="sm">Import Theme</Button>
        </div>
      </div>
    </DialogShell>
  );
}
