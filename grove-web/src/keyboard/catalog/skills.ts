import type { CommandDef } from "../types";

/**
 * Skills settings commands — adding agents/sources and managing the
 * installed skill catalog. Selection-based operations (edit/delete a
 * specific row) are intentionally NOT registered: those belong to row
 * context menus, not global shortcuts.
 */
export const SKILLS_COMMANDS: CommandDef[] = [
  {
    id: "skills.tab.explore",
    name: "Skills: Explore Tab",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.tab.sources",
    name: "Skills: Sources Tab",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.tab.agents",
    name: "Skills: Agents Tab",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.agent.add",
    name: "Add Agent",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.source.add",
    name: "Add Source",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.source.syncAll",
    name: "Sync All Sources",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.source.checkUpdates",
    name: "Check for Updates",
    category: "Skills",
    scope: "settings",
  },
  {
    id: "skills.skill.install",
    name: "Install Skill",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillAvailable",
  },
  {
    id: "skills.skill.uninstall",
    name: "Uninstall Skill",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillInstalled",
  },
  {
    id: "skills.skill.details",
    name: "Show Skill Details",
    category: "Skills",
    scope: "settings",
    defaultWhen: "skillSelected",
  },
];
