; FORGE-219 (Loom I2b-1) — JavaScript definition captures only (names/kinds/spans).
(function_declaration name: (identifier) @name) @def.function
(class_declaration name: (identifier) @name) @def.class
(method_definition name: (property_identifier) @name) @def.method
