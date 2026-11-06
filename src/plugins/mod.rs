//! Plugin runtime support — launching plugin node processes with manifest-
//! derived runtime permissions. See [`runtime`].

pub mod approval;
pub mod backend;
pub mod connect_provider;
pub mod events;
pub mod exec;
pub mod host_api;
pub mod lifecycle;
pub mod prompt_middleware;
pub mod radio_bridge;
pub mod runtime;
pub mod update;
pub mod view;

#[cfg(test)]
mod e2e_tests;
