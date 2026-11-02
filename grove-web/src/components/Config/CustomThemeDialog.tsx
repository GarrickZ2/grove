import { useState } from "react";
import { X, RotateCcw, MessageSquare, FileCode, CheckCircle2, AlertCircle, Info as InfoIcon, AlertTriangle, Palette } from "lucide-react";
import { Button, DialogShell, Input } from "../ui";
import { type Theme, builtInThemes, type ThemeColors } from "../../context/ThemeContext";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";
import { Button as OrbitButton } from "../../orbit/ui/Button";
import { DialogBody, DialogField, DialogFoot, DialogHead, DialogPanel } from "../../orbit/ui/Dialog";
import { Segmented } from "../../orbit/ui/Segmented";

interface CustomThemeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (theme: Theme) => void;
}

// Caller (SettingsPage) conditionally mounts this dialog only while isOpen,
// so useState initializers run fresh every open — no leakage from a previous
// Cancel.
export function CustomThemeDialog({ isOpen, onClose, onSave }: CustomThemeDialogProps) {
  const [name, setName] = useState("");
  const [isLight, setIsLight] = useState(false);
  const [colors, setColors] = useState<ThemeColors>(builtInThemes.find(t => t.id === "dark")!.colors);
  const orbit = useOrbitInterface();

  const handleBaseChange = (themeId: string) => {
    const base = builtInThemes.find(t => t.id === themeId);
    if (base) {
      setColors({ ...base.colors });
      setIsLight(base.isLight);
    }
  };

  // Toggle between light/dark templates. Picking Light flips to the default
  // light template; picking Dark flips to the default dark template. Otherwise
  // the user could see "Light Theme" selected while the preview still shows
  // dark colors.
  const handleModeToggle = (nextIsLight: boolean) => {
    handleBaseChange(nextIsLight ? "light" : "dark");
  };

  const updateColor = (key: keyof ThemeColors, value: string) => {
    setColors(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    if (!name.trim()) return;

    const newTheme: Theme = {
      // crypto.randomUUID avoids the same-millisecond Date.now() collision
      // when several themes are created back-to-back (drag-and-drop batch import).
      id: (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? `custom-${crypto.randomUUID()}`
        : `custom-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      name: name.trim(),
      isLight,
      isCustom: true,
      colors,
      accentPalette: [colors.highlight, colors.accent, colors.info],
    };

    onSave(newTheme);
    onClose();
    setName("");
  };

  const colorFields: { key: keyof ThemeColors; label: string }[] = [
    { key: "bg", label: "Background" },
    { key: "bgSecondary", label: "BG Secondary" },
    { key: "bgTertiary", label: "BG Tertiary" },
    { key: "border", label: "Border" },
    { key: "text", label: "Primary Text" },
    { key: "textMuted", label: "Muted Text" },
    { key: "highlight", label: "Highlight" },
    { key: "accent", label: "Accent" },
    { key: "info", label: "Info" },
    { key: "success", label: "Success" },
    { key: "warning", label: "Warning" },
    { key: "error", label: "Error" },
  ];

  const preview = (
    <div className="lg:col-span-8 flex flex-col gap-3">
       <label className="block text-[11px] font-bold text-[var(--color-text-muted)] uppercase tracking-[0.2em] ml-1">Live Interface Preview</label>
       <div 
         className="aspect-[16/10] rounded-2xl border-4 overflow-hidden flex flex-col shadow-2xl transition-colors duration-500" 
         style={{ backgroundColor: colors.bg, borderColor: colors.border }}
       >
         {/* Mini Header */}
         <div className="h-8 border-b flex items-center px-3 gap-3 shrink-0" style={{ backgroundColor: colors.bgSecondary, borderColor: colors.border }}>
            <div className="flex gap-1.5">
              <div className="w-2 h-2 rounded-full opacity-20" style={{ backgroundColor: colors.text }} />
              <div className="w-2 h-2 rounded-full opacity-20" style={{ backgroundColor: colors.text }} />
              <div className="w-2 h-2 rounded-full opacity-20" style={{ backgroundColor: colors.text }} />
            </div>
            <div className="w-20 h-2.5 rounded-full opacity-10" style={{ backgroundColor: colors.text }} />
            <div className="ml-auto w-3 h-3 rounded" style={{ backgroundColor: colors.highlight }} />
         </div>

         <div className="flex-1 flex overflow-hidden">
            {/* Mini Sidebar */}
            <div className="w-16 border-r flex flex-col p-2 gap-3 shrink-0" style={{ backgroundColor: colors.bgTertiary, borderColor: colors.border }}>
               {[1, 2, 3, 4].map(i => (
                 <div key={i} className={`w-full h-1.5 rounded-full ${i === 1 ? '' : 'opacity-10'}`} style={{ backgroundColor: i === 1 ? colors.highlight : colors.text }} />
               ))}
               <div className="mt-auto w-6 h-6 rounded-full mx-auto shadow-sm" style={{ backgroundColor: colors.accent }} />
            </div>

            {/* Mini Main Content */}
            <div className="flex-1 flex flex-col p-4 gap-4 overflow-hidden">
               <div className="space-y-2">
                  <div className="flex items-center gap-2">
                     <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 shadow-sm" style={{ backgroundColor: `${colors.info}20` }}>
                        <MessageSquare className="w-3.5 h-3.5" style={{ color: colors.info }} />
                     </div>
                     <div className="w-32 h-3 rounded-lg" style={{ backgroundColor: colors.text }} />
                  </div>
                  <div className="pl-8 space-y-1.5">
                     <div className="w-full h-2 rounded opacity-40" style={{ backgroundColor: colors.textMuted }} />
                     <div className="w-[85%] h-2 rounded opacity-40" style={{ backgroundColor: colors.textMuted }} />
                     <div className="w-[60%] h-2 rounded opacity-40" style={{ backgroundColor: colors.textMuted }} />
                  </div>
               </div>

               {/* Status Badges Area */}
               <div className="grid grid-cols-2 gap-2 shrink-0">
                  <div className="p-2 rounded-lg border flex items-center gap-2" style={{ backgroundColor: `${colors.success}10`, borderColor: `${colors.success}30` }}>
                     <CheckCircle2 className="w-3 h-3" style={{ color: colors.success }} />
                     <div className="w-12 h-1.5 rounded-full opacity-60" style={{ backgroundColor: colors.success }} />
                  </div>
                  <div className="p-2 rounded-lg border flex items-center gap-2" style={{ backgroundColor: `${colors.error}10`, borderColor: `${colors.error}30` }}>
                     <AlertCircle className="w-3 h-3" style={{ color: colors.error }} />
                     <div className="w-12 h-1.5 rounded-full opacity-60" style={{ backgroundColor: colors.error }} />
                  </div>
                  <div className="p-2 rounded-lg border flex items-center gap-2" style={{ backgroundColor: `${colors.warning}10`, borderColor: `${colors.warning}30` }}>
                     <AlertTriangle className="w-3 h-3" style={{ color: colors.warning }} />
                     <div className="w-12 h-1.5 rounded-full opacity-60" style={{ backgroundColor: colors.warning }} />
                  </div>
                  <div className="p-2 rounded-lg border flex items-center gap-2" style={{ backgroundColor: `${colors.info}10`, borderColor: `${colors.info}30` }}>
                     <InfoIcon className="w-3 h-3" style={{ color: colors.info }} />
                     <div className="w-12 h-1.5 rounded-full opacity-60" style={{ backgroundColor: colors.info }} />
                  </div>
               </div>

               {/* Mini Editor/Terminal */}
               <div className="flex-1 rounded-xl border p-3 font-mono text-[9px] overflow-hidden shadow-inner" style={{ backgroundColor: colors.bgSecondary, borderColor: colors.border }}>
                  <div className="flex gap-2 mb-1.5">
                     <FileCode className="w-3 h-3" style={{ color: colors.info }} />
                     <span className="opacity-40" style={{ color: colors.text }}>query.graphql</span>
                  </div>
                  <div className="space-y-1">
                     <div className="flex gap-2"><span style={{ color: colors.info }}>query</span> <span style={{ color: colors.text }}>GetUsers</span> {'{'}</div>
                     <div className="flex gap-2 pl-4"><span style={{ color: colors.textMuted }}>users</span> {'{'}</div>
                     <div className="flex gap-2 pl-8"><span style={{ color: colors.highlight }}>id</span></div>
                     <div className="flex gap-2 pl-8"><span style={{ color: colors.highlight }}>name</span></div>
                     <div className="pl-4">{'}'}</div>
                     <div>{'}'}</div>
                  </div>
               </div>
            </div>
         </div>
       </div>
       <div className="flex items-center justify-center gap-6 mt-2 opacity-50">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm border" style={{ backgroundColor: colors.bg, borderColor: colors.border }} />
            <span className="text-[10px] font-medium" style={{ color: colors.textMuted }}>Base</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm border" style={{ backgroundColor: colors.bgSecondary, borderColor: colors.border }} />
            <span className="text-[10px] font-medium" style={{ color: colors.textMuted }}>Secondary</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: colors.highlight }} />
            <span className="text-[10px] font-medium" style={{ color: colors.textMuted }}>Main Accent</span>
          </div>
       </div>
    </div>
  );

  const colorGrid = (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-5 gap-y-4">
      {colorFields.map(field => (
        <div key={field.key} className="group space-y-1.5">
          <label className="text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-tight block transition-colors group-focus-within:text-[var(--color-highlight)]">
            {field.label}
          </label>
          <div className="relative flex items-center">
            <div className="absolute left-2 w-4 h-4 rounded-md border border-[var(--color-border)] shadow-sm pointer-events-none" style={{ backgroundColor: colors[field.key] }} />
            <input
              type="color"
              value={colors[field.key]}
              onChange={e => updateColor(field.key, e.target.value)}
              className="absolute left-2 w-4 h-4 opacity-0 cursor-pointer"
            />
            <input
              type="text"
              value={colors[field.key]}
              onChange={e => updateColor(field.key, e.target.value)}
              className="w-full pl-8 pr-2 py-1.5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[10px] font-mono font-bold text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] transition-all uppercase"
            />
          </div>
        </div>
      ))}
    </div>
  );

  if (orbit) {
    return (
      <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-4xl">
        <DialogPanel>
          <DialogHead title="Create custom theme" description="Design your own personalized color palette" />
          <DialogBody className="oui-dlg-theme oui-dlg-scroll">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              <div className="lg:col-span-4 oui-dlg-stack">
                <DialogField label="Theme name">
                  <input className="oui-field" placeholder="Name your creation..." value={name} onChange={e => setName(e.target.value)} />
                </DialogField>
                <DialogField label="Categorization" as="div">
                  <Segmented
                    value={isLight ? "light" : "dark"}
                    options={[{ value: "light", label: "Light theme" }, { value: "dark", label: "Dark theme" }]}
                    onChange={(value) => handleModeToggle(value === "light")}
                    ariaLabel="Theme mode"
                    block
                  />
                </DialogField>
                <DialogField label="Base template" as="div">
                  <div className="oui-dlg-chips">
                    {builtInThemes.filter(t => t.isLight === isLight).map(t => (
                      <button key={t.id} type="button" onClick={() => handleBaseChange(t.id)} className="oui-dlg-chip">
                        <span className="oui-dlg-swatch" style={{ backgroundColor: t.colors.highlight }} />
                        <span className="oui-truncate">{t.name}</span>
                      </button>
                    ))}
                  </div>
                </DialogField>
              </div>
              {preview}
            </div>
            <div className="oui-dlg-section">
              <div className="oui-dlg-section-head">
                <div>
                  <h3>Color management</h3>
                  <p>Precision control over Grove&apos;s palette</p>
                </div>
                <OrbitButton variant="ghost" size="sm" onClick={() => handleBaseChange(isLight ? "light" : "dark")}>
                  <RotateCcw /> Reset to template
                </OrbitButton>
              </div>
              {colorGrid}
            </div>
          </DialogBody>
          <DialogFoot>
            <OrbitButton variant="ghost" onClick={onClose}>Cancel</OrbitButton>
            <OrbitButton variant="primary" onClick={handleSave} disabled={!name.trim()}>Create theme</OrbitButton>
          </DialogFoot>
        </DialogPanel>
      </DialogShell>
    );
  }

  return (
    <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-4xl">
      <div className="bg-[var(--color-bg)] rounded-xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)]">
              <Palette className="w-4 h-4 text-[var(--color-highlight)]" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--color-text)]">Create Custom Theme</h2>
              <p className="text-[11px] text-[var(--color-text-muted)]">Design your own personalized color palette</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-[var(--color-bg-secondary)] rounded-lg transition-colors text-[var(--color-text-muted)]">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-8">
          {/* Top Section: Form + Mini Preview */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Form Side */}
            <div className="lg:col-span-4 space-y-6">
              <Input
                label="Theme Name"
                placeholder="Name your creation..."
                value={name}
                onChange={e => setName(e.target.value)}
              />

              <div className="space-y-3">
                <label className="block text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-tight">Categorization</label>
                <div className="flex p-0.5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg">
                  {[
                    { label: "Light Theme", value: true },
                    { label: "Dark Theme", value: false },
                  ].map(opt => (
                    <button
                      key={opt.label}
                      onClick={() => handleModeToggle(opt.value)}
                      className={`flex-1 py-1 px-2 rounded-md text-[10px] font-bold transition-all
                        ${isLight === opt.value
                          ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm border border-[var(--color-border)]"
                          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                        }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                <label className="block text-[10px] font-bold text-[var(--color-text-muted)] uppercase tracking-tight">Base Template</label>
                <div className="grid grid-cols-2 gap-1">
                  {builtInThemes.filter(t => t.isLight === isLight).map(t => (
                    <button
                      key={t.id}
                      onClick={() => handleBaseChange(t.id)}
                      className="px-2 py-1.5 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[9px] font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-all text-left truncate flex items-center gap-1.5"
                    >
                      <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: t.colors.highlight }} />
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {preview}
          </div>

          <div className="space-y-6 pt-4 border-t border-[var(--color-border)]">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-[var(--color-text)]">Color Management</h3>
                <p className="text-[11px] text-[var(--color-text-muted)]">Precision control over Grove's palette</p>
              </div>
              <button 
                onClick={() => handleBaseChange(isLight ? "light" : "dark")}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] border border-transparent hover:border-[var(--color-border)] transition-all"
              >
                <RotateCcw className="w-3.5 h-3.5" /> RESET TO TEMPLATE
              </button>
            </div>

            {colorGrid}
          </div>
        </div>

        <div className="px-5 py-3 bg-[var(--color-bg-secondary)] border-t border-[var(--color-border)] flex justify-end gap-2 shrink-0">
          <Button variant="secondary" onClick={onClose} size="sm">Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!name.trim()} size="sm">Create Theme</Button>
        </div>
      </div>
    </DialogShell>
  );
}
