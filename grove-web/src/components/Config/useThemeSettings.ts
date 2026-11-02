import { useCallback, type ChangeEvent } from "react";
import { useTheme, useBanner } from "../../context";
import { type Theme } from "../../context/ThemeContext";

/** Theme mode / selection / import / export actions shared by settings UIs. */
export function useThemeSettings() {
  const { customThemes, lightThemeId, darkThemeId, setAppearance } = useTheme();
  const { showBanner } = useBanner();

  // Handle theme change with immediate save
  const handleModeChange = useCallback((newMode: "auto" | "light" | "dark") => {
    setAppearance({ mode: newMode });
  }, [setAppearance]);

  const handleLightThemeChange = useCallback((id: string) => {
    setAppearance({ lightThemeId: id });
  }, [setAppearance]);

  const handleDarkThemeChange = useCallback((id: string) => {
    setAppearance({ darkThemeId: id });
  }, [setAppearance]);

  const handleSaveCustomTheme = useCallback((newTheme: Theme) => {
    setAppearance({ customThemes: [...customThemes, newTheme] });
  }, [customThemes, setAppearance]);

  const processThemeData = useCallback((text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object') throw new Error("Theme file is not a JSON object.");
      if (!parsed.name || typeof parsed.name !== 'string') throw new Error("Missing 'name'.");
      if (typeof parsed.isLight !== 'boolean') throw new Error("Missing 'isLight' boolean.");
      const c = parsed.colors;
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error("Missing 'colors' object.");
      // Validate the 12 required color tokens are present and look like CSS colors.
      // Anything that slips through here propagates to style.setProperty("--color-X", undefined)
      // which silently sets the var to the string "undefined" and breaks the UI.
      const requiredColors: (keyof Theme["colors"])[] = [
        "bg", "bgSecondary", "bgTertiary", "border", "text", "textMuted",
        "highlight", "accent", "success", "warning", "error", "info",
      ];
      // Browser CSS.supports parses the value the same way it'd parse it in a
      // stylesheet — rejects "rgb(/*x*/)" and friends that the previous loose
      // regex accepted. Also reject var(...) refs: those are accepted by
      // CSS.supports but, when assigned to a --color-X var, create a self-
      // referential cycle that silently breaks the palette.
      const isValidColor = (v: string): boolean => {
        // Reject var() anywhere (also blocks `/* */ var(--x)` since regex
        // doesn't anchor to start). var() references would silently create
        // a self-referential cycle when assigned to --color-X.
        if (/var\s*\(/i.test(v)) return false;
        // Reject CSS-wide keywords that CSS.supports accepts but are
        // meaningless / fragile as concrete color values for our palette.
        if (/^(inherit|currentcolor|transparent|initial|unset|revert|revert-layer)$/i.test(v)) return false;
        if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function') {
          return CSS.supports("color", v);
        }
        return /^(#[0-9a-f]{3,8}|rgb[a]?\([\d\s,./%]+\)|hsl[a]?\([\d\s,./%deg]+\)|oklch\([\d\s,./%]+\)|[a-z]+)$/i.test(v);
      };
      for (const key of requiredColors) {
        const v = (c as Record<string, unknown>)[key];
        if (typeof v !== 'string' || !isValidColor(v.trim())) {
          throw new Error(`Invalid color value for '${key}'.`);
        }
      }
      // accentPalette is consumed via spread into newTheme; if user supplies
      // a non-array or non-string entries, downstream consumers (getProjectStyle
      // etc.) silently default away. Validate before propagating.
      if (parsed.accentPalette !== undefined) {
        if (!Array.isArray(parsed.accentPalette) || parsed.accentPalette.length === 0) {
          throw new Error("'accentPalette' must be a non-empty array.");
        }
        for (const entry of parsed.accentPalette) {
          if (typeof entry !== 'string' || !isValidColor(entry.trim())) {
            throw new Error("'accentPalette' contains an invalid color.");
          }
        }
      }
      const newTheme: Theme = {
        ...parsed,
        id: (typeof crypto !== "undefined" && "randomUUID" in crypto)
          ? `custom-${crypto.randomUUID()}`
          : `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        isCustom: true
      };
      setAppearance({ customThemes: [...customThemes, newTheme] });
      showBanner(`Theme "${newTheme.name}" imported successfully!`, "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      showBanner(`Import failed: ${message}`, "error");
    }
  }, [customThemes, setAppearance, showBanner]);

  const handleImportFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input's value so picking the same file twice (e.g. after a
    // parse error → user edits file externally → re-tries) fires onChange again.
    const inputEl = e.target;
    if (file) {
      const reader = new FileReader();
      reader.onload = (re) => {
        const text = re.target?.result as string;
        processThemeData(text);
        inputEl.value = "";
      };
      reader.onerror = () => { inputEl.value = ""; };
      reader.readAsText(file);
    } else {
      inputEl.value = "";
    }
  };

  const handleExportTheme = useCallback((themeToExport: Theme) => {
    const { id: _id, isCustom: _isCustom, ...rest } = themeToExport;
    void _id;
    void _isCustom;
    const json = JSON.stringify(rest, null, 2);
    
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${themeToExport.name.replace(/\s+/g, "_").toLowerCase()}.grovetheme`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showBanner(`Theme "${themeToExport.name}" exported to file!`, "success");
    } catch (err) {
      showBanner(`Download failed: ${err}`, "error");
    }
  }, [showBanner]);

  // A deleted custom theme that is currently chosen falls back to the built-in default.
  const deleteCustomTheme = useCallback((themeToDelete: Theme) => {
    const newCustoms = customThemes.filter((ct: Theme) => ct.id !== themeToDelete.id);
    if (themeToDelete.isLight) {
      setAppearance({ customThemes: newCustoms, lightThemeId: lightThemeId === themeToDelete.id ? "light" : lightThemeId });
    } else {
      setAppearance({ customThemes: newCustoms, darkThemeId: darkThemeId === themeToDelete.id ? "dark" : darkThemeId });
    }
  }, [customThemes, lightThemeId, darkThemeId, setAppearance]);

  // Dropped theme files go through the same validation as the file picker.
  const importThemeFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (re) => processThemeData(re.target?.result as string);
    reader.readAsText(file);
  }, [processThemeData]);

  return {
    deleteCustomTheme,
    importThemeFile,
    handleModeChange,
    handleLightThemeChange,
    handleDarkThemeChange,
    handleSaveCustomTheme,
    processThemeData,
    handleImportFile,
    handleExportTheme,
  };
}
