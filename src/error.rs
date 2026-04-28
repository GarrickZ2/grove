//! Grove 统一错误类型定义
//!
//! 使用 `thiserror` 库提供统一的错误处理，支持错误链式传播。

use std::io;
use thiserror::Error;

/// Grove 错误类型
#[derive(Debug, Error)]
pub enum GroveError {
    /// I/O 错误（文件读写、目录操作等）
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),

    /// Git 操作错误
    #[error("Git error: {0}")]
    Git(String),

    /// Session 管理错误（tmux/zellij）
    #[error("Session error: {0}")]
    Session(String),

    /// 配置错误
    #[error("Config error: {0}")]
    Config(String),

    /// TOML 解析错误
    #[error("TOML parse error: {0}")]
    TomlParse(#[from] toml::de::Error),

    /// TOML 序列化错误
    #[error("TOML serialize error: {0}")]
    TomlSerialize(#[from] toml::ser::Error),

    /// JSON 解析错误
    #[error("JSON parse error: {0}")]
    JsonParse(#[from] serde_json::Error),

    /// SQLite 错误
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    /// 存储错误（通用）
    #[error("Storage error: {0}")]
    Storage(String),

    /// 带结构化 tag 的存储错误。Storage 层用这个抛业务错误码，
    /// 上层 `From<GroveError>` 在 enum 上精确 match，不靠字符串匹配。
    #[error("storage_tagged({tag}): {msg}")]
    StorageTagged { tag: &'static str, msg: String },

    /// 资源不存在（预留，暂未使用）
    #[allow(dead_code)]
    #[error("Not found: {0}")]
    NotFound(String),

    /// 无效数据
    #[allow(dead_code)]
    #[error("{0}")]
    InvalidData(String),
}

/// Grove Result 类型别名
pub type Result<T> = std::result::Result<T, GroveError>;

impl GroveError {
    /// 创建 Git 错误
    pub fn git(msg: impl Into<String>) -> Self {
        Self::Git(msg.into())
    }

    /// 创建 Session 错误
    pub fn session(msg: impl Into<String>) -> Self {
        Self::Session(msg.into())
    }

    /// 创建 Config 错误
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    /// 创建 Storage 错误
    pub fn storage(msg: impl Into<String>) -> Self {
        Self::Storage(msg.into())
    }

    /// 创建带 tag 的 Storage 错误（业务错误码）
    pub fn storage_tagged(tag: &'static str, msg: impl Into<String>) -> Self {
        Self::StorageTagged {
            tag,
            msg: msg.into(),
        }
    }

    /// 取出 storage tag（如果有）
    pub fn storage_tag(&self) -> Option<&'static str> {
        match self {
            Self::StorageTagged { tag, .. } => Some(*tag),
            _ => None,
        }
    }

    /// 创建 NotFound 错误（预留，暂未使用）
    #[allow(dead_code)]
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    /// 创建 InvalidData 错误（预留，暂未使用）
    #[allow(dead_code)]
    pub fn invalid_data(msg: impl Into<String>) -> Self {
        Self::InvalidData(msg.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display() {
        let err = GroveError::git("failed to clone");
        assert_eq!(err.to_string(), "Git error: failed to clone");

        let err = GroveError::session("tmux not found");
        assert_eq!(err.to_string(), "Session error: tmux not found");
    }

    #[test]
    fn test_io_error_conversion() {
        let io_err = io::Error::new(io::ErrorKind::NotFound, "file not found");
        let grove_err: GroveError = io_err.into();
        assert!(matches!(grove_err, GroveError::Io(_)));
    }

    #[test]
    fn test_error_from_string() {
        let err = GroveError::git("test");
        assert!(err.to_string().contains("test"));
    }
}
