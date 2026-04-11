//! Task API handlers

pub mod artifacts;
pub mod crud;
pub mod file_explorer;
pub mod git_ops;
pub mod notes;
pub mod review;
pub mod types;

// Re-export all public items so routing table needs zero changes.
pub use artifacts::*;
pub use crud::*;
pub use file_explorer::*;
pub use git_ops::*;
pub use notes::*;
pub use review::*;
#[allow(unused_imports)]
pub use types::*;
