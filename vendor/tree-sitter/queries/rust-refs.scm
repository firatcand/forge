; FORGE-229 (Loom I2b-2) — Rust reference captures (call sites).
; Bare calls, path calls `module::foo()`, and method calls `recv.foo()`.
; Macro invocations are intentionally NOT captured (macro names are not
; definitions the extractor indexes).
(call_expression function: (identifier) @ref.call)
(call_expression function: (scoped_identifier name: (identifier) @ref.call))
(call_expression function: (field_expression field: (field_identifier) @ref.call))
