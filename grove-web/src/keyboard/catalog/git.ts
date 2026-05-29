import type { CommandDef } from "../types";

/**
 * Git operation commands. Commit, sync, merge, rebase, and branch
 * management for the current task's worktree.
 *
 * Scopes:
 *   workspace       — TaskView (inside a task)
 *   dialog.commit   — Commit dialog
 *   dialog.merge    — Merge dialog
 *   dialog.rebase   — Rebase dialog
 */
export const GIT_COMMANDS: CommandDef[] = [
  {
    id: "git.commit",
    name: "Commit Changes",
    category: "Git",
    description: "Open the commit dialog for the current task",
    defaultBindings: [{ key: "Mod+Shift+c" }],
    scope: "workspace",
    defaultWhen: "canOperate && !studioMode",
  },
  {
    id: "git.commit.submit",
    name: "Submit Commit",
    category: "Git",
    description: "Confirm and create the commit",
    scope: "dialog.commit",
    defaultWhen: "commitMessageNotEmpty",
    passThroughTextInput: true,
  },
  {
    id: "git.commit.cancel",
    name: "Cancel Commit",
    category: "Git",
    description: "Close the commit dialog without committing",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.commit",
    passThroughTextInput: true,
  },
  {
    id: "git.sync",
    name: "Sync (Fetch & Pull)",
    category: "Git",
    description: "Fetch and pull the target branch into the current worktree",
    defaultBindings: [{ key: "Mod+Shift+s" }],
    scope: "workspace",
    defaultWhen: "canOperate && !studioMode",
  },
  {
    id: "git.merge",
    name: "Merge",
    category: "Git",
    description: "Open the merge dialog to merge this branch into its target",
    defaultBindings: [{ key: "Mod+Shift+m" }],
    scope: "workspace",
    defaultWhen: "canOperate && !studioMode",
  },
  {
    id: "git.merge.submit",
    name: "Submit Merge",
    category: "Git",
    description: "Confirm and perform the merge with the chosen method",
    scope: "dialog.merge",
    defaultWhen: "methodSelected",
    passThroughTextInput: true,
  },
  {
    id: "git.merge.cancel",
    name: "Cancel Merge",
    category: "Git",
    description: "Close the merge dialog without merging",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.merge",
    passThroughTextInput: true,
  },
  {
    id: "git.rebase",
    name: "Rebase",
    category: "Git",
    description: "Open the rebase dialog to rebase this branch onto a target",
    defaultBindings: [{ key: "Mod+Shift+b" }],
    scope: "workspace",
    defaultWhen: "canOperate && !studioMode",
  },
  {
    id: "git.rebase.submit",
    name: "Submit Rebase",
    category: "Git",
    description: "Confirm and perform the rebase onto the chosen target",
    scope: "dialog.rebase",
    defaultWhen: "targetSelected",
    passThroughTextInput: true,
  },
  {
    id: "git.rebase.cancel",
    name: "Cancel Rebase",
    category: "Git",
    description: "Close the rebase dialog without rebasing",
    defaultBindings: [{ key: "Escape" }],
    scope: "dialog.rebase",
    passThroughTextInput: true,
  },
  {
    id: "git.branch.new",
    name: "New Branch",
    category: "Git",
    description: "Create a new branch from the current worktree's HEAD",
    scope: "workspace",
    defaultWhen: "canOperate",
  },
  {
    id: "git.branch.rename",
    name: "Rename Branch",
    category: "Git",
    description: "Rename the current task's branch",
    scope: "workspace",
    defaultWhen: "canOperate",
  },
];
