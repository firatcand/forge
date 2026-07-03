; FORGE-229 (Loom I2b-2) — C++ reference captures (call sites).
; Direct calls, member calls `obj.f()` / `p->f()`, and qualified calls `NS::f()`.
(call_expression function: (identifier) @ref.call)
(call_expression function: (field_expression field: (field_identifier) @ref.call))
(call_expression function: (qualified_identifier name: (identifier) @ref.call))
