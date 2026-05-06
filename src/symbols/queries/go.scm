; Tree-sitter tags query for Go.
;
; Captures top-level symbol definitions:
;   - functions, methods
;   - types: struct, interface, alias
;   - constants and package-level vars
;
; Each capture name encodes the symbol kind so the extractor can
; populate SymbolDef.kind without a second AST walk.

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

(const_declaration
  (const_spec
    name: (identifier) @name.const)) @def.const

(var_declaration
  (var_spec
    name: (identifier) @name.var)) @def.var
