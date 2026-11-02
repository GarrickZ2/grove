import { useState } from "react";
import { motion } from "framer-motion";
import { Check, Download, Plus, Share2, Trash2 } from "lucide-react";
import { Button } from "../ui";
import { useTheme } from "../../context";
import { AppIconSettings } from "./AppIconSettings";
import { CustomThemeDialog } from "./CustomThemeDialog";
import { useThemeSettings } from "./useThemeSettings";

/** Theme mode, light/dark theme grids, import/create/export and app icon. */
export function AppearanceSettings() {
  const { mode, lightThemeId, darkThemeId, themes } = useTheme();
  const {
    handleModeChange,
    handleLightThemeChange,
    handleDarkThemeChange,
    handleSaveCustomTheme,
    importThemeFile,
    deleteCustomTheme,
    handleImportFile,
    handleExportTheme,
  } = useThemeSettings();
  const [isCustomThemeDialogOpen, setIsCustomThemeDialogOpen] = useState(false);
  const [isDraggingTheme, setIsDraggingTheme] = useState(false);

  return (
    <>
      <div className="space-y-8">
        {/* Mode Selection & Action Header */}
        <div 
          onDragOver={(e) => { e.preventDefault(); setIsDraggingTheme(true); }}
          onDragLeave={() => setIsDraggingTheme(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDraggingTheme(false);
            const file = e.dataTransfer.files?.[0];
            if (file) importThemeFile(file);
          }}
          className={`flex flex-col gap-4 transition-all ${isDraggingTheme ? 'p-4 rounded-xl border-2 border-dashed border-[var(--color-highlight)] bg-[var(--color-highlight)]/5' : ''}`}
        >
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider select-none">
              {isDraggingTheme ? "Drop file to import theme" : "Appearance Mode"}
            </div>
            <div className="flex items-center gap-2">
              <input 
                type="file" 
                id="theme-import-input" 
                className="hidden" 
                accept=".grovetheme,.json" 
                onChange={handleImportFile} 
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => document.getElementById('theme-import-input')?.click()}
              >
                <Download className="w-3.5 h-3.5 mr-1.5" /> Import
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsCustomThemeDialogOpen(true)}
              >
                <Plus className="w-3.5 h-3.5 mr-1.5" /> Create
              </Button>
            </div>
          </div>
          <div className="flex p-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl max-w-sm">
            {(["auto", "light", "dark"] as const).map((m) => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                className={`flex-1 py-1.5 text-xs font-semibold uppercase tracking-wider rounded-lg transition-all
                  ${mode === m 
                    ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]" 
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Light Themes */}
        {(mode === "auto" || mode === "light") && (
          <div className="space-y-4">
            <div className="text-xs font-bold text-[var(--color-text-muted)] uppercase tracking-wider">
              {mode === "auto" ? "Preferred Light Theme" : "Light Themes"}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {themes.filter(t => t.isLight).map((t) => (
                <motion.button
                  key={t.id}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleLightThemeChange(t.id)}
                  className={`relative p-3 rounded-lg border text-center transition-all group
                    ${lightThemeId === t.id
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                      : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                    }`}
                >
                  {lightThemeId === t.id && (
                    <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                  <div className="flex gap-1 mb-2 justify-center">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.highlight }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.accent }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.info }} />
                  </div>
                  <div className="text-xs font-medium text-[var(--color-text)] truncate">{t.name}</div>
                  {t.isCustom && (
                    <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleExportTheme(t);
                        }}
                        title="Export Theme"
                        className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] bg-[var(--color-bg)]/80 backdrop-blur rounded-md border border-[var(--color-border)] shadow-sm"
                      >
                        <Share2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCustomTheme(t);
                        }}
                        title="Delete Theme"
                        className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-error)] bg-[var(--color-bg)]/80 backdrop-blur rounded-md border border-[var(--color-border)] shadow-sm"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Dark Themes */}
        {(mode === "auto" || mode === "dark") && (
          <div>
            <div className="text-sm font-medium text-[var(--color-text-muted)] mb-3 select-none">
              {mode === "auto" ? "Preferred Dark Theme" : "Dark Themes"}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {themes.filter(t => !t.isLight).map((t) => (
                <motion.button
                  key={t.id}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => handleDarkThemeChange(t.id)}
                  className={`relative p-3 rounded-lg border text-center transition-all group
                    ${darkThemeId === t.id
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                      : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                    }`}
                >
                  {darkThemeId === t.id && (
                    <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                  <div className="flex gap-1 mb-2 justify-center">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.highlight }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.accent }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.info }} />
                  </div>
                  <div className="text-xs font-medium text-[var(--color-text)] truncate">{t.name}</div>
                  {t.isCustom && (
                    <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleExportTheme(t);
                        }}
                        title="Export Theme"
                        className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] bg-[var(--color-bg)]/80 backdrop-blur rounded-md border border-[var(--color-border)] shadow-sm"
                      >
                        <Share2 className="w-3 h-3" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteCustomTheme(t);
                        }}
                        title="Delete Theme"
                        className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-error)] bg-[var(--color-bg)]/80 backdrop-blur rounded-md border border-[var(--color-border)] shadow-sm"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </motion.button>
              ))}
            </div>
          </div>
        )}
        <AppIconSettings />
      </div>
      {/* Custom Theme Dialog — conditionally mounted so it picks up fresh
          default state every time the user opens it (no stale name/colors
          from a previous Cancel). */}
      {isCustomThemeDialogOpen && (
        <CustomThemeDialog
          isOpen={isCustomThemeDialogOpen}
          onClose={() => setIsCustomThemeDialogOpen(false)}
          onSave={handleSaveCustomTheme}
        />
      )}
    </>
  );
}
