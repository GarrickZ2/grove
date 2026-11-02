import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { AUTOLINK_PRESETS } from "../../../components/Config/settingsConstants";
import { Block, Button, Group, Row, Toggle } from "../../ui";
import type { SettingsPageProps } from "./types";

/** Appends a trimmed pattern unless it is empty or already present. */
function addPattern(patterns: string[], draft: string): string[] {
  const pattern = draft.trim();
  if (!pattern || patterns.includes(pattern)) return patterns;
  return [...patterns, pattern];
}

export function WorktreesPage({ settings }: SettingsPageProps) {
  const {
    autoLinkPatterns,
    setAutoLinkPatterns,
    indexingEnabled,
    setIndexingEnabled,
    indexingDisabledLangs,
    setIndexingDisabledLangs,
    indexingSupportedLangs,
  } = settings;
  const [draft, setDraft] = useState("");
  const presets = AUTOLINK_PRESETS.filter((preset) => !autoLinkPatterns.includes(preset));

  const submitDraft = () => {
    const next = addPattern(autoLinkPatterns, draft);
    if (next !== autoLinkPatterns) setAutoLinkPatterns(next);
    setDraft("");
  };

  return (
    <>
      <Group
        title="AutoLink"
        hint="Symlinked into every new worktree, so heavy gitignored folders aren’t rebuilt."
        anchorId="autolink"
        footnote={<><code>*</code> matches any characters except <code>/</code>, <code>**</code> any path segment, <code>?</code> a single character.</>}
      >
        {autoLinkPatterns.map((pattern, index) => (
          <div key={index} className="ost-pat">
            <input
              className="ost-pat-input oui-mono"
              value={pattern}
              aria-label={`Pattern ${index + 1}`}
              placeholder="e.g., node_modules or **/dist"
              onChange={(event) => {
                const next = [...autoLinkPatterns];
                next[index] = event.target.value;
                setAutoLinkPatterns(next);
              }}
            />
            <Button
              variant="ghost"
              iconOnly
              aria-label={`Remove ${pattern || "pattern"}`}
              onClick={() => setAutoLinkPatterns(autoLinkPatterns.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        {autoLinkPatterns.length === 0 ? (
          <Row title="No patterns yet" description="Add one below, or start from a preset." />
        ) : null}
        <div className="ost-addrow">
          <input
            className="oui-field oui-mono"
            type="text"
            aria-label="New pattern"
            placeholder="Glob, e.g. packages/*/build"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitDraft();
              }
            }}
          />
          <Button onClick={submitDraft} disabled={!draft.trim()}>
            <Plus />
            Add
          </Button>
        </div>
        {presets.length > 0 ? (
          <Block>
            <span className="oui-row-desc">Quick add</span>
            <div className="ost-chips">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className="ost-chip oui-mono"
                  onClick={() => setAutoLinkPatterns(addPattern(autoLinkPatterns, preset))}
                >
                  <Plus className="ost-chip-plus" aria-hidden="true" />
                  {preset}
                </button>
              ))}
            </div>
          </Block>
        ) : null}
      </Group>

      <Group title="Code Indexing" anchorId="indexing">
        <Row
          title="Enable indexing"
          description="Powers cmd+click navigation. Turning it off affects newly opened tasks; running tasks keep their index until Grove restarts."
        >
          <Toggle checked={indexingEnabled} onChange={setIndexingEnabled} label="Enable indexing" />
        </Row>
        <Block dim={!indexingEnabled}>
          <span className="oui-row-title">Languages</span>
          <span className="oui-row-desc">
            Files in these languages are indexed during build. Turning one off stops new scans; cached rows stay until the next reindex.
          </span>
          {indexingSupportedLangs.length === 0 ? (
            <p className="oui-footnote">No supported languages reported by the server.</p>
          ) : (
            <div className="ost-chips">
              {indexingSupportedLangs.map((lang) => {
                const on = !indexingDisabledLangs.includes(lang.id);
                return (
                  <button
                    key={lang.id}
                    type="button"
                    aria-pressed={on}
                    className={`ost-chip${on ? " is-on" : ""}`}
                    onClick={() => setIndexingDisabledLangs((prev) =>
                      prev.includes(lang.id) ? prev.filter((id) => id !== lang.id) : [...prev, lang.id],
                    )}
                  >
                    {on ? (
                      <span className="ost-chip-check" aria-hidden="true"><Check /></span>
                    ) : (
                      <Plus className="ost-chip-plus" aria-hidden="true" />
                    )}
                    {lang.display_name}
                  </button>
                );
              })}
            </div>
          )}
        </Block>
      </Group>
    </>
  );
}
