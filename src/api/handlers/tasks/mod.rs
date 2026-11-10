//! Task API handlers

pub mod artifact_zip;
pub mod artifacts;
pub mod crud;
pub mod designs;
pub mod file_explorer;
pub mod git_ops;
pub mod graph;
pub mod linked_projects;
pub mod notes;
pub mod pending_form;
pub mod review;
pub mod sketch_events;
pub mod sketch_ws;
pub mod sketches;
pub mod types;

// Re-export all public items so routing table needs zero changes.
pub use artifact_zip::*;
pub use artifacts::*;
pub use crud::*;
pub use designs::*;
pub use file_explorer::*;
pub use git_ops::*;
pub use graph::*;
pub use linked_projects::*;
pub use notes::*;
pub use review::*;
pub use sketches::*;
#[allow(unused_imports)]
pub use types::*;
