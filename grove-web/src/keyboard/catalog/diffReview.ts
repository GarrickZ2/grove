import type { CommandDef } from "../types";

/**
 * Diff/code review commands. File navigation, view-mode toggles, search,
 * and inline comment authoring inside the Code Review surface.
 *
 * Scopes:
 *   diffReview         — Code review panel
 *   diffReview.search  — Code search overlay inside the review
 */
export const DIFF_REVIEW_COMMANDS: CommandDef[] = [
  {
    id: "diffReview.nextFile",
    name: "Next File",
    category: "Diff Review",
    description: "Move to the next changed file",
    defaultBindings: [{ key: "ArrowDown" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.prevFile",
    name: "Previous File",
    category: "Diff Review",
    description: "Move to the previous changed file",
    defaultBindings: [{ key: "ArrowUp" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.toggleViewed",
    name: "Toggle Viewed",
    category: "Diff Review",
    description: "Mark the current file as viewed or unviewed",
    defaultBindings: [{ key: "Mod+Alt+v" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.refresh",
    name: "Refresh Review",
    category: "Diff Review",
    description: "Reload the review diff",
    defaultBindings: [{ key: "F5" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.toggleViewMode",
    name: "Toggle View Mode (Unified/Split)",
    category: "Diff Review",
    description: "Switch between unified and split diff layouts",
    defaultBindings: [{ key: "Shift+Tab" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.togglePreview",
    name: "Toggle Preview",
    category: "Diff Review",
    description: "Show or hide the file preview pane",
    defaultBindings: [{ key: "Mod+Alt+p" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.openSearch",
    name: "Open Code Search",
    category: "Diff Review",
    description: "Open the code search overlay",
    defaultBindings: [{ key: "Mod+f" }],
    scope: "diffReview",
  },
  {
    id: "diffReview.closeSearch",
    name: "Close Code Search",
    category: "Diff Review",
    description: "Close the code search overlay",
    defaultBindings: [{ key: "Escape" }],
    scope: "diffReview.search",
  },
  {
    id: "diffReview.markViewed",
    name: "Mark Current File Viewed",
    category: "Diff Review",
    description: "Mark the currently open file as viewed",
    scope: "diffReview",
    defaultWhen: "fileOpen",
  },
  {
    id: "diffReview.comment.submit",
    name: "Submit Comment",
    category: "Diff Review",
    description: "Submit the current comment draft",
    scope: "diffReview",
    defaultWhen: "commentText",
  },
];
