; FORGE-229 (Loom I2b-2) — TSX reference captures (call/usage sites).
; Mirrors typescript-refs.scm; JSX component usage is intentionally NOT captured
; (component tags resolve via type system semantics tree-sitter cannot see).
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(new_expression constructor: (identifier) @ref.call)
