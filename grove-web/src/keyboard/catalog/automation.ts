import type { CommandDef } from "../types";

/**
 * Automation commands — cron-driven prompts scheduled per project.
 *
 * `automation.new` is always available (opens the create dialog). The edit /
 * delete / run commands gate on `automationSelected`, which AutomationPage
 * sets while a row is expanded — the expanded row is the "current" automation
 * those commands act on.
 */
export const AUTOMATION_COMMANDS: CommandDef[] = [
  {
    id: "automation.new",
    name: "New Automation",
    category: "Automation",
  },
  {
    id: "automation.edit",
    name: "Edit Automation",
    category: "Automation",
    defaultWhen: "automationSelected",
  },
  {
    id: "automation.delete",
    name: "Delete Automation",
    category: "Automation",
    defaultWhen: "automationSelected",
  },
  {
    id: "automation.run",
    name: "Run Automation Now",
    category: "Automation",
    defaultWhen: "automationSelected",
  },
];
