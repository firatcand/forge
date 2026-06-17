; FORGE-219 (Loom I2b-1) — C definition captures only (names/kinds/spans).
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @def.function
(struct_specifier name: (type_identifier) @name) @def.struct
(type_definition declarator: (type_identifier) @name) @def.type
