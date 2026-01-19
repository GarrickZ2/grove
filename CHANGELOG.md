# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.5] - 2025-01-18

### Fixed

- New tasks incorrectly showing as "Merged" status when branch and target point to the same commit

## [0.1.3] - 2025-01-16

### Added

- Version display in help panel with update status indicator
- Update checking via GitHub API (24-hour cache)
- Installation method detection (Cargo/Homebrew/GitHub Release)
- Reset action for Current/Other tabs (rebuild branch & worktree from target)

### Changed

- Removed Merge action from Other tab (requires checkout to target first)
- Linux builds now use musl for better compatibility on older systems

### Fixed

- GLIBC compatibility issue on Debian/older Linux distributions

## [0.1.2] - 2025-01-16

### Added

- Startup environment check for git and tmux 3.0+
- Auto-refresh every 5 seconds + manual refresh with `r` key
- Diff colors in worktree list and workspace detail (+green/-red)
- Support for `terminal-notifier` for better notification experience

### Changed

- Simplified branch name generation: default `grove/` prefix, user-defined prefix with `/`
- Improved notification message format: `[project] task name`
- Hook CLI now requires all environment variables before triggering
- Wider task name column in workspace detail view

### Fixed

- Use FNV-1a hash algorithm for deterministic project keys
- Hooks storage now uses project_key consistently
- Removed unused `is_clean()` and `display()` methods

## [0.1.1] - 2025-01-15

### Fixed

- Tab filtering and UI improvements
- Correct rust-toolchain in release.yml
- Correct install.sh URL branch name (main -> master)
- Resolve clippy warnings
- Apply rustfmt formatting

## [0.1.0] - 2025-01-14

### Added

- Initial release
- TUI for managing Git worktrees + tmux sessions
- Workspace view (multi-project) and Project view (single repo)
- Task creation, archiving, and deletion
- tmux session management (create, attach, kill)
- 8 color themes
- Hook notification system (notice, warn, critical)
