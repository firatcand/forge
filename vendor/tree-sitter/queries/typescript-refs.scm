; FORGE-229 (Loom I2b-2) — TypeScript reference captures (call/usage sites).
; Each pattern tags the referenced identifier as @ref.call. Names ONLY — no
; bodies, no arguments. Resolution to a definition happens in symbols.ts.
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression property: (property_identifier) @ref.call))
(new_expression constructor: (identifier) @ref.call)
