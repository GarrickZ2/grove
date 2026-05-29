import type { CommandDef } from "../types";

import { TASK_COMMANDS } from "./task";
import { AGENT_COMMANDS } from "./agent";
import { GIT_COMMANDS } from "./git";
import { PANEL_COMMANDS } from "./panel";
import { WORKSPACE_COMMANDS } from "./workspace";
import { DIALOG_COMMANDS } from "./dialog";
import { CHAT_COMMANDS } from "./chat";
import { DIFF_REVIEW_COMMANDS } from "./diffReview";
import { FILE_PREVIEW_COMMANDS } from "./filePreview";
import { STUDIO_COMMANDS } from "./studio";
import { SETTINGS_COMMANDS } from "./settings";
import { NAV_COMMANDS } from "./nav";
import { INFOTAB_COMMANDS } from "./infotab";
import { SKILLS_COMMANDS } from "./skills";
import { PROJECT_COMMANDS } from "./project";
import { AUDIO_COMMANDS } from "./audio";
import { MODE_COMMANDS } from "./mode";
import { PALETTE_COMMANDS } from "./palette";
import { HELP_COMMANDS } from "./help";
import { VIEW_COMMANDS } from "./view";
import { DEBUG_COMMANDS } from "./debug";
import { AUTOMATION_COMMANDS } from "./automation";
import { BLITZ_COMMANDS } from "./blitz";
import { RADIO_COMMANDS } from "./radio";
import { WINDOW_COMMANDS } from "./window";

/**
 * Full static command catalog. Injected into commandRegistry at app
 * startup via `commandRegistry.setStaticCatalog(COMMAND_CATALOG)` in
 * main.tsx. Runtime-only commands (dynamic agents, contributed by
 * components via useDefineCommand) are added on top of this base set.
 */
export const COMMAND_CATALOG: CommandDef[] = [
  ...TASK_COMMANDS,
  ...AGENT_COMMANDS,
  ...GIT_COMMANDS,
  ...PANEL_COMMANDS,
  ...WORKSPACE_COMMANDS,
  ...DIALOG_COMMANDS,
  ...CHAT_COMMANDS,
  ...DIFF_REVIEW_COMMANDS,
  ...FILE_PREVIEW_COMMANDS,
  ...STUDIO_COMMANDS,
  ...SETTINGS_COMMANDS,
  ...NAV_COMMANDS,
  ...INFOTAB_COMMANDS,
  ...SKILLS_COMMANDS,
  ...PROJECT_COMMANDS,
  ...AUDIO_COMMANDS,
  ...MODE_COMMANDS,
  ...PALETTE_COMMANDS,
  ...HELP_COMMANDS,
  ...VIEW_COMMANDS,
  ...DEBUG_COMMANDS,
  ...AUTOMATION_COMMANDS,
  ...BLITZ_COMMANDS,
  ...RADIO_COMMANDS,
  ...WINDOW_COMMANDS,
];

// Re-export individual arrays so tests / Settings UI can render section-by-section.
export {
  TASK_COMMANDS,
  AGENT_COMMANDS,
  GIT_COMMANDS,
  PANEL_COMMANDS,
  WORKSPACE_COMMANDS,
  DIALOG_COMMANDS,
  CHAT_COMMANDS,
  DIFF_REVIEW_COMMANDS,
  FILE_PREVIEW_COMMANDS,
  STUDIO_COMMANDS,
  SETTINGS_COMMANDS,
  NAV_COMMANDS,
  INFOTAB_COMMANDS,
  SKILLS_COMMANDS,
  PROJECT_COMMANDS,
  AUDIO_COMMANDS,
  MODE_COMMANDS,
  PALETTE_COMMANDS,
  HELP_COMMANDS,
  VIEW_COMMANDS,
  DEBUG_COMMANDS,
  AUTOMATION_COMMANDS,
  BLITZ_COMMANDS,
  RADIO_COMMANDS,
  WINDOW_COMMANDS,
};
