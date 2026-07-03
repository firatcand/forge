; FORGE-229 (Loom I2b-2) — C reference captures (call sites).
; Direct calls only — calls through function pointers/macros are invisible to
; name-based resolution and intentionally skipped.
(call_expression function: (identifier) @ref.call)
