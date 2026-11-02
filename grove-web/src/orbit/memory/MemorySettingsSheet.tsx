import { useEffect, useState } from "react";
import { AgentPicker } from "../../components/ui/AgentPicker";
import { Combobox } from "../../components/ui/Combobox";
import { MemoryAgentConfig } from "../../components/Memory/MemoryAgentConfig";
import { ScheduleField } from "../../components/Memory/MemoryPage";
import { TASK_FINISHED_TRIGGER, describeSchedule, withEventTrigger } from "../../components/Memory/memoryModel";
import type { MemoryConfigDraftState } from "../../components/Memory/useMemoryConfigDraft";
import { Block, Button, Group, Row, SavedChip, Sheet, Toggle } from "../ui";
import { draftProblem } from "./memoryView";
import type { useMemoryAutosave } from "./useMemoryAutosave";

const SETUP_STEPS = [
  { title: "Organizer", body: "The agent that merges notes into memories" },
  { title: "When to organize", body: "A schedule, and optional early triggers" },
] as const;

interface MemorySettingsSheetProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  editor: MemoryConfigDraftState;
  autosave: ReturnType<typeof useMemoryAutosave>;
  agentsLoading: boolean;
  /**
   * Guided first-time setup: edits stay local (no autosave) and Memory only
   * turns on when the user finishes, with an organizer chosen.
   */
  setup?: { onConfirm: () => void; saving: boolean };
}

/** Threshold input keeps its own text so clearing it doesn't fight the draft. */
function ThresholdField({ value, disabled, onCommit }: { value: number | null; disabled: boolean; onCommit: (value: number | null) => void }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => {
    void Promise.resolve().then(() => setText(value ? String(value) : ""));
  }, [value]);
  const commit = () => {
    const parsed = Number.parseInt(text.trim(), 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    setText(next ? String(next) : "");
    if (next !== value) onCommit(next);
  };
  return (
    <span className="oms-num">
      <input
        className="oui-field"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        placeholder="Off"
        aria-label="Organize early after this many notes"
        value={text}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
      />
      <span>notes</span>
    </span>
  );
}

export function MemorySettingsSheet({ open, onClose, projectName, editor, autosave, agentsLoading, setup }: MemorySettingsSheetProps) {
  const { draft, selectedAgentId, options, modes, installedAgentOptions } = editor;
  const edit = setup ? editor.setDraft : autosave.edit;
  const editAgent = setup ? editor.chooseAgent : autosave.editAgent;
  const problem = setup ? null : autosave.problem;
  const setupProblem = setup ? draftProblem({ ...draft, enabled: true }) : null;
  // The guide walks one step at a time: who organizes, then when.
  const [step, setStep] = useState<0 | 1>(0);
  const agentMissing = !draft.agent_config.agent_id;
  const off = !setup && !draft.enabled;
  const manual = off || !draft.organization_enabled;
  const scheduleText = describeSchedule(draft.schedule_cron);

  const organizer = (
        <Group title={setup ? undefined : "Organizer"} hint={setup ? undefined : "the agent that merges notes"}>
          <Block dim={off}>
            <div className="oms-block-head"><b>Agent</b><span>Installed agents only</span></div>
            <AgentPicker
              value={selectedAgentId}
              onChange={editAgent}
              options={installedAgentOptions}
              allowCustom={false}
              triggerSize="compact"
              placeholder={agentsLoading ? "Loading installed agents…" : "Choose an installed agent"}
            />
          </Block>
          {draft.agent_config.source === "config_options" && options.length > 0 ? (
            <Block dim={off}>
              <div className="oms-block-head"><b>Agent configuration</b></div>
              <MemoryAgentConfig options={options} config={draft.agent_config} onChange={(agent_config) => edit((current) => ({ ...current, agent_config }))} />
            </Block>
          ) : null}
          {draft.agent_config.source === "modes" && modes.length > 0 ? (
            <Block dim={off}>
              <div className="oms-block-head"><b>Mode</b><span>Supported by the selected agent</span></div>
              <Combobox
                options={modes.map(([id, name]) => ({ id, value: id, label: name }))}
                value={draft.agent_config.mode_id}
                onChange={(modeId) => edit((current) => ({ ...current, agent_config: { ...current.agent_config, source: "modes", mode_id: modeId } }))}
                allowCustom={false}
              />
            </Block>
          ) : null}
        </Group>
  );
  const organizing = (
        <Group title={setup ? undefined : "Organizing"}>
          <Row title="Organize automatically" description="Keep Memory current in the background." dim={off}>
            <Toggle label="Organize automatically" checked={draft.organization_enabled} onChange={(organization_enabled) => edit((current) => ({ ...current, organization_enabled }))} />
          </Row>
          <Block dim={manual}>
            <div className="oms-block-head"><b>Schedule</b><span className={scheduleText === "Enter a valid cron expression." ? "is-bad" : undefined}>{scheduleText}</span></div>
            <ScheduleField value={draft.schedule_cron} onChange={(schedule_cron) => edit((current) => ({ ...current, schedule_cron }))} />
          </Block>
          <Row title="Organize early after" description="Run as soon as this many notes are waiting. Leave empty to only use the schedule." dim={manual}>
            <ThresholdField value={draft.pending_log_threshold} disabled={manual} onCommit={(pending_log_threshold) => edit((current) => ({ ...current, pending_log_threshold }))} />
          </Row>
          <Row title="When a task is archived" description="Organize right after a task moves to Archived." dim={manual}>
            <Toggle
              label="Organize when a task is archived"
              checked={draft.event_triggers.includes(TASK_FINISHED_TRIGGER)}
              onChange={(on) => edit((current) => ({ ...current, event_triggers: withEventTrigger(current.event_triggers, TASK_FINISHED_TRIGGER, on) }))}
            />
          </Row>
          {setup ? (
            <Row title="Deep organization" description="Include more project history when organizing.">
              <Toggle label="Deep organization" checked={draft.deep_organization} onChange={(deep_organization) => edit((current) => ({ ...current, deep_organization }))} />
            </Row>
          ) : null}
        </Group>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={setup ? "Set up Memory" : "Memory settings"}
      title={setup ? "Set up Memory" : "Memory settings"}
      description={setup
        ? `Two quick choices for ${projectName}. Memory turns on only when you finish.`
        : `How and when Grove turns notes into memories for ${projectName}. Changes save as you go.`}
      aside={setup ? undefined : <SavedChip count={autosave.savedCount} />}
    >
      <div className="oui-sheet-body oui-scroll">
        {problem ? <p className="oms-problem" role="alert">{problem}</p> : null}
        {setup ? null : (
          <Group>
            <Row title="Memory" description="Collect notes from agents and let new sessions recall memories.">
              <Toggle label="Memory" checked={draft.enabled} onChange={(enabled) => edit((current) => ({ ...current, enabled }))} />
            </Row>
            <Row title="Deep organization" description="Include more project history when organizing." dim={off}>
              <Toggle label="Deep organization" checked={draft.deep_organization} onChange={(deep_organization) => edit((current) => ({ ...current, deep_organization }))} />
            </Row>
          </Group>
        )}
        {setup ? (
          <>
            <ol className="oms-steps" aria-label="Setup steps">
              {SETUP_STEPS.map((item, index) => (
                <li key={item.title} className={index === step ? "is-on" : index < step ? "is-done" : undefined} aria-current={index === step ? "step" : undefined}>
                  <em>{index + 1}</em><span><b>{item.title}</b><small>{item.body}</small></span>
                </li>
              ))}
            </ol>
            <div key={step} className="oms-step oui-rise">{step === 0 ? organizer : organizing}</div>
          </>
        ) : <>{organizing}{organizer}</>}
      </div>
      {setup ? (
        <div className="oms-setup-foot">
          {step === 0 ? (
            <>
              <span className={agentMissing ? "is-bad" : undefined}>{agentMissing ? "Choose an organizer to continue." : "Step 1 of 2"}</span>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={agentMissing} onClick={() => setStep(1)}>Next</Button>
            </>
          ) : (
            <>
              <span className={setupProblem ? "is-bad" : undefined}>{setupProblem ?? "Step 2 of 2"}</span>
              <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
              <Button variant="primary" disabled={Boolean(setupProblem) || setup.saving} onClick={setup.onConfirm}>
                {setup.saving ? "Turning on…" : "Turn on Memory"}
              </Button>
            </>
          )}
        </div>
      ) : null}
    </Sheet>
  );
}
