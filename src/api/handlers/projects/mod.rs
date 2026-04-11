//! Project API handlers

pub mod crud;
pub mod instructions;
pub mod project_git;
pub mod resources;
pub mod types;

// Re-export all public items so routing table needs zero changes.
pub use crud::*;
pub use instructions::*;
pub use project_git::*;
pub use resources::*;
pub use types::*;
