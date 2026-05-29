import type { CommandDef } from "../types";

/**
 * File preview commands. Escape semantics layer through fullscreen,
 * comment modal, comment mode, and search scopes before reaching the
 * base preview close. Search bindings are split into ⌘F (Meta) and
 * Ctrl+F so each platform's native muscle memory keeps working.
 *
 * Scopes:
 *   preview                 — File preview pane (base)
 *   preview.fullscreen      — Preview in fullscreen
 *   preview.commentMode     — Preview with comment mode active
 *   preview.commentModal    — Comment modal open over the preview
 *   preview.search          — Search bar active in the preview
 */
export const FILE_PREVIEW_COMMANDS: CommandDef[] = [
  {
    id: "preview.close",
    name: "Close Preview",
    category: "File Preview",
    description: "Close the file preview pane",
    defaultBindings: [{ key: "Escape" }],
    scope: "preview",
    // Preview content frequently includes textareas (comment modal) and
    // contenteditable surfaces; Escape must reach the layered close
    // handler even while focus sits inside them.
    passThroughTextInput: true,
  },
  {
    id: "preview.exitFullscreen",
    name: "Exit Fullscreen",
    category: "File Preview",
    description: "Leave preview fullscreen mode",
    defaultBindings: [{ key: "Escape" }],
    scope: "preview.fullscreen",
    passThroughTextInput: true,
  },
  {
    id: "preview.closeCommentModal",
    name: "Close Comment Modal",
    category: "File Preview",
    description: "Close the comment modal over the preview",
    defaultBindings: [{ key: "Escape" }],
    scope: "preview.commentModal",
    passThroughTextInput: true,
  },
  {
    id: "preview.exitCommentMode",
    name: "Exit Comment Mode",
    category: "File Preview",
    description: "Leave preview comment mode",
    defaultBindings: [{ key: "Escape" }],
    scope: "preview.commentMode",
    passThroughTextInput: true,
  },
  {
    id: "preview.closeSearch",
    name: "Close Search",
    category: "File Preview",
    description: "Close the preview search bar",
    defaultBindings: [{ key: "Escape" }],
    scope: "preview.search",
    passThroughTextInput: true,
  },
  {
    id: "preview.toggleSearch",
    name: "Toggle Search",
    category: "File Preview",
    description: "Toggle the preview search bar",
    // Mod+f covers both platforms (⌘F on mac / Ctrl+F elsewhere) — replaces
    // the old split .meta/.ctrl pair.
    defaultBindings: [{ key: "Mod+f" }],
    scope: "preview",
  },
  {
    id: "preview.toggleFullscreen",
    name: "Toggle Fullscreen",
    category: "File Preview",
    description: "Toggle preview fullscreen mode",
    scope: "preview",
  },
  {
    id: "preview.download",
    name: "Download File",
    category: "File Preview",
    description: "Download the previewed file",
    scope: "preview",
  },
  {
    id: "preview.toggleSource",
    name: "Toggle Source View",
    category: "File Preview",
    description: "Switch between rendered and raw source view",
    scope: "preview",
    defaultWhen: "canToggleSource",
  },
  {
    id: "preview.toggleComment",
    name: "Toggle Comment Mode",
    category: "File Preview",
    description: "Enter or leave preview comment mode",
    scope: "preview",
    defaultWhen: "commentable",
  },
];
