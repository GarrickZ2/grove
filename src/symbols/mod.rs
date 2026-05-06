// Items below are wired up by storage / API / frontend in follow-up
// commits. Until then, allow unused-* without cluttering each item.
#![allow(dead_code)]

//! Symbol indexer for cmd+click navigation in the Editor.
//!
//! This module is the data-extraction half of the feature — given source
//! bytes for a supported file, it produces `Vec<SymbolDef>`. Storage,
//! lifecycle hooks, and the HTTP API live in sibling modules added in
//! later commits.
//!
//! Currently supports Go only. Other languages plug in by registering a
//! new `tree-sitter-<lang>` grammar plus a tags query under
//! `queries/<lang>.scm`.

mod extractor;
mod store;
mod types;

#[allow(unused_imports)]
pub use extractor::extract;
#[allow(unused_imports)]
pub use store::SymbolStore;
#[allow(unused_imports)]
pub use types::{Language, SymbolDef, SymbolKind};
