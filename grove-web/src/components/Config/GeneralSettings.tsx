import { Code, Info, Keyboard, LayoutGrid, Sparkles, Terminal, X } from "lucide-react";
import { AppPicker, ideAppOptions, terminalAppOptions } from "../ui";
import { useBuddyMotionSetting } from "./useBuddyMotionSetting";
import { useInterfaceSetting } from "./useInterfaceSetting";
import { isIdeApp, isTerminalApp } from "./settingsConstants";
import type { SettingsState } from "./useSettingsState";

/** Default IDE / terminal apps, window shortcut, interface and workspace layout. */
export function GeneralSettings({ settings }: { settings: SettingsState }) {
  const { current: currentInterface, switchTo: switchInterface } = useInterfaceSetting();
  const { motion, setMotion } = useBuddyMotionSetting();
  const {
    serverPlatform,
    ideCommand,
    setIdeCommand,
    terminalCommand,
    setTerminalCommand,
    applications,
    isLoadingApps,
    workspaceLayout,
    setWorkspaceLayout,
    showHideWindowShortcut,
    setShowHideWindowShortcut,
    isRecordingWindowShortcut,
    setIsRecordingWindowShortcut,
    isTauriGui,
  } = settings;

  const windowShortcutControl = isTauriGui ? (
    <div>
      <div className="flex items-center gap-2 mb-3 select-none">
        <Keyboard className="w-4 h-4 text-[var(--color-highlight)]" />
        <span className="text-sm font-medium text-[var(--color-text)]">Show or Hide Window</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex h-10 min-w-0 flex-1 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)]">
          {isRecordingWindowShortcut ? (
            <span className="text-[var(--color-highlight)]">Press shortcut...</span>
          ) : showHideWindowShortcut ? (
            showHideWindowShortcut
          ) : (
            <span className="text-[var(--color-text-muted)]">Not set</span>
          )}
        </div>
        {showHideWindowShortcut && (
          <button
            type="button"
            onClick={() => {
              setShowHideWindowShortcut("");
              setIsRecordingWindowShortcut(false);
            }}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-error)]/60 hover:text-[var(--color-error)]"
            title="Clear shortcut"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setIsRecordingWindowShortcut((value) => !value)}
          className={`inline-flex h-10 shrink-0 items-center justify-center rounded-lg border px-3 text-xs font-medium transition-colors ${
            isRecordingWindowShortcut
              ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-highlight)]"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:border-[var(--color-highlight)]/50"
          }`}
        >
          {isRecordingWindowShortcut ? "Cancel" : "Record"}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-6">
      {serverPlatform === null ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <p className="text-sm text-[var(--color-text-muted)]">Detecting platform...</p>
        </div>
      ) : serverPlatform !== "macos" ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <Info className="w-5 h-5 text-[var(--color-text-muted)] shrink-0" />
          <p className="text-sm text-[var(--color-text-muted)]">
            IDE and terminal application detection is not yet supported on {
              serverPlatform === "windows" ? "Windows"
              : serverPlatform === "linux" ? "Linux"
              : serverPlatform
            }.
          </p>
        </div>
      ) : (
        <>
          {/* Default IDE */}
          <div>
            <div className="flex items-center gap-2 mb-3 select-none">
              <Code className="w-4 h-4 text-[var(--color-info)]" />
              <span className="text-sm font-medium text-[var(--color-text)]">Default IDE</span>
            </div>
            <AppPicker
              options={ideAppOptions}
              value={ideCommand}
              onChange={setIdeCommand}
              placeholder="Select IDE..."
              applications={applications}
              isLoadingApps={isLoadingApps}
              appFilter={isIdeApp}
            />
          </div>

          {/* Default Terminal */}
          <div>
            <div className="flex items-center gap-2 mb-3 select-none">
              <Terminal className="w-4 h-4 text-[var(--color-accent)]" />
              <span className="text-sm font-medium text-[var(--color-text)]">Default Terminal</span>
            </div>
            <AppPicker
              options={terminalAppOptions}
              value={terminalCommand}
              onChange={setTerminalCommand}
              placeholder="System Default"
              applications={applications}
              isLoadingApps={isLoadingApps}
              appFilter={isTerminalApp}
            />
          </div>
        </>
      )}

      {windowShortcutControl}

      {isTauriGui && <div>
        <div className="flex items-center gap-2 mb-3 select-none">
          <Sparkles className="w-4 h-4 text-[var(--color-info)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">Mini Buddy Motion</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {(["lively", "standard"] as const).map((value) => <button key={value} type="button" aria-pressed={motion === value} onClick={() => setMotion(value)} className={`p-3 rounded-lg border text-left transition-colors ${motion === value ? "border-[var(--color-highlight)] bg-[var(--color-bg-secondary)]" : "border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]"}`}>
            <div className="text-xs font-medium text-[var(--color-text)] mb-1">{value === "lively" ? "Lively" : "Standard"}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">{value === "lively" ? "Eyes follow your cursor. Uses a little more power" : "Reacts when you hover over it"}</div>
          </button>)}
        </div>
      </div>}

      {/* Interface selection is saved independently from other settings. */}
      <div>
        <div className="flex items-center gap-2 mb-3 select-none">
          <LayoutGrid className="w-4 h-4 text-[var(--color-info)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">Interface</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button type="button" aria-pressed={currentInterface === "orbit"} onClick={() => switchInterface("orbit")} className={`p-3 rounded-lg border text-left ${currentInterface === "orbit" ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"}`}>
            <div className="text-xs font-medium text-[var(--color-text)] mb-1">Orbit</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Start with a conversation and follow your work</div>
          </button>
          <button type="button" aria-pressed={currentInterface !== "orbit"} onClick={() => switchInterface("workbench")} className={`p-3 rounded-lg border text-left ${currentInterface !== "orbit" ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"}`}>
            <div className="text-xs font-medium text-[var(--color-text)] mb-1">Workbench</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Projects, tasks, and panels in a flexible workspace</div>
          </button>
        </div>
      </div>

      {/* Workspace Layout */}
      <div>
        <div className="flex items-center gap-2 mb-3 select-none">
          <LayoutGrid className="w-4 h-4 text-[var(--color-warning)]" />
          <span className="text-sm font-medium text-[var(--color-text)]">Workspace Layout</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => setWorkspaceLayout("ide")}
            className={`p-3 rounded-lg border text-left transition-all ${
              workspaceLayout === "ide"
                ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
            }`}
          >
            <div className="text-xs font-medium text-[var(--color-text)] mb-1">Agent Layout</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Fixed panels with Chat-centric view</div>
          </button>
          <button
            onClick={() => setWorkspaceLayout("flex")}
            className={`p-3 rounded-lg border text-left transition-all ${
              workspaceLayout === "flex"
                ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
            }`}
          >
            <div className="text-xs font-medium text-[var(--color-text)] mb-1">Free Layout</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">Drag and arrange panels freely</div>
          </button>
        </div>
      </div>
    </div>
  );
}
