; Tree-sitter tags query for Go.
;
; Comprehensive coverage — captures every named declaration, not just
; the ctags-traditional set. Both upstream tree-sitter-go's tags.scm
; and earlier versions of this file missed `field_declaration` and
; `method_elem`, which broke cmd+click on struct fields and interface
; method names. Cover them all here so users don't hit gaps.
;
; Each capture name encodes the symbol kind so the extractor can
; populate SymbolDef.kind without a second AST walk.

; Top-level functions
(function_declaration
  name: (identifier) @name.function) @def.function

; Method on a value receiver:  func (s Server) Foo() { ... }
(method_declaration
  receiver: (parameter_list
              (parameter_declaration
                type: (type_identifier) @container.method))
  name: (field_identifier) @name.method) @def.method

; Method on a pointer receiver:  func (s *Server) Foo() { ... }
(method_declaration
  receiver: (parameter_list
              (parameter_declaration
                type: (pointer_type
                        (type_identifier) @container.method)))
  name: (field_identifier) @name.method) @def.method

; Type declarations
(type_declaration
  (type_spec
    name: (type_identifier) @name.struct
    type: (struct_type))) @def.struct

(type_declaration
  (type_spec
    name: (type_identifier) @name.interface
    type: (interface_type))) @def.interface

; Type aliases / non-struct-non-interface named types. Listed explicitly
; per supported `type:` form so we don't duplicate-emit struct/interface
; definitions (which are already captured by the patterns above).
; tree-sitter doesn't have a "not equal to" predicate for child node
; types, hence the verbose enumeration.
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (type_identifier))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (qualified_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (pointer_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (function_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (map_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (channel_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (slice_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (array_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (generic_type))) @def.type
(type_declaration
  (type_spec
    name: (type_identifier) @name.type
    type: (parenthesized_type))) @def.type
; `type T = U` (Go 1.9+ type alias)
(type_declaration
  (type_alias
    name: (type_identifier) @name.type)) @def.type

; Constants and package-level variables
(const_declaration
  (const_spec
    name: (identifier) @name.const)) @def.const

(var_declaration
  (var_spec
    name: (identifier) @name.var)) @def.var

; Struct fields (regular + embedded types where field name == type name)
; Capture the enclosing struct's type name so cmd+click can disambiguate
; same-named fields across different structs in the multi-candidate UI.
(type_declaration
  (type_spec
    name: (type_identifier) @container.field
    type: (struct_type
            (field_declaration_list
              (field_declaration
                name: (field_identifier) @name.field) @def.field))))

; Interface method elements:  type Foo interface { Bar() int }
; Capture the enclosing interface's type name so cmd+click on a method
; from `iface.Method()` can rank candidates by interface name.
(type_declaration
  (type_spec
    name: (type_identifier) @container.method
    type: (interface_type
            (method_elem
              name: (field_identifier) @name.method) @def.method)))
