import { motion, AnimatePresence } from "framer-motion";
import { Clock, Keyboard, Volume2, X } from "lucide-react";
import { Combobox } from "../ui";
import {
  previewNotificationSound,
  requestBrowserNotificationPermission,
} from "../../notifications/desktopNotifier";
import { soundOptions } from "./settingsConstants";
import { clampRetentionValue } from "./notificationRetention";
import { NotifChannel, ToggleSwitch } from "./SettingsControls";
import type { SettingsState } from "./useSettingsState";

/** System notification events + sounds, and the menu bar channel. */
export function NotificationSettings({ settings }: { settings: SettingsState }) {
  const {
    systemNotifEnabled,
    setSystemNotifEnabled,
    systemNotifShowPermission,
    setSystemNotifShowPermission,
    systemNotifShowElicitation,
    setSystemNotifShowElicitation,
    systemNotifShowDone,
    setSystemNotifShowDone,
    hooksResponseSoundEnabled,
    setHooksResponseSoundEnabled,
    hooksResponseSound,
    setHooksResponseSound,
    hooksPermissionSoundEnabled,
    setHooksPermissionSoundEnabled,
    hooksPermissionSound,
    setHooksPermissionSound,
    trayEnabled,
    setTrayEnabled,
    trayShowPermission,
    setTrayShowPermission,
    trayShowDone,
    setTrayShowDone,
    trayShowRunning,
    setTrayShowRunning,
    menubarShortcut,
    setMenubarShortcut,
    isRecordingMenubarShortcut,
    setIsRecordingMenubarShortcut,
    menubarShortcutConflict,
    trayDoneRetentionMode,
    setTrayDoneRetentionMode,
    trayDoneRetentionValue,
    setTrayDoneRetentionValue,
    trayDoneRetentionUnit,
    setTrayDoneRetentionUnit,
    isTauriGui,
  } = settings;

  const menubarShortcutControl = isTauriGui ? (
    <div>
      <div className="flex items-center gap-2 mb-3 select-none">
        <Keyboard className="w-4 h-4 text-[var(--color-warning)]" />
        <span className="text-sm font-medium text-[var(--color-text)]">
          Show or Hide Menu bar
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div
          className={`flex h-10 min-w-0 flex-1 items-center rounded-lg border bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text)] ${
            menubarShortcutConflict
              ? "border-[var(--color-error)]/60"
              : "border-[var(--color-border)]"
          }`}
        >
          {isRecordingMenubarShortcut ? (
            <span className="text-[var(--color-warning)]">Press shortcut...</span>
          ) : menubarShortcut ? (
            menubarShortcut
          ) : (
            <span className="text-[var(--color-text-muted)]">Not set</span>
          )}
        </div>
        {menubarShortcut && (
          <button
            type="button"
            onClick={() => {
              setMenubarShortcut("");
              setIsRecordingMenubarShortcut(false);
            }}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-error)]/60 hover:text-[var(--color-error)]"
            title="Clear shortcut"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setIsRecordingMenubarShortcut((value) => !value)}
          className={`inline-flex h-10 shrink-0 items-center justify-center rounded-lg border px-3 text-xs font-medium transition-colors ${
            isRecordingMenubarShortcut
              ? "border-[var(--color-warning)] bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
              : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] hover:border-[var(--color-warning)]/50"
          }`}
        >
          {isRecordingMenubarShortcut ? "Cancel" : "Record"}
        </button>
      </div>
      {menubarShortcutConflict ? (
        <div className="mt-2 text-[11px] text-[var(--color-error)]">
          This shortcut is already bound to the main window. Pick a different
          combination — the menubar binding will not register until you do.
        </div>
      ) : null}
    </div>
    ) : null;
  const trayRetentionControl = (
    <div>
      <div className="flex items-center gap-2 mb-3 select-none">
        <Clock className="w-4 h-4 text-[var(--color-highlight)]" />
        <span className="text-sm font-medium text-[var(--color-text)]">
          Done chat retention
        </span>
      </div>
      <div className="space-y-2.5">
        {/* Mode toggle — "Keep forever" vs "Auto-expire after". Two equal
            chips so it reads as a question, not a checkbox. */}
        <div
          className="grid grid-cols-2 rounded-lg border p-0.5"
          style={{
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-bg-secondary)",
          }}
        >
          <button
            type="button"
            onClick={() => setTrayDoneRetentionMode("forever")}
            className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              color: trayDoneRetentionMode === "forever" ? "var(--color-highlight)" : "var(--color-text-muted)",
              backgroundColor: trayDoneRetentionMode === "forever" ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
            }}
          >
            Keep forever
          </button>
          <button
            type="button"
            onClick={() => setTrayDoneRetentionMode("expire")}
            className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
            style={{
              color: trayDoneRetentionMode === "expire" ? "var(--color-highlight)" : "var(--color-text-muted)",
              backgroundColor: trayDoneRetentionMode === "expire" ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
            }}
          >
            Auto-expire after…
          </button>
        </div>
        {trayDoneRetentionMode === "expire" ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={365}
              value={trayDoneRetentionValue}
              onChange={(e) => {
                const n = clampRetentionValue(e.target.value);
                if (n !== null) setTrayDoneRetentionValue(n);
              }}
              className="h-9 w-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 text-sm text-[var(--color-text)] focus:border-[var(--color-highlight)] focus:outline-none"
            />
            <div
              className="grid grid-cols-2 rounded-lg border p-0.5"
              style={{
                borderColor: "var(--color-border)",
                backgroundColor: "var(--color-bg-secondary)",
              }}
            >
              <button
                type="button"
                onClick={() => setTrayDoneRetentionUnit("hours")}
                className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  color: trayDoneRetentionUnit === "hours" ? "var(--color-highlight)" : "var(--color-text-muted)",
                  backgroundColor: trayDoneRetentionUnit === "hours" ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
                }}
              >
                Hours
              </button>
              <button
                type="button"
                onClick={() => setTrayDoneRetentionUnit("days")}
                className="rounded-md px-3 py-1 text-xs font-medium transition-colors"
                style={{
                  color: trayDoneRetentionUnit === "days" ? "var(--color-highlight)" : "var(--color-text-muted)",
                  backgroundColor: trayDoneRetentionUnit === "days" ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)" : "transparent",
                }}
              >
                Days
              </button>
            </div>
            <span className="text-xs text-[var(--color-text-muted)]">
              Running and permission-required chats are never auto-pruned.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
  const menubarExtraControl = menubarShortcutControl ? (
    <div className="space-y-4">
      {menubarShortcutControl}
      <div className="border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)]" />
      {trayRetentionControl}
    </div>
  ) : (
    trayRetentionControl
  );

  return (
    <div className="space-y-4">
      {/* System Notifications card — sound + banner per event type */}
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-semibold text-[var(--color-text)]">System Notifications</div>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">Native OS banner and sounds for agent events</div>
          </div>
          <ToggleSwitch
            checked={systemNotifEnabled}
            onChange={(enabled) => {
              setSystemNotifEnabled(enabled);
              if (enabled) void requestBrowserNotificationPermission();
            }}
          />
        </div>
        <AnimatePresence initial={false}>
          {systemNotifEnabled ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="mt-2 space-y-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] pt-3">
                {/* Permission required */}
                <div className="flex items-center gap-3">
                  <span className="flex-shrink-0 inline-block w-2 h-2 rounded-full bg-[var(--color-warning)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[var(--color-text)]">Permission required</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">When the agent needs your approval for an action</div>
                  </div>
                  <AnimatePresence initial={false}>
                    {systemNotifShowPermission && (
                      <motion.div
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden flex-shrink-0 flex items-center gap-1"
                      >
                        <div className="w-[140px]">
                          <Combobox
                            options={soundOptions}
                            value={hooksPermissionSoundEnabled ? hooksPermissionSound : "none"}
                            onChange={(value) => {
                              if (value === "none") { setHooksPermissionSoundEnabled(false); return; }
                              setHooksPermissionSoundEnabled(true);
                              setHooksPermissionSound(value);
                            }}
                            placeholder="Sound..."
                            allowCustom={false}
                          />
                        </div>
                        <button onClick={() => void previewNotificationSound(hooksPermissionSound)} title={!hooksPermissionSoundEnabled ? "Select a sound to preview" : "Preview sound"} disabled={!hooksPermissionSoundEnabled} className="h-8 w-8 flex-shrink-0 flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40 transition-colors">
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <ToggleSwitch checked={systemNotifShowPermission} onChange={setSystemNotifShowPermission} />
                </div>
                {/* Input requested */}
                <div className="flex items-center gap-3">
                  <span className="flex-shrink-0 inline-block w-2 h-2 rounded-full bg-[var(--color-info)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[var(--color-text)]">Input requested</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">When the agent presents an Elicitation form or URL</div>
                  </div>
                  <ToggleSwitch checked={systemNotifShowElicitation} onChange={setSystemNotifShowElicitation} />
                </div>
                {/* Turn completed */}
                <div className="flex items-center gap-3">
                  <span className="flex-shrink-0 inline-block w-2 h-2 rounded-full bg-[var(--color-highlight)]" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-[var(--color-text)]">Turn completed</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">When the agent finishes responding to a prompt</div>
                  </div>
                  <AnimatePresence initial={false}>
                    {systemNotifShowDone && (
                      <motion.div
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: "auto" }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden flex-shrink-0 flex items-center gap-1"
                      >
                        <div className="w-[140px]">
                          <Combobox
                            options={soundOptions}
                            value={hooksResponseSoundEnabled ? hooksResponseSound : "none"}
                            onChange={(value) => {
                              if (value === "none") { setHooksResponseSoundEnabled(false); return; }
                              setHooksResponseSoundEnabled(true);
                              setHooksResponseSound(value);
                            }}
                            placeholder="Sound..."
                            allowCustom={false}
                          />
                        </div>
                        <button onClick={() => void previewNotificationSound(hooksResponseSound)} title={!hooksResponseSoundEnabled ? "Select a sound to preview" : "Preview sound"} disabled={!hooksResponseSoundEnabled} className="h-8 w-8 flex-shrink-0 flex items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-40 transition-colors">
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                  <ToggleSwitch checked={systemNotifShowDone} onChange={setSystemNotifShowDone} />
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* Menu bar */}
      <NotifChannel
        title="Menu bar"
        subtitle="Persistent popover anchored to the menubar icon"
        enabled={trayEnabled}
        onEnabledChange={setTrayEnabled}
        showPermission={trayShowPermission}
        onShowPermissionChange={setTrayShowPermission}
        showDone={trayShowDone}
        onShowDoneChange={setTrayShowDone}
        showRunning={trayShowRunning}
        onShowRunningChange={setTrayShowRunning}
        extraControl={menubarExtraControl}
        note="Disabling the tray takes effect on next Grove launch."
      />
    </div>
  );
}
