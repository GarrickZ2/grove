import { useState, type CSSProperties } from "react";
import { requestComputerPermission, type ComputerPermission } from "../../../api/browser";
import { Globe } from "lucide-react";
import { InstallExtensionDialog } from "../../../components/Config/InstallExtensionDialog";
import { ConfirmDialog } from "../../../components/Dialogs/ConfirmDialog";
import { Button, Group, Lead, Row, Segmented, Toggle } from "../../ui";
import { ACCESS_OPTIONS, access, type Access } from "./access";
import type { SettingsPageProps } from "./types";
import { errorText, useComputerPermissions } from "./useComputerPermissions";

function PermissionRow({
  title,
  description,
  state,
  onSetUp,
}: {
  title: string;
  description: string;
  state: string;
  onSetUp: () => void;
}) {
  const granted = state === "granted";
  return (
    <Row title={title} description={description}>
      <span
        className={`oui-status${granted ? "" : " is-off"}`}
        style={{ "--oui-status": `var(--color-${granted ? "success" : "error"})` } as CSSProperties}
      >
        <i />
        {granted ? "Allowed" : "Not allowed"}
      </span>
      {granted ? null : (
        <Button variant="primary" onClick={onSetUp}>
          Set Up
        </Button>
      )}
    </Row>
  );
}

/** Part of the Agents page: which browser agents use and what they may do. */
export function BrowserControlGroup({ settings }: SettingsPageProps) {
  const {
    browserControlEnabled,
    setBrowserControlEnabled,
    browserControlAutoGroups,
    setBrowserControlAutoGroups,
    browserPersonalAllowed,
    setBrowserPersonalAllowed,
    browserSensitiveTools,
    setBrowserSensitiveTools,
    computerUseAllowed,
    setComputerUseAllowed,
    browserPersonalBypass,
    setBrowserPersonalBypass,
    computerUseBypass,
    setComputerUseBypass,
    extensionStatus,
    extensionConnected,
    extensionCurrent,
    extensionNeedsUpdate,
    extensionStatusLabel,
    extensionStatusColor,
  } = settings;
  const [installOpen, setInstallOpen] = useState(false);
  const computerPermissions = useComputerPermissions(computerUseAllowed);
  const setUpPermission = (permission: ComputerPermission) => {
    requestComputerPermission(permission).catch((cause) => computerPermissions.setError(errorText(cause)));
  };
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const setPersonalAccess = (value: Access) => {
    setBrowserPersonalAllowed(value !== "off");
    setBrowserPersonalBypass(value === "allow");
  };
  const setComputerAccess = (value: Access) => {
    setComputerUseAllowed(value !== "off");
    setComputerUseBypass(value === "allow");
  };

  const companionDetail = extensionStatus?.updateRequired
    ? `Connected Companion is incompatible${extensionStatus.installedVersion ? ` (v${extensionStatus.installedVersion})` : ""}. Install v${extensionStatus.requiredVersion}, then reload it in your browser's extensions page.`
    : extensionStatus?.updateAvailable
      ? `Companion v${extensionStatus.installedVersion ?? "unknown"} is connected; v${extensionStatus.requiredVersion} is bundled with Grove. Update and reload it in your browser.`
      : extensionStatus?.compatible
        ? undefined
        : extensionConnected
          ? "Checking compatibility…"
          : undefined;

  return (
    <>
      <Group title="Browser control" anchorId="browser">
        <Row title="Allow AI browser action">
          <Toggle checked={browserControlEnabled} onChange={setBrowserControlEnabled} label="Allow AI browser action" />
        </Row>
        <Row
          dim={!browserControlEnabled}
          title="Your browser"
          description="An agent here can act as you on any site you're logged in to."
        >
          <Segmented
            value={access(browserPersonalAllowed, browserPersonalBypass)}
            options={ACCESS_OPTIONS}
            onChange={setPersonalAccess}
            ariaLabel="Your browser"
            size="sm"
          />
        </Row>
        {browserControlEnabled && browserPersonalAllowed ? (
          <>
            <Row
              title="Sensitive tools in your browser"
              description="Cookies, storage, network traffic, console logs and page scripts."
            >
              <Toggle
                checked={browserSensitiveTools}
                onChange={(checked) => {
                  if (checked) setConfirmSensitive(true);
                  else setBrowserSensitiveTools(false);
                }}
                label="Sensitive tools in your browser"
              />
            </Row>
            <Row
              title="Tab groups organizer"
              description="In your browser, collect tabs opened by agents into a tab group for each task."
            >
              <Toggle
                checked={browserControlAutoGroups}
                onChange={setBrowserControlAutoGroups}
                label="Tab groups organizer"
              />
            </Row>
            <Row
              leading={<Lead><Globe /></Lead>}
              title="Grove Companion"
              description={companionDetail}
            >
              <span
                className={`oui-status${extensionConnected ? "" : " is-off"}`}
                style={{ "--oui-status": `var(--color-${extensionStatusColor})` } as CSSProperties}
              >
                <i className={extensionCurrent ? "ost-pulse" : undefined} />
                {extensionStatusLabel}
              </span>
              <Button variant={extensionNeedsUpdate ? "primary" : "secondary"} onClick={() => setInstallOpen(true)}>
                {extensionNeedsUpdate ? "Update" : extensionConnected ? "Reinstall" : "Install"}
              </Button>
            </Row>
          </>
        ) : null}
      </Group>

      <Group title="Computer use" anchorId="computer">
        <Row
          title="Your computer"
          description="An agent here can see your screen and operate any app, as you can."
        >
          <Segmented
            value={access(computerUseAllowed, computerUseBypass)}
            options={ACCESS_OPTIONS}
            onChange={setComputerAccess}
            ariaLabel="Your computer"
            size="sm"
          />
        </Row>
        {computerUseAllowed && computerPermissions.error ? (
          <Row title="macOS permissions" description={computerPermissions.error} />
        ) : null}
        {computerUseAllowed && computerPermissions.permissions ? (
          <>
            <PermissionRow
              title="Accessibility"
              description="Lets agents read and operate the controls in apps."
              state={computerPermissions.permissions.accessibility}
              onSetUp={() => setUpPermission("accessibility")}
            />
            <PermissionRow
              title="Screen Recording"
              description="Lets agents see what is on your screen."
              state={computerPermissions.permissions.screenRecording}
              onSetUp={() => setUpPermission("screenRecording")}
            />
          </>
        ) : null}
      </Group>

      {installOpen ? <InstallExtensionDialog onClose={() => setInstallOpen(false)} /> : null}
      {confirmSensitive ? (
        <ConfirmDialog
          isOpen
          title="Allow sensitive tools in your browser?"
          message="Agents could read cookies, saved logins, and request headers from sites you are signed in to, and run scripts in those pages. A malicious page can trick an agent into misusing this, so anything it reads may end up in the conversation."
          confirmLabel="Allow sensitive tools"
          variant="danger"
          onConfirm={() => {
            setBrowserSensitiveTools(true);
            setConfirmSensitive(false);
          }}
          onCancel={() => setConfirmSensitive(false)}
        />
      ) : null}
    </>
  );
}
