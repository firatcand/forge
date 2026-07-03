; FORGE-229 (Loom I2b-2) — Go reference captures (call sites).
; Bare calls `foo()` and selector calls `pkg.Foo()` / `recv.Method()`.
(call_expression function: (identifier) @ref.call)
(call_expression function: (selector_expression field: (field_identifier) @ref.call))
