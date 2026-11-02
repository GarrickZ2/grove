import { useState } from "react";
import { useTheme } from "../../context/ThemeContext";

/** Selected application icon plus a guarded save with saving / error state. */
export function useAppIconSelection() {
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
  return { appIcon, isLight: theme.isLight, saving, error, select };
}
