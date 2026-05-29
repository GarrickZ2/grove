import type { CommandDef } from "../types";

/**
 * Dialog/modal commands. Each dialog exposes its own close (Escape) and,
 * where applicable, submit (Mod+Enter) command under a scope of the form
 * `dialog.<name>` so keybindings stay isolated from the rest of the UI.
 *
 * Every entry sets `passThroughTextInput: true` because dialog focus
 * often lands on a textarea (notes, commit message, command prompt).
 * Without the flag the suppression layer drops Escape / Mod+Enter
 * before they reach the scope match, and the dialog won't close /
 * submit from the field.
 *
 * All entries also set `hidden: true` — these are dialog-local bindings
 * wired by the dialog components themselves (close on Escape, submit on
 * Mod+Enter). They aren't meaningful to surface in Settings → Keyboard
 * Shortcuts or the Command Palette: rebinding the close key of one
 * specific dialog isn't a workflow users have, and showing 20+ rows of
 * "Close X Dialog" buries the commands that actually matter.
 *
 * Scopes:
 *   dialog.<name>  — one scope per dialog
 */
export const DIALOG_COMMANDS: CommandDef[] = [
  {
    id: "dialog.newTask.close",
    name: "Close New Task Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.newTask",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.newTask.submit",
    name: "Submit New Task",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.newTask",
    defaultWhen: "taskNameValid",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.newBranch.close",
    name: "Close New Branch Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.newBranch",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.newBranch.submit",
    name: "Submit New Branch",
    category: "Dialog",
    scope: "dialog.newBranch",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.renameBranch.close",
    name: "Close Rename Branch Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.renameBranch",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.renameBranch.submit",
    name: "Submit Rename Branch",
    category: "Dialog",
    scope: "dialog.renameBranch",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.confirm.cancel",
    name: "Cancel Confirm Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.confirm",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.confirm.submit",
    name: "Confirm",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.confirm",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addAgent.close",
    name: "Close Add Agent Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.addAgent",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addAgent.submit",
    name: "Submit Add Agent",
    category: "Dialog",
    scope: "dialog.addAgent",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addProject.close",
    name: "Close Add Project Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.addProject",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addProject.submit",
    name: "Submit Add Project",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.addProject",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addLink.close",
    name: "Close Add Link Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.addLink",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addLink.submit",
    name: "Submit Add Link",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.addLink",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addSource.close",
    name: "Close Add Source Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.addSource",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.addSource.submit",
    name: "Submit Add Source",
    category: "Dialog",
    scope: "dialog.addSource",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.installSkill.close",
    name: "Close Install Skill Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.installSkill",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.automation.close",
    name: "Close Automation Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.automation",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.automation.submit",
    name: "Submit Automation",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.automation",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.transcript.close",
    name: "Close Transcript Dialog",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.transcript",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.customAgent.close",
    name: "Close Custom Agent Modal",
    category: "Dialog",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.customAgent",
    passThroughTextInput: true,
    hidden: true,
  },
  {
    id: "dialog.customAgent.submit",
    name: "Submit Custom Agent",
    category: "Dialog",
    defaultBindings: [{ key: "Mod+Enter" }],
    scope: "dialog.customAgent",
    passThroughTextInput: true,
    hidden: true,
  },
];
