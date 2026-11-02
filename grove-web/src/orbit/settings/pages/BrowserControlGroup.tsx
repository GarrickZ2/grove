import { useState, type CSSProperties } from "react";
import { Globe } from "lucide-react";
import { InstallExtensionDialog } from "../../../components/Config/InstallExtensionDialog";
import { Button, Group, Lead, Row, Toggle } from "../../ui";
import type { SettingsPageProps } from "./types";

/** Part of the Agents page: what agents may do in your Chrome browser. */
export function BrowserControlGroup({ settings }: SettingsPageProps) {
  const {
    browserControlEnabled,
    setBrowserControlEnabled,
    browserControlAutoGroups,
    setBrowserControlAutoGroups,
    extensionStatus,
    extensionConnected,
    extensionCurrent,
    extensionNeedsUpdate,
    extensionStatusLabel,
    extensionStatusColor,
  } = settings;
  const [installOpen, setInstallOpen] = useState(false);

  const companionDetail = extensionStatus?.updateRequired
    ? `Connected Companion is incompatible${extensionStatus.installedVersion ? ` (v${extensionStatus.installedVersion})` : ""}. Install v${extensionStatus.requiredVersion}, then click Reload in chrome://extensions/.`
    : extensionStatus?.updateAvailable
      ? `Companion v${extensionStatus.installedVersion ?? "unknown"} is connected; v${extensionStatus.requiredVersion} is bundled with Grove. Update and reload it in Chrome.`
      : extensionStatus?.compatible
        ? `Companion v${extensionStatus.installedVersion} is installed, compatible, and connected.`
        : extensionConnected
          ? "Companion connected; checking protocol compatibility…"
          : "Not installed? The bundled installer walks you through it — pick a folder and Grove handles the rest.";

  return (
    <>
      <Group title="Browser control" hint="Agents drive Chrome through the Grove Companion." anchorId="browser">
        <Row
          title="Allow AI browser action"
          description="Let agents open, read, and interact with pages in your active Chrome browser."
        >
          <Toggle checked={browserControlEnabled} onChange={setBrowserControlEnabled} label="Allow AI browser action" />
        </Row>
        <Row
          dim={!browserControlEnabled}
          title="Tab groups organizer"
          description="Collect tabs opened by agents into project-scoped Chrome tab groups."
        >
          <Toggle
            checked={browserControlAutoGroups}
            onChange={setBrowserControlAutoGroups}
            disabled={!browserControlEnabled}
            label="Tab groups organizer"
          />
        </Row>
        <Row
          leading={<Lead><Globe /></Lead>}
          title="Chrome Companion"
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
      </Group>

      {installOpen ? <InstallExtensionDialog onClose={() => setInstallOpen(false)} /> : null}
    </>
  );
}
