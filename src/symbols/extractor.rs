//! Source-bytes → `Vec<SymbolDef>`.
//!
//! Owns the tree-sitter `Parser` and pre-compiled `Query` for each
//! supported language, lazily initialized on first use.

use once_cell::sync::Lazy;
use std::sync::Mutex;

use tree_sitter::{Parser, Query, QueryCursor, StreamingIterator};

use super::types::{Language, SymbolDef, SymbolKind};

const GO_QUERY_SRC: &str = include_str!("queries/go.scm");

/// Pre-compiled query for the Go grammar.
static GO_QUERY: Lazy<Query> = Lazy::new(|| {
    Query::new(&tree_sitter_go::LANGUAGE.into(), GO_QUERY_SRC)
        .expect("invalid Go tags query (queries/go.scm)")
});

/// Thread-local-ish parser pool. Tree-sitter parsers are not thread-safe,
/// but they are cheap to create and cheaper to reuse. Keep one parser per
/// language behind a Mutex; symbol indexing is rarely contended (one
/// rayon thread parses a file at a time per language).
static GO_PARSER: Lazy<Mutex<Parser>> = Lazy::new(|| {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .expect("failed to load tree-sitter-go grammar");
    Mutex::new(parser)
});

/// Extract all symbol definitions from `source` for the given language.
///
/// `file_path` is stored verbatim into each returned `SymbolDef` —
/// callers are expected to have already normalized it (relative to
/// worktree root, forward slashes).
pub fn extract(language: Language, file_path: &str, source: &[u8]) -> Vec<SymbolDef> {
    match language {
        Language::Go => extract_with(&GO_PARSER, &GO_QUERY, language, file_path, source),
    }
}

fn extract_with(
    parser: &Mutex<Parser>,
    query: &Query,
    language: Language,
    file_path: &str,
    source: &[u8],
) -> Vec<SymbolDef> {
    let mut parser = match parser.lock() {
        Ok(p) => p,
        Err(p) => p.into_inner(), // Recover from a poisoned parser; the
                                  // previous panic was on a different file.
    };
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let mut cursor = QueryCursor::new();
    let capture_names = query.capture_names();
    let mut matches = cursor.matches(query, tree.root_node(), source);

    while let Some(m) = matches.next() {
        // For each match, pick the @def.<kind> capture to get the full
        // declaration range, and the @name.<kind> capture to get the
        // identifier position. Method matches additionally carry an
        // optional @container.method capture (the receiver type name).
        let mut def_range: Option<(SymbolKind, u32)> = None; // (kind, end_line)
        let mut name_node: Option<(SymbolKind, &str, u32, u32)> = None;
        let mut container: Option<String> = None;

        for cap in m.captures {
            let cname = capture_names[cap.index as usize];
            let node = cap.node;
            if let Some(rest) = cname.strip_prefix("def.") {
                if let Some(kind) = parse_kind(rest) {
                    def_range = Some((kind, node.end_position().row as u32));
                }
            } else if let Some(rest) = cname.strip_prefix("name.") {
                if let Some(kind) = parse_kind(rest) {
                    let text = node.utf8_text(source).unwrap_or("");
                    let pos = node.start_position();
                    name_node = Some((kind, text, pos.row as u32, pos.column as u32));
                }
            } else if cname == "container.method" {
                if let Ok(t) = node.utf8_text(source) {
                    container = Some(t.to_string());
                }
            }
        }

        if let (Some((nkind, name, line, col)), Some((dkind, end_line))) = (name_node, def_range) {
            // Sanity: name and def captures should agree on kind because
            // the query pairs them. Use def kind as authoritative.
            let _ = nkind;
            out.push(SymbolDef {
                name: name.to_string(),
                kind: dkind,
                file_path: file_path.to_string(),
                line,
                col,
                end_line,
                container: container.clone(),
                language,
            });
        }
    }

    out
}

fn parse_kind(s: &str) -> Option<SymbolKind> {
    match s {
        "function" => Some(SymbolKind::Function),
        "method" => Some(SymbolKind::Method),
        "struct" => Some(SymbolKind::Struct),
        "interface" => Some(SymbolKind::Interface),
        "type" => Some(SymbolKind::Type),
        "const" => Some(SymbolKind::Const),
        "var" => Some(SymbolKind::Var),
        "field" => Some(SymbolKind::Field),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(src: &str) -> Vec<(String, SymbolKind, Option<String>)> {
        extract(Language::Go, "x.go", src.as_bytes())
            .into_iter()
            .map(|s| (s.name, s.kind, s.container))
            .collect()
    }

    #[test]
    fn extracts_function() {
        let src = r#"
            package foo
            func ParseConfig(raw string) (Config, error) { return Config{}, nil }
        "#;
        let got = names(src);
        assert!(got.contains(&("ParseConfig".into(), SymbolKind::Function, None)));
    }

    #[test]
    fn extracts_method_with_receiver() {
        let src = r#"
            package foo
            type Server struct{}
            func (s *Server) Start() error { return nil }
        "#;
        let got = names(src);
        assert!(got.iter().any(|(n, k, c)| {
            n == "Start" && *k == SymbolKind::Method && c.as_deref() == Some("Server")
        }));
    }

    #[test]
    fn extracts_struct_and_interface() {
        let src = r#"
            package foo
            type Config struct { Name string }
            type Handler interface { Handle() error }
        "#;
        let got = names(src);
        assert!(got.contains(&("Config".into(), SymbolKind::Struct, None)));
        assert!(got.contains(&("Handler".into(), SymbolKind::Interface, None)));
    }

    #[test]
    fn extracts_interface_methods() {
        let src = r#"
            package foo
            type Greeter interface {
                Hello(name string) string
                Goodbye() error
            }
        "#;
        let got = names(src);
        assert!(got.iter().any(|(n, k, _)| n == "Hello" && *k == SymbolKind::Method));
        assert!(got.iter().any(|(n, k, _)| n == "Goodbye" && *k == SymbolKind::Method));
    }

    #[test]
    fn extracts_struct_fields() {
        let src = r#"
            package foo
            type Item struct {
                Id      int64
                Title   string
                Content string
            }
            type Server struct {
                addr string
                Logger
            }
        "#;
        let got = names(src);
        assert!(got.contains(&("Id".into(), SymbolKind::Field, None)));
        assert!(got.contains(&("Title".into(), SymbolKind::Field, None)));
        assert!(got.contains(&("Content".into(), SymbolKind::Field, None)));
        assert!(got.contains(&("addr".into(), SymbolKind::Field, None)));
    }

    #[test]
    fn extracts_const_and_var() {
        let src = r#"
            package foo
            const MaxRetries = 3
            var DefaultTimeout = 30
        "#;
        let got = names(src);
        assert!(got.contains(&("MaxRetries".into(), SymbolKind::Const, None)));
        assert!(got.contains(&("DefaultTimeout".into(), SymbolKind::Var, None)));
    }

    #[test]
    fn empty_file_returns_empty() {
        assert!(extract(Language::Go, "x.go", b"").is_empty());
        assert!(extract(Language::Go, "x.go", b"package foo\n").is_empty());
    }

    #[test]
    fn parse_error_does_not_panic() {
        // Malformed Go: unmatched brace. tree-sitter is error-tolerant
        // and still produces a tree; valid sub-trees should yield symbols.
        let src = "package foo\nfunc Good() {}\nfunc Bad( {";
        let got = names(src);
        assert!(got.iter().any(|(n, _, _)| n == "Good"));
    }
}
