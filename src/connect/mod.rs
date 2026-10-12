//! IM Connect: external messaging adapters backed by Grove's existing ACP
//! session lifecycle, queue and update stream.

pub mod adapter;
pub(crate) mod commands;
pub(crate) mod core;
mod feishu;
mod feishu_auth;
mod feishu_card;
mod grove;
pub mod platform;
mod progress;
pub mod registration;
mod service;

pub use service::{
    create, current_view, delete, list_views, persist_authorized, update, verify,
    verify_credentials, ConnectionError, ConnectionView,
};

pub fn start() {
    core::start();
    adapter::start_connections();
}
