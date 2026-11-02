import { useState } from "react";
import { LayoutGroup, motion } from "framer-motion";
import { Copy, RefreshCw } from "lucide-react";
import { AgentPicker } from "../../../components/ui";
import { LayoutEditor, type LayoutNode, type PaneType } from "../../../components/Config/LayoutEditor";
import {
  dependencyInfo,
  layoutPresets,
  paneTypeColors,
  paneTypeLabels,
} from "../../../components/Config/settingsConstants";
import { Block, Button, DrawnCheck, Group, Row, Segmented } from "../../ui";
import type { SettingsPageProps } from "./types";

type StageNode =
  | { kind: "pane"; key: string; paneType: string; grow: number }
  | { kind: "split"; key: string; direction: "row" | "col"; grow: number; children: StageNode[] };

const pane = (paneType: string, grow = 1, key = paneType): StageNode => ({ kind: "pane", key, paneType, grow });

/** Preset diagrams. Panes keep their key across presets so they morph in place. */
const PRESET_STAGES: Record<string, StageNode> = {
  single: pane("shell"),
  agent: pane("agent"),
  "agent-shell": { kind: "split", key: "root", direction: "row", grow: 1, children: [pane("agent", 0.6), pane("shell", 0.4)] },
  "agent-grove-shell": {
    kind: "split",
    key: "root",
    direction: "row",
    grow: 1,
    children: [
      pane("agent", 0.55),
      { kind: "split", key: "side", direction: "col", grow: 0.45, children: [pane("grove"), pane("shell")] },
    ],
  },
  "grove-agent": { kind: "split", key: "root", direction: "row", grow: 1, children: [pane("grove", 0.4), pane("agent", 0.6)] },
};

function customStage(node: LayoutNode): StageNode {
  if (node.type === "pane" || !node.children) return pane(node.paneType ?? "shell", 1, node.id);
  return {
    kind: "split",
    key: node.id,
    direction: node.direction === "horizontal" ? "row" : "col",
    grow: 1,
    children: node.children.map(customStage),
  };
}

const REFLOW = { type: "spring", stiffness: 260, damping: 28 } as const;

function StageView({ node }: { node: StageNode }) {
  if (node.kind === "pane") {
    const color = paneTypeColors[node.paneType]?.bg ?? paneTypeColors.shell.bg;
    return (
      <motion.div layout layoutId={`pane-${node.key}`} className="ost-pane" style={{ flexGrow: node.grow }} transition={REFLOW}>
        {/* Own layout prop so the label is scale-corrected while the pane resizes. */}
        <motion.b layout="position" transition={REFLOW}>
          <i style={{ background: color }} />
          {paneTypeLabels[node.paneType as PaneType] ?? node.paneType}
        </motion.b>
        <span className="ost-ln" style={{ width: "70%" }} />
        <span className="ost-ln" style={{ width: "88%" }} />
        <span className="ost-ln" style={{ width: "52%" }} />
      </motion.div>
    );
  }
  return (
    <motion.div layout layoutId={`split-${node.key}`} className={`ost-split-${node.direction}`} style={{ flexGrow: node.grow }} transition={REFLOW}>
      {node.children.map((child) => <StageView key={child.key} node={child} />)}
    </motion.div>
  );
}

export function TerminalPage({ settings }: SettingsPageProps) {
  const {
    depStates,
    isChecking,
    checkDependencies,
    loadBaseAgents,
    webTerminalMode,
    setWebTerminalMode,
    terminalMultiplexer,
    setTerminalMultiplexer,
    hasMultiplexer,
    agentCommand,
    setAgentCommand,
    terminalAgentOptions,
    selectedLayout,
    setSelectedLayout,
    customLayouts,
    updateCustomLayouts,
    selectedCustomLayoutId,
    setSelectedCustomLayoutId,
    copiedField,
    handleCopy,
  } = settings;
  const [editorOpen, setEditorOpen] = useState(false);
  const multiplexer = webTerminalMode === "multiplexer";
  const muxes = (["tmux", "zellij"] as const).map((id) => ({ id, name: dependencyInfo[id]?.name ?? id, state: depStates[id] }));
  const missingMuxes = muxes.filter((mux) => mux.state && mux.state.status !== "installed" && mux.state.status !== "checking");
  const installedSummary = muxes
    .map((mux) => mux.state?.status === "installed"
      ? `${mux.name}${mux.state.version && mux.state.version !== "installed" ? ` ${mux.state.version}` : ""}`
      : `${mux.name} ${mux.state?.status === "checking" ? "checking…" : "not installed"}`)
    .join(" · ");

  const currentCustomLayout = customLayouts.find((layout) => layout.id === selectedCustomLayoutId) ?? customLayouts[0];
  const stage = selectedLayout === "custom"
    ? (currentCustomLayout ? customStage(currentCustomLayout.root) : null)
    : PRESET_STAGES[selectedLayout] ?? null;

  return (
    <>
      <Group
        title="Mode"
        anchorId="mode"
        actions={(
          <Button
            variant="ghost"
            iconOnly
            title="Check again"
            aria-label="Check terminal dependencies again"
            disabled={isChecking}
            onClick={() => { void checkDependencies(); void loadBaseAgents(); }}
          >
            <RefreshCw className={isChecking ? "ost-spin" : undefined} />
          </Button>
        )}
      >
        <Row
          title="Run task terminals"
          description={multiplexer
            ? "Sessions live in tmux or Zellij and survive restarts."
            : "Independent terminal instances, no session persistence."}
        >
          <Segmented
            ariaLabel="Terminal mode"
            value={multiplexer ? "multiplexer" : "direct"}
            options={[
              { value: "direct", label: "Direct" },
              {
                value: "multiplexer",
                label: "Multiplexer",
                disabled: !hasMultiplexer,
                title: hasMultiplexer ? undefined : "Install tmux or Zellij to use a multiplexer",
              },
            ]}
            onChange={setWebTerminalMode}
          />
        </Row>
        {multiplexer ? (
          <Row title="Multiplexer" description={installedSummary}>
            <Segmented
              ariaLabel="Terminal multiplexer"
              value={terminalMultiplexer === "zellij" ? "zellij" : "tmux"}
              options={muxes.map((mux) => ({
                value: mux.id,
                label: mux.name,
                disabled: mux.state?.status !== "installed",
              }))}
              onChange={setTerminalMultiplexer}
            />
          </Row>
        ) : null}
        {multiplexer || !hasMultiplexer
          ? missingMuxes.map((mux) => {
            const installCommand = mux.state?.installCommand;
            const copied = copiedField === `install-${mux.id}`;
            return (
              <Row
                key={mux.id}
                leading={<span className="ost-dot is-warn" aria-hidden="true" />}
                title={`${mux.name} not found`}
                description={installCommand
                  ? <>Install with <code className="ost-inline-code">{installCommand}</code></>
                  : "Install it to keep sessions alive when Grove closes."}
              >
                {installCommand ? (
                  <Button onClick={() => handleCopy(`install-${mux.id}`, installCommand)}>
                    {copied ? <DrawnCheck /> : <Copy />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                ) : null}
              </Row>
            );
          })
          : null}
        {multiplexer && terminalAgentOptions.length > 0 ? (
          <Row title="Terminal coding agent">
            <div className="ost-picker">
              <AgentPicker
                value={agentCommand}
                onChange={setAgentCommand}
                options={terminalAgentOptions}
                allowCustom={true}
                placeholder="Select agent..."
                triggerSize="compact"
              />
            </div>
          </Row>
        ) : null}
      </Group>

      {multiplexer ? (
        <Group title="Layout" hint="New task sessions open with this layout." anchorId="layout">
          <Block>
            <div className="ost-layouts" role="radiogroup" aria-label="Default task layout">
              {layoutPresets.map((preset) => {
                const selected = selectedLayout === preset.id;
                const isCustom = preset.id === "custom";
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className={`ost-lopt${selected ? " is-sel" : ""}`}
                    onClick={() => {
                      setSelectedLayout(preset.id);
                      if (isCustom) setEditorOpen(true);
                    }}
                  >
                    <span>{preset.name}</span>
                    <small>
                      {isCustom && customLayouts.length > 0
                        ? `${customLayouts.length} layout${customLayouts.length > 1 ? "s" : ""}`
                        : preset.description}
                    </small>
                  </button>
                );
              })}
            </div>
            <div className="ost-stage" aria-hidden="true">
              <LayoutGroup id="terminal-stage">
                {stage ? <StageView node={stage} /> : <span className="ost-stage-empty">Click Custom to configure</span>}
              </LayoutGroup>
            </div>
          </Block>
          <Row
            title="Custom layouts"
            description="Build your own split of agent, Grove and shell panes."
            onClick={() => setEditorOpen(true)}
          />
        </Group>
      ) : null}

      <LayoutEditor
        isOpen={editorOpen}
        onClose={() => setEditorOpen(false)}
        layouts={customLayouts}
        onChange={updateCustomLayouts}
        selectedLayoutId={selectedCustomLayoutId}
        onSelectLayout={setSelectedCustomLayoutId}
      />
    </>
  );
}
