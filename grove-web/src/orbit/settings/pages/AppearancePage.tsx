import { useEffect, useState, type DragEvent } from "react";
import { Check, Download, Loader2, Plus, Share2, Trash2 } from "lucide-react";
import { useTheme } from "../../../context";
import type { Theme } from "../../../context/ThemeContext";
import { APP_ICON_DESIGNS, appIconAssetUrl } from "../../../data/appIcons";
import { CustomThemeDialog } from "../../../components/Config/CustomThemeDialog";
import { useAppIconSelection } from "../../../components/Config/useAppIconSelection";
import { useThemeSettings } from "../../../components/Config/useThemeSettings";
import { Block, Button, Group, Row, Segmented } from "../../ui";

export interface AppearancePageProps {
  /** Preview a theme on the Settings page only; null reverts. Never saved. */
  onPreviewTheme: (theme: Theme | null) => void;
}

type ColorMode = "auto" | "light" | "dark";

interface ThemeGridProps {
  themes: Theme[];
  selectedId: string;
  onSelect: (id: string) => void;
  onPreview: (theme: Theme | null) => void;
  onExport: (theme: Theme) => void;
  onDelete: (theme: Theme) => void;
}

function ThemeGrid({ themes, selectedId, onSelect, onPreview, onExport, onDelete }: ThemeGridProps) {
  return (
    <div
      className="ost-themes"
      onMouseLeave={() => onPreview(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onPreview(null);
      }}
    >
      {themes.map((theme) => {
        const selected = theme.id === selectedId;
        const c = theme.colors;
        return (
          <div key={theme.id} className={`ost-theme${selected ? " is-sel" : ""}`}>
            <button
              type="button"
              className="ost-theme-pick"
              aria-pressed={selected}
              aria-label={`${theme.name} theme`}
              onMouseEnter={() => onPreview(theme)}
              onFocus={() => onPreview(theme)}
              onClick={() => {
                onPreview(null);
                onSelect(theme.id);
              }}
            >
              <span className="ost-tprev" style={{ background: c.bg, boxShadow: `inset 0 0 0 1px ${c.border}` }} aria-hidden="true">
                <span className="ost-tside" style={{ background: c.bgSecondary }}>
                  <span className="ost-tbar" style={{ background: c.text, width: "80%" }} />
                  <span className="ost-tbar" style={{ background: c.textMuted, width: "60%" }} />
                  <span className="ost-tbar" style={{ background: c.textMuted, width: "70%" }} />
                </span>
                <span className="ost-tmain">
                  <span className="ost-tbar" style={{ background: c.text, width: "55%" }} />
                  <span className="ost-tbar" style={{ background: c.textMuted, width: "85%" }} />
                  <span className="ost-tbar" style={{ background: c.highlight, width: "30%", opacity: 1 }} />
                </span>
              </span>
              <span className="ost-tname">{theme.name}</span>
              {selected ? <span className="ost-tcheck" aria-hidden="true"><Check /></span> : null}
            </button>
            {theme.isCustom ? (
              <span className="ost-theme-actions">
                <Button variant="ghost" iconOnly title="Export theme" aria-label={`Export ${theme.name}`} onClick={() => onExport(theme)}>
                  <Share2 />
                </Button>
                <Button variant="ghost" iconOnly title="Delete theme" aria-label={`Delete ${theme.name}`} onClick={() => onDelete(theme)}>
                  <Trash2 />
                </Button>
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AppearancePage({ onPreviewTheme }: AppearancePageProps) {
  const { mode, lightThemeId, darkThemeId, themes } = useTheme();
  const {
    handleModeChange,
    handleLightThemeChange,
    handleDarkThemeChange,
    handleSaveCustomTheme,
    handleImportFile,
    handleExportTheme,
    importThemeFile,
    deleteCustomTheme,
  } = useThemeSettings();
  const icon = useAppIconSelection();
  const [createOpen, setCreateOpen] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Never leave a preview applied after leaving the page.
  useEffect(() => () => onPreviewTheme(null), [onPreviewTheme]);

  const lightThemes = themes.filter((theme) => theme.isLight);
  const darkThemes = themes.filter((theme) => !theme.isLight);
  const deleteTheme = (theme: Theme) => {
    onPreviewTheme(null);
    deleteCustomTheme(theme);
  };
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files?.[0];
      if (file) importThemeFile(file);
    },
  };

  return (
    <>
      <Group title="Mode" anchorId="mode">
        <Row title="Color mode" description="Auto follows your system.">
          <Segmented<ColorMode>
            ariaLabel="Color mode"
            value={mode}
            options={[
              { value: "auto", label: "Auto" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={handleModeChange}
          />
        </Row>
      </Group>

      <Group
        title="Light theme"
        hint={mode === "dark" ? "Used when the color mode is Light or Auto." : "Hover to preview on this page."}
        anchorId="light"
      >
        <Block>
          <ThemeGrid
            themes={lightThemes}
            selectedId={lightThemeId}
            onSelect={handleLightThemeChange}
            onPreview={onPreviewTheme}
            onExport={handleExportTheme}
            onDelete={deleteTheme}
          />
        </Block>
      </Group>

      <Group
        title="Dark theme"
        hint={mode === "light" ? "Used when the color mode is Dark or Auto." : "Hover to preview on this page."}
        anchorId="dark"
      >
        <Block>
          <ThemeGrid
            themes={darkThemes}
            selectedId={darkThemeId}
            onSelect={handleDarkThemeChange}
            onPreview={onPreviewTheme}
            onExport={handleExportTheme}
            onDelete={deleteTheme}
          />
        </Block>
      </Group>

      <Group title="Custom themes" anchorId="custom">
        <div className={`ost-dropzone${dragging ? " is-dragging" : ""}`} {...dropProps}>
          <Row
            title={dragging ? "Drop to import" : "Import or create a theme"}
            description="Import a .grovetheme or .json file, or drop one here. Custom themes appear in the grids above."
          >
            <input
              type="file"
              id="ost-theme-import"
              className="ost-hidden"
              accept=".grovetheme,.json"
              onChange={handleImportFile}
            />
            <Button onClick={() => document.getElementById("ost-theme-import")?.click()}>
              <Download />
              Import
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus />
              Create
            </Button>
          </Row>
        </div>
      </Group>

      <Group
        title="App icon"
        hint="Follows the theme’s light or dark variant."
        anchorId="icon"
        footnote={icon.error ? <span className="ost-error" role="alert">{icon.error}</span> : undefined}
      >
        <Block>
          <div role="group" aria-label="Application icon designs" aria-busy={icon.saving} className="ost-icons">
            {APP_ICON_DESIGNS.map((design) => {
              const active = icon.appIcon === design.id;
              return (
                <button
                  key={design.id}
                  type="button"
                  disabled={icon.saving}
                  aria-pressed={active}
                  aria-label={`${design.name} application icon`}
                  title={design.description}
                  onClick={() => void icon.select(design.id)}
                  className={`ost-icon${active ? " is-sel" : ""}`}
                >
                  <img src={appIconAssetUrl(design.id, icon.isLight)} alt="" />
                  <span>{design.name}</span>
                  {active ? <span className="ost-tcheck" aria-hidden="true"><Check /></span> : null}
                </button>
              );
            })}
          </div>
          {icon.saving ? (
            <p role="status" className="oui-footnote ost-saving"><Loader2 className="ost-spin" />Saving icon…</p>
          ) : null}
        </Block>
      </Group>

      {createOpen ? (
        <CustomThemeDialog isOpen={createOpen} onClose={() => setCreateOpen(false)} onSave={handleSaveCustomTheme} />
      ) : null}
    </>
  );
}
