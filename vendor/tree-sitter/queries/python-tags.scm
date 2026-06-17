; FORGE-219 (Loom I2b-1) — Python definition captures only.
; Each pattern tags the whole definition node as @def.<kind> (for line spans)
; and the identifier as @name. NO bodies/docstrings are captured — names,
; kinds, and spans only. Hand-authored (tree-sitter-wasms ships wasm only, no
; upstream tags.scm), trimmed to the definitions Loom indexes.
(function_definition name: (identifier) @name) @def.function
(class_definition name: (identifier) @name) @def.class
