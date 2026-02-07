//! Grove 统一错误类型定义
//!
//! 使用 `thiserror` 库提供统一的错误处理，支持错误链式传播。

use std::io;
use thiserror::Error;

/// Grove 错误类型
#[derive(Debug, Error)]
#[allow(dead_code)] // 逐步迁移中，部分变体尚未使用
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

    /// 存储错误（通用）
    #[error("Storage error: {0}")]
    Storage(String),

    /// 资源不存在
    #[error("Not found: {0}")]
    NotFound(String),

    /// 无效数据
    #[error("Invalid data: {0}")]
    InvalidData(String),
}

/// Grove Result 类型别名
#[allow(dead_code)] // 逐步迁移中，尚未全面使用
pub type Result<T> = std::result::Result<T, GroveError>;

#[allow(dead_code)] // 逐步迁移中，部分方法尚未使用
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

    /// 创建 NotFound 错误
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    /// 创建 InvalidData 错误
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
