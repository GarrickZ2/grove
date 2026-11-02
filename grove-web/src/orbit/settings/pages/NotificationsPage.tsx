import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Send, Volume2 } from "lucide-react";
import { Combobox } from "../../../components/ui";
import { useTheme } from "../../../context";
import { appIconAssetUrl } from "../../../data/appIcons";
import {
  previewNotificationSound,
  requestBrowserNotificationPermission,
  sendTestNotification,
  type TestNotificationOutcome,
} from "../../../notifications/desktopNotifier";
import { soundOptions } from "../../../components/Config/settingsConstants";
import { clampRetentionValue, RETENTION_MAX, RETENTION_MIN } from "../../../components/Config/notificationRetention";
import { Block, Button, Group, KeyRecorder, Row, Segmented, Toggle } from "../../ui";
import type { SettingsPageProps } from "./types";

type PreviewKind = "permission" | "elicitation" | "done";

/** Sample copy for the in-page preview banner. Nothing is sent. */
const PREVIEW_COPY: Record<PreviewKind, { title: string; body: string }> = {
  permission: { title: "Permission required", body: "An agent is waiting for your approval to run a tool." },
  elicitation: { title: "Input requested", body: "An agent needs you to answer a form or open a link." },
  done: { title: "Turn completed", body: "An agent finished responding to your prompt." },
};

type TestState = "idle" | "sending" | TestNotificationOutcome | "error";

const TEST_FEEDBACK: Partial<Record<TestState, { text: string; error?: boolean }>> = {
  sending: { text: "Sending…" },
  sent: { text: "Sent" },
  disabled: { text: "System notifications are off", error: true },
  blocked: { text: "Blocked by the browser", error: true },
  unavailable: { text: "Restart Grove to enable test notifications", error: true },
  error: { text: "Couldn’t send the test", error: true },
};

/** "Send test": one clearly labelled notification through the real pipeline. */
function SendTestButton({ disabled }: { disabled: boolean }) {
  const [state, setState] = useState<TestState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const send = async () => {
    window.clearTimeout(timer.current);
    setState("sending");
    let next: TestState;
    try {
      next = await sendTestNotification();
    } catch {
      next = "error";
    }
    setState(next);
    timer.current = window.setTimeout(() => setState("idle"), next === "sent" ? 2500 : 5000);
  };
  const feedback = TEST_FEEDBACK[state];
  return (
    <>
      {feedback ? (
        <span className={`ost-test-note${feedback.error ? " is-error" : ""}`} role="status">{feedback.text}</span>
      ) : null}
      <Button variant="secondary" size="sm" disabled={disabled || state === "sending"} onClick={() => void send()}>
        <Send />Send test
      </Button>
    </>
  );
}

function Dot({ tone }: { tone: "warn" | "info" | "accent" }) {
  const color = tone === "warn" ? "var(--o-warn)" : tone === "info" ? "var(--o-info)" : "var(--o-accent)";
  return <span className="ost-glow-dot" style={{ "--dot": color } as CSSProperties} aria-hidden="true" />;
}

interface SoundPickerProps {
  label: string;
  enabled: boolean;
  sound: string;
  onEnabledChange: (enabled: boolean) => void;
  onSoundChange: (sound: string) => void;
}

function SoundPicker({ label, enabled, sound, onEnabledChange, onSoundChange }: SoundPickerProps) {
  return (
    <span className="ost-sound">
      <span className="ost-sound-picker">
        <Combobox
          options={soundOptions}
          value={enabled ? sound : "none"}
          onChange={(value) => {
            if (value === "none") { onEnabledChange(false); return; }
            onEnabledChange(true);
            onSoundChange(value);
          }}
          placeholder="Sound..."
          allowCustom={false}
          size="compact"
        />
      </span>
      <Button
        variant="ghost"
        iconOnly
        disabled={!enabled}
        title={enabled ? "Preview sound" : "Select a sound to preview"}
        aria-label={`Preview ${label} sound`}
        onClick={() => void previewNotificationSound(sound)}
      >
        <Volume2 />
      </Button>
    </span>
  );
}

export function NotificationsPage({ settings }: SettingsPageProps) {
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
  const { theme, appIcon } = useTheme();
  const [preview, setPreview] = useState<{ kind: PreviewKind; count: number } | null>(null);
  const showPreview = (kind: PreviewKind) => setPreview((current) => ({ kind, count: (current?.count ?? 0) + 1 }));

  const toggleCategory = (kind: PreviewKind, setter: (value: boolean) => void) => (value: boolean) => {
    setter(value);
    if (value) showPreview(kind);
  };
  const banner = preview ? PREVIEW_COPY[preview.kind] : null;

  return (
    <>
      <Group title="Channels" anchorId="channels">
        {systemNotifEnabled ? (
          <Block>
            <div className="ost-desk" aria-label="Notification preview">
              <span className="ost-desk-note">Preview only · turn on an event below to see it. Nothing is sent.</span>
              {preview && banner ? (
                <div key={preview.count} className="ost-banner" role="img" aria-label={`Preview: ${banner.title}`}>
                  <img src={appIconAssetUrl(appIcon, theme.isLight)} alt="" />
                  <span className="ost-banner-copy">
                    <b>Grove<span>Preview</span></b>
                    <span className="ost-banner-title">{banner.title}</span>
                    <span className="ost-banner-body">{banner.body}</span>
                  </span>
                </div>
              ) : null}
            </div>
          </Block>
        ) : (
          <p className="ost-desk-off">System notifications are off, so there are no banners to preview.</p>
        )}
        <Row title="System notifications" description="Native OS banners and sounds for agent events.">
          <Toggle
            checked={systemNotifEnabled}
            label="System notifications"
            onChange={(enabled) => {
              setSystemNotifEnabled(enabled);
              if (enabled) void requestBrowserNotificationPermission();
            }}
          />
        </Row>
        <Row
          dim={!systemNotifEnabled}
          title="Test notification"
          description="Sends one banner and sound with your settings. No task is affected."
        >
          <SendTestButton disabled={!systemNotifEnabled} />
        </Row>
        <Row title="Menu bar" description="Persistent popover anchored to the menu bar icon.">
          <Toggle checked={trayEnabled} onChange={setTrayEnabled} label="Menu bar" />
        </Row>
      </Group>

      <Group title="System notifications" hint={systemNotifEnabled ? undefined : "Turned off"} anchorId="system">
        <Row
          dim={!systemNotifEnabled}
          leading={<Dot tone="warn" />}
          title="Permission required"
          description="When the agent needs your approval for an action."
        >
          {systemNotifShowPermission ? (
            <SoundPicker
              label="Permission required"
              enabled={hooksPermissionSoundEnabled}
              sound={hooksPermissionSound}
              onEnabledChange={setHooksPermissionSoundEnabled}
              onSoundChange={setHooksPermissionSound}
            />
          ) : null}
          <Toggle
            checked={systemNotifShowPermission}
            onChange={toggleCategory("permission", setSystemNotifShowPermission)}
            label="Notify when permission is required"
            disabled={!systemNotifEnabled}
          />
        </Row>
        <Row
          dim={!systemNotifEnabled}
          leading={<Dot tone="info" />}
          title="Input requested"
          description="When the agent presents an elicitation form or URL."
        >
          <Toggle
            checked={systemNotifShowElicitation}
            onChange={toggleCategory("elicitation", setSystemNotifShowElicitation)}
            label="Notify when input is requested"
            disabled={!systemNotifEnabled}
          />
        </Row>
        <Row
          dim={!systemNotifEnabled}
          leading={<Dot tone="accent" />}
          title="Turn completed"
          description="When the agent finishes responding to a prompt."
        >
          {systemNotifShowDone ? (
            <SoundPicker
              label="Turn completed"
              enabled={hooksResponseSoundEnabled}
              sound={hooksResponseSound}
              onEnabledChange={setHooksResponseSoundEnabled}
              onSoundChange={setHooksResponseSound}
            />
          ) : null}
          <Toggle
            checked={systemNotifShowDone}
            onChange={toggleCategory("done", setSystemNotifShowDone)}
            label="Notify when a turn completes"
            disabled={!systemNotifEnabled}
          />
        </Row>
      </Group>

      <Group
        title="Menu bar"
        hint={trayEnabled ? undefined : "Turned off"}
        anchorId="menubar"
        footnote="Disabling the tray takes effect on next Grove launch."
      >
        <Row dim={!trayEnabled} leading={<Dot tone="warn" />} title="Permission required" description="Pending tool-call approvals.">
          <Toggle checked={trayShowPermission} onChange={setTrayShowPermission} label="Show permission requests in the menu bar" disabled={!trayEnabled} />
        </Row>
        <Row dim={!trayEnabled} leading={<Dot tone="accent" />} title="Turn completed" description="Hooks fired by finished agent turns.">
          <Toggle checked={trayShowDone} onChange={setTrayShowDone} label="Show completed turns in the menu bar" disabled={!trayEnabled} />
        </Row>
        <Row dim={!trayEnabled} leading={<Dot tone="info" />} title="Running session" description="Tasks actively processing a prompt.">
          <Toggle checked={trayShowRunning} onChange={setTrayShowRunning} label="Show running sessions in the menu bar" disabled={!trayEnabled} />
        </Row>
        {isTauriGui ? (
          <Row
            dim={!trayEnabled}
            title="Show or hide menu bar"
            description={menubarShortcutConflict
              ? <span className="ost-error">Already bound to the main window. Pick a different combination — the menu bar binding won’t register until you do.</span>
              : "Global shortcut for the menu bar popover."}
          >
            <KeyRecorder
              label="menu bar shortcut"
              value={menubarShortcut}
              recording={isRecordingMenubarShortcut}
              invalid={menubarShortcutConflict}
              onToggleRecording={() => setIsRecordingMenubarShortcut((value) => !value)}
              onClear={() => {
                setMenubarShortcut("");
                setIsRecordingMenubarShortcut(false);
              }}
            />
          </Row>
        ) : null}
        <Row
          dim={!trayEnabled}
          title="Done chat retention"
          description="Running and permission-required chats are never auto-pruned."
        >
          <Segmented
            ariaLabel="Done chat retention"
            value={trayDoneRetentionMode}
            options={[
              { value: "forever", label: "Keep forever" },
              { value: "expire", label: "Auto-expire" },
            ]}
            onChange={setTrayDoneRetentionMode}
          />
        </Row>
        {trayDoneRetentionMode === "expire" ? (
          <Row dim={!trayEnabled} title="Expire after" description="Done chats older than this are removed from the menu bar.">
            <input
              type="number"
              min={RETENTION_MIN}
              max={RETENTION_MAX}
              className="oui-field"
              aria-label="Done chat retention amount"
              value={trayDoneRetentionValue}
              onChange={(event) => {
                const next = clampRetentionValue(event.target.value);
                if (next !== null) setTrayDoneRetentionValue(next);
              }}
            />
            <Segmented
              ariaLabel="Done chat retention unit"
              value={trayDoneRetentionUnit}
              options={[
                { value: "hours", label: "Hours" },
                { value: "days", label: "Days" },
              ]}
              onChange={setTrayDoneRetentionUnit}
            />
          </Row>
        ) : null}
      </Group>
    </>
  );
}
