; FORGE-229 (Loom I2b-2) — Java reference captures (call sites).
; Method invocations and constructor calls (`new Foo(...)`).
(method_invocation name: (identifier) @ref.call)
(object_creation_expression type: (type_identifier) @ref.call)
