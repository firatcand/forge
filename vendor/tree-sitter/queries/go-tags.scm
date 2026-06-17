; FORGE-219 (Loom I2b-1) — Go definition captures only (names/kinds/spans).
(function_declaration name: (identifier) @name) @def.function
(method_declaration name: (field_identifier) @name) @def.method
(type_declaration (type_spec name: (type_identifier) @name)) @def.type
