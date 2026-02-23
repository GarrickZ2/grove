# Grove - Project Guide

## Overview

Grove is a Rust TUI application for managing Git Worktrees + tmux sessions, designed for parallel AI coding agent workflows.

## Tech Stack

- **Language**: Rust 2021 Edition
- **TUI Framework**: ratatui 0.29
- **Terminal Backend**: crossterm 0.28
- **Config**: toml + serde
- **Time**: chrono

## Project Structure

```
src/
├── main.rs              # Entry point, terminal initialization
├── app.rs               # App state management, core logic
├── event.rs             # Keyboard event handling
├── cli/
│   ├── mod.rs           # CLI subcommand definitions
│   ├── agent.rs         # `grove agent` commands (status/summary/todo/notes)
│   ├── hooks.rs         # `grove hooks` notification commands
│   └── init.rs          # Worktree AI integration setup (GROVE.md injection)
├── git/
│   └── mod.rs           # Git command wrappers
├── tmux/
│   └── mod.rs           # tmux session management
├── storage/
│   ├── mod.rs
│   ├── config.rs        # Global config read/write
│   ├── tasks.rs         # Task data persistence
│   ├── workspace.rs     # Project registration
│   ├── ai_data.rs       # AI summary & TODO persistence
│   └── notes.rs         # Task notes persistence
├── model/
│   ├── mod.rs
│   ├── worktree.rs      # Worktree/Task data structures
│   ├── workspace.rs     # Workspace state (grid navigation, filtering)
│   └── loader.rs        # Data loading logic
├── theme/
│   ├── mod.rs           # Theme enum, ThemeColors struct
│   ├── colors.rs        # 8 theme color definitions (including accent palettes)
│   └── detect.rs        # System dark/light mode detection
└── ui/
    ├── mod.rs
    ├── workspace.rs     # Workspace view
    ├── project.rs       # Project view
    └── components/      # Reusable UI components
        ├── workspace_list.rs  # Card grid with gradient color blocks
        ├── worktree_list.rs
        ├── preview_panel.rs   # Side panel (Git/AI/Notes tabs)
        ├── header.rs
        ├── footer.rs
        ├── tabs.rs
        ├── toast.rs
        ├── theme_selector.rs
        ├── help_panel.rs
        ├── new_task_dialog.rs
        ├── add_project_dialog.rs
        ├── delete_project_dialog.rs
        ├── confirm_dialog.rs
        ├── input_confirm_dialog.rs
        ├── branch_selector.rs
        ├── merge_dialog.rs
        └── ...
```

### Web Frontend Structure

```
grove-web/src/
├── main.tsx                # Entry point
├── App.tsx                 # Root component
├── api/                    # Backend API clients
│   ├── client.ts
│   ├── config.ts
│   └── index.ts
├── components/             # React components
│   ├── Blitz/              # Blitz mode (cross-project view)
│   │   └── BlitzPage.tsx   # ~675 lines (refactored)
│   ├── Tasks/              # Zen mode (single-project view)
│   │   └── TasksPage.tsx   # ~610 lines (refactored)
│   ├── Config/             # Settings page
│   ├── Terminal/           # Terminal integration
│   ├── Editor/             # Code editor integration
│   └── ui/                 # Reusable UI components
│       ├── ContextMenu.tsx
│       ├── Dialog.tsx
│       └── ...
├── hooks/                  # Custom React hooks
│   ├── index.ts
│   ├── useHotkeys.ts       # Keyboard shortcuts
│   ├── useTaskPageState.ts # Page state management (~250 lines)
│   ├── useTaskNavigation.ts # j/k navigation (~70 lines)
│   ├── usePostMergeArchive.ts # Post-merge workflow (~160 lines)
│   └── useTaskOperations.ts # All task operations (~450 lines)
├── utils/                  # Utility functions
│   ├── archiveHelpers.tsx  # Archive confirmation builder
│   └── taskOperationUtils.ts # Context menu builder
└── data/
    └── types.ts            # TypeScript type definitions
```

## Core Concepts

### Hierarchy

```
Workspace (multiple projects)
└── Project (single git repo)
    └── Task (worktree + tmux session)
```

### Entry Logic

- Run `grove` outside git repo → Workspace view
- Run `grove` inside git repo → Project view

### Task States

- `Live (●)` — tmux session running
- `Idle (○)` — no active session
- `Merged (✓)` — merged to target branch

## Commands

```bash
cargo build            # Build
cargo run              # Run
cargo check            # Check
cargo build --release  # Release build
```

## Data Storage

All data stored in `~/.grove/`:

```
~/.grove/
├── config.toml           # Theme config
└── projects/
    └── <path-hash>/      # Hash of project path
        ├── project.toml  # Project metadata
        ├── tasks.toml    # Active tasks
        ├── archived.toml # Archived tasks
        ├── ai/
        │   └── <task-id>/
        │       ├── summary.md   # AI agent summary
        │       └── todo.json    # AI agent TODO list
        └── notes/
            └── <task-id>.md     # User-provided task notes
```

## Development Guidelines

### Completion Summary (IMPORTANT)

**After completing any code modifications, ALWAYS provide a clear summary to the user:**

1. **Frontend Changes** — If `grove-web/` was modified:
   - Explicitly state: "✅ `npm run build` executed successfully" (if you ran it)
   - OR state: "⚠️ You need to run `npm run build` in `grove-web/`" (if you didn't run it)

2. **Backend Changes** — If Rust code (`src/`) was modified:
   - Explicitly state: "⚠️ Rust backend needs rebuild - run `cargo build --release` and restart server"
   - OR state: "✅ No backend changes - no need to restart Rust server"

3. **Example Summary Format**:
   ```
   ## Build Status
   - ✅ npm run build: Completed successfully
   - ⚠️ Rust backend: Needs rebuild (modified src/api/handlers/tasks.rs)
   ```

This helps the user immediately know what actions they need to take without having to guess or re-read the entire conversation.

### Rust Source Code Checks (REQUIRED)

When modifying Rust source files, always run:

```bash
cargo fmt --all
```

### Web Frontend Development

When modifying the web frontend (`grove-web/`):

1. **Always build after changes** — Run `npm run build` in the `grove-web/` directory after making any frontend code changes to ensure the build is successful
2. **Check for TypeScript errors** — The build process runs `tsc -b` first, catching type errors
3. **Location** — All web frontend code is in the `grove-web/` directory

```bash
cd grove-web
npm run build  # Build frontend after changes
```

### Web Frontend Hooks Architecture

The web frontend uses a custom hooks architecture to eliminate code duplication between Blitz mode (`BlitzPage.tsx`) and Zen mode (`TasksPage.tsx`):

**Core Hooks** (`grove-web/src/hooks/`):

1. **`useTaskPageState`** (~250 lines) — Manages all page-level state:
   - Task selection (`selectedTask`, `viewMode`)
   - UI panels (`reviewOpen`, `editorOpen`, `showHelp`)
   - Messages and search (`operationMessage`, `searchQuery`)
   - Returns: `[TaskPageState, TaskPageHandlers]`

2. **`useTaskNavigation`** (~70 lines) — Handles keyboard navigation:
   - j/k navigation (`selectNextTask`, `selectPreviousTask`)
   - Context menu positioning (`openContextMenuAtSelectedTask`)
   - Requires: tasks array, selection state, view mode

3. **`usePostMergeArchive`** (~160 lines) — Post-merge archive workflow:
   - Archive dialog after successful merge
   - Supports cross-project operations (Blitz mode)
   - Handles archive confirmation and cleanup
   - Returns: `[PostMergeArchiveState, PostMergeArchiveHandlers]`

4. **`useTaskOperations`** (~450 lines) — All task Git operations:
   - Commit, Merge, Archive, Sync, Rebase, Reset, Clean
   - Dialog state management for each operation
   - Loading states, error handling, API calls
   - Returns: `[TaskOperationsState, TaskOperationsHandlers]`

**Usage Pattern**:

```typescript
import {
  useTaskPageState,
  useTaskNavigation,
  usePostMergeArchive,
  useTaskOperations,
} from "../../hooks";

function TaskPage() {
  const [pageState, pageHandlers] = useTaskPageState();
  const [opsState, opsHandlers] = useTaskOperations({
    projectId: selectedProject?.id ?? null,
    selectedTask: pageState.selectedTask,
    onRefresh: refreshSelectedProject,
    onShowMessage: pageHandlers.showMessage,
    onTaskArchived: () => { /* cleanup */ },
    onTaskMerged: (taskId, taskName) => {
      postMergeHandlers.triggerPostMergeArchive(taskId, taskName);
    },
  });
  const [postMergeState, postMergeHandlers] = usePostMergeArchive({...});
  const navHandlers = useTaskNavigation({...});

  // Use state and handlers in JSX
  return <div>{/* ... */}</div>;
}
```

**Utility Functions** (`grove-web/src/utils/`):

- **`archiveHelpers.tsx`** — Archive confirmation message builder, error handling
- **`taskOperationUtils.ts`** — Context menu builder, task state checkers

**Benefits**:
- Eliminated ~850 lines of duplicate code between Blitz and Zen modes
- Single source of truth for all task operations
- Full TypeScript type safety and IDE autocomplete
- Easier to add new operations or fix bugs (change once, apply everywhere)

### UI Component Pattern

All UI components follow the same pattern:

```rust
pub fn render(frame: &mut Frame, area: Rect, data: &Data, colors: &ThemeColors) {
    // Render using ratatui widgets
}
```

### Event Handling

Events are handled in `event.rs`, dispatched by priority:
1. Popup events (help, dialogs, etc.)
2. Mode events (Workspace / Project)

### Color Usage

Always use `ThemeColors` struct fields, never hardcode colors:

```rust
// Good
Style::default().fg(colors.highlight)

// Bad
Style::default().fg(Color::Yellow)
```

Each theme defines an `accent_palette: [Color; 10]` for workspace card gradient blocks. Use `colors.accent_palette` instead of hardcoded color arrays.

### Pre-commit Checks

A pre-commit hook is provided in `.githooks/pre-commit`. It runs the following checks before each commit:

1. **`cargo fmt --all -- --check`** — code must be formatted
2. **`cargo clippy -- -D warnings`** — no clippy warnings allowed
3. **`cargo test`** — all tests must pass
4. **Version bump** — `Cargo.toml` version must differ from `master` (skipped when committing on master itself)

Activate the hook with:

```bash
git config core.hooksPath .githooks
```

### Git Commit Guidelines

**IMPORTANT: Commit Discipline**

- **One commit per bug fix or feature** — Do not create commits for every small change. Group related changes into a single, cohesive commit.
- **Each commit should be self-contained** — A commit should represent a complete bug fix or feature that makes sense on its own.
- **Examples:**
  - ✅ Good: One commit for "fix(web): optimize panel switching and animations" that includes all related animation fixes
  - ✅ Good: One commit for "feat(editor): add file system operations" that includes context menu, dialogs, and API handlers
  - ❌ Bad: Multiple commits for "fix terminal layout", "fix terminal fullscreen", "fix terminal animation" when they're all part of the same issue
  - ❌ Bad: Separate commits for "add context menu UI" and "add context menu handlers" when they're part of the same feature

If you find yourself creating multiple commits in quick succession for the same logical change, you should combine them using `git rebase -i` or `git commit --amend`.

### Git Operations

All git operations are wrapped in `src/git/mod.rs`, using `std::process::Command` to call git CLI.

### tmux Operations

All tmux operations are wrapped in `src/tmux/mod.rs`.

## CLI Subcommands

Grove has two CLI subcommand groups (defined in `src/cli/`):

- `grove hooks <level>` — send notification hooks (notice/warn/critical)
- `grove agent <command>` — AI agent workflow commands (status/summary/todo/notes)

### AI Integration Flow

When a task is created (`create_new_task` in `app.rs`):
1. Git worktree is created
2. `cli::init::setup_worktree()` generates `GROVE.md` and injects into `CLAUDE.md`/`AGENTS.md`
3. tmux session is created with `GROVE_*` environment variables
4. Agent reads `GROVE.md` instructions and uses `grove agent` CLI to track progress

## TODO

- [ ] Diff view (Code Review)
- [ ] Ctrl-C exit support
- [ ] Homebrew formula
