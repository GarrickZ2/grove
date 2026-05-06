//! Shared types for the symbol indexer.

use serde::{Deserialize, Serialize};

/// A single symbol definition extracted from source.
///
/// Positions are 0-indexed byte offsets and 0-indexed (row, col) for
/// alignment with tree-sitter and Monaco. Frontend converts to 1-indexed
/// at display time.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SymbolDef {
    pub name: String,
    pub kind: SymbolKind,
    /// Path relative to the worktree root, forward-slash separated.
    pub file_path: String,
    /// 0-indexed line where the symbol's identifier begins.
    pub line: u32,
    /// 0-indexed column where the symbol's identifier begins.
    pub col: u32,
    /// 0-indexed line where the surrounding declaration ends (used for
    /// preview snippets and "peek definition" range hints).
    pub end_line: u32,
    /// Enclosing scope name when known (e.g. the receiver type for a Go
    /// method). `None` for free functions and package-level decls.
    pub container: Option<String>,
    pub language: Language,
}

/// Symbol kind. Kept narrow on purpose — extending only when a new kind
/// genuinely changes ranking or display.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SymbolKind {
    Function,
    Method,
    Struct,
    Interface,
    /// Type alias / non-struct/interface named type.
    Type,
    Const,
    Var,
    /// Struct field — captured so cmd+click on `obj.Field` resolves.
    Field,
}

impl SymbolKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SymbolKind::Function => "function",
            SymbolKind::Method => "method",
            SymbolKind::Struct => "struct",
            SymbolKind::Interface => "interface",
            SymbolKind::Type => "type",
            SymbolKind::Const => "const",
            SymbolKind::Var => "var",
            SymbolKind::Field => "field",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Go,
}

impl Language {
    /// Map a file extension (without the leading dot) to a supported language.
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext {
            "go" => Some(Language::Go),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Language::Go => "go",
        }
    }
}
