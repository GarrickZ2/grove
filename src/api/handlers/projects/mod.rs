//! Project API handlers

pub mod agent_context;
pub mod crud;
pub mod instructions;
pub mod linked_projects;
pub mod project_git;
pub mod resources;
pub mod types;

// Re-export all public items so routing table needs zero changes.
pub use agent_context::get_agent_context;
pub use crud::*;
pub use instructions::*;
pub use linked_projects::{get_project_linked_projects, update_project_linked_projects};
pub use project_git::*;
pub use resources::*;
pub use types::*;
