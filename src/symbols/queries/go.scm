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

(type_declaration
  (type_spec
    name: (type_identifier) @name.type)) @def.type

; Constants and package-level variables
(const_declaration
  (const_spec
    name: (identifier) @name.const)) @def.const

(var_declaration
  (var_spec
    name: (identifier) @name.var)) @def.var

; Struct fields (regular + embedded types where field name == type name)
(field_declaration
  name: (field_identifier) @name.field) @def.field

; Interface method elements:  type Foo interface { Bar() int }
; The method belongs to the interface, but tree-sitter doesn't expose a
; tidy `container` link for these without a wider pattern; leaving
; container empty is consistent with how upstream tags.scm treats them.
(method_elem
  name: (field_identifier) @name.method) @def.method
