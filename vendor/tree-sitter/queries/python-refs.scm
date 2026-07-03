; FORGE-229 (Loom I2b-2) — Python reference captures (call sites).
; Bare calls `foo()` and attribute calls `obj.foo()` — the trailing identifier
; is the resolution key (name-based; receiver types are invisible to tree-sitter).
(call function: (identifier) @ref.call)
(call function: (attribute attribute: (identifier) @ref.call))
