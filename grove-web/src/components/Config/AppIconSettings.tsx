import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useTheme } from "../../context/ThemeContext";
import { APP_ICON_DESIGNS, appIconAssetUrl } from "../../data/appIcons";

export function AppIconSettings() {
  const { theme, appIcon, setApplicationIcon } = useTheme();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const select = async (style: string) => {
    if (saving || style === appIcon) return;
    setSaving(true);
    setError(null);
    try {
      await setApplicationIcon(style);
    } catch (error) {
      const detail = error && typeof error === "object" && "message" in error ? String(error.message) : "Please try again.";
      setError(`Could not save the application icon. ${detail}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[var(--color-text-muted)]">Application icon</h3>
        <span className="text-xs text-[var(--color-text-muted)]">Follows theme</span>
      </div>
      <div role="group" aria-label="Application icon designs" aria-busy={saving} className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {APP_ICON_DESIGNS.map((design) => {
          const active = appIcon === design.id;
          return (
            <button key={design.id} type="button" disabled={saving} aria-pressed={active} aria-label={`${design.name} application icon`}
              onClick={() => void select(design.id)}
              className={`relative flex min-w-0 flex-col items-center gap-1 rounded-lg border px-2 py-2 text-center transition-colors disabled:cursor-wait ${active ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]"}`}
            >
              <img src={appIconAssetUrl(design.id, theme.isLight)} alt="" className="h-8 w-8 shrink-0" />
              <span className="w-full truncate text-xs font-medium text-[var(--color-text)]">{design.name}</span>
              {active && <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-highlight)]"><Check aria-hidden="true" className="h-2.5 w-2.5 text-white" /></span>}
            </button>
          );
        })}
      </div>
      {saving && <p role="status" className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" />Saving icon…</p>}
      {error && <p role="alert" className="text-xs text-[var(--color-error)]">{error}</p>}
    </div>
  );
}
