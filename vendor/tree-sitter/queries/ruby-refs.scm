; FORGE-229 (Loom I2b-2) — Ruby reference captures (call sites).
; Explicit `call` nodes only (`foo(...)`, `recv.foo`). Bare identifiers are NOT
; captured — in Ruby a bare identifier is ambiguously a local variable or a
; paren-less call, and treating every identifier as a reference would flood the
; graph with false edges.
(call method: (identifier) @ref.call)
