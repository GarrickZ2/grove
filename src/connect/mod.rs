//! IM Connect: external messaging adapters backed by Grove's existing ACP
//! session lifecycle, queue and update stream.

pub mod adapter;
mod commands;
mod core;
mod feishu;
mod grove;
pub mod platform;
pub mod registration;
mod service;

pub use service::{
    create, current_view, delete, list_views, persist, update, validate, verify,
    verify_credentials, ConnectionError, ConnectionView,
};

pub fn start() {
    core::start();
    adapter::start_connections();
}
