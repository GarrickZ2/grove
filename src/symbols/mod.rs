//! Symbol indexer for cmd+click navigation in the Editor.
//!
//! Pipeline:
//! 1. `extractor::extract` — given source bytes for a supported file,
//!    return a flat `Vec<SymbolDef>` via tree-sitter.
//! 2. `store::SymbolStore` — per-project SQLite cache + in-memory hot
//!    layer at `~/.grove/projects/<hash>/index.db`.
//! 3. `indexer` — orchestrates lazy first-build and incremental updates
//!    driven by `FileWatcher` subscriptions. Public entry points are
//!    `ensure_built`, `lookup`, `search`, `trigger_reindex`.
//!
//! Currently supports Go only. Other languages plug in by adding a
//! `tree-sitter-<lang>` dep, a `queries/<lang>.scm`, and registering
//! the language in `types::Language`.

mod extractor;
mod indexer;
mod store;
mod types;

pub use indexer::{lookup, on_task_deleted, on_watch_started, search, trigger_reindex};
pub use types::{SymbolDef, SymbolKind};

// Lower-level pieces are kept available behind the module wall but not
// re-exported; outside callers should go through the indexer.
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use extractor::extract;
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use store::SymbolStore;
#[cfg(test)]
#[allow(unused_imports)]
pub(crate) use types::Language;
