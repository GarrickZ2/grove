import { AppPicker, ideAppOptions, terminalAppOptions } from "../../../components/ui";
import { isIdeApp, isTerminalApp } from "../../../components/Config/settingsConstants";
import { useInterfaceSetting } from "../../../components/Config/useInterfaceSetting";
import { Group, KeyRecorder, Row, Segmented } from "../../ui";
import type { SettingsPageProps } from "./types";

const PLATFORM_NAMES: Record<string, string> = { windows: "Windows", linux: "Linux" };

export function GeneralPage({ settings }: SettingsPageProps) {
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
  const { current: currentInterface, switchTo: switchInterface } = useInterfaceSetting();

  return (
    <>
      <Group title="Default apps" anchorId="apps">
        {serverPlatform === null ? (
          <Row title="Detecting platform…" description="Looking for installed editors and terminals." />
        ) : serverPlatform !== "macos" ? (
          <Row
            title="App detection unavailable"
            description={`IDE and terminal application detection is not yet supported on ${PLATFORM_NAMES[serverPlatform] ?? serverPlatform}.`}
          />
        ) : (
          <>
            <Row title="Default IDE">
              <div className="ost-picker">
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
            </Row>
            <Row title="Default terminal">
              <div className="ost-picker">
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
            </Row>
          </>
        )}
      </Group>

      {isTauriGui ? (
        <Group title="Window" anchorId="window">
          <Row title="Show or hide window" description="Global shortcut for the Grove window.">
            <KeyRecorder
              label="show or hide window shortcut"
              value={showHideWindowShortcut}
              recording={isRecordingWindowShortcut}
              onToggleRecording={() => setIsRecordingWindowShortcut((value) => !value)}
              onClear={() => {
                setShowHideWindowShortcut("");
                setIsRecordingWindowShortcut(false);
              }}
            />
          </Row>
        </Group>
      ) : null}

      <Group title="Interface" anchorId="interface">
        <Row
          title="Interface"
          description={currentInterface === "orbit"
            ? "Start with a conversation and follow your work."
            : "Projects, tasks, and panels in a flexible workspace."}
        >
          <Segmented
            ariaLabel="Interface"
            value={currentInterface}
            options={[
              { value: "orbit", label: "Orbit" },
              { value: "workbench", label: "Workbench" },
            ]}
            onChange={switchInterface}
          />
        </Row>
        <Row
          title="Workspace layout"
          description={workspaceLayout === "ide" ? "Fixed panels with a chat-centric view." : "Drag and arrange panels freely."}
        >
          <Segmented
            ariaLabel="Workspace layout"
            value={workspaceLayout}
            options={[
              { value: "ide", label: "Agent" },
              { value: "flex", label: "Free" },
            ]}
            onChange={setWorkspaceLayout}
          />
        </Row>
      </Group>
    </>
  );
}
