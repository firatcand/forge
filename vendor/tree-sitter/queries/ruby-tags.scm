; FORGE-219 (Loom I2b-1) — Ruby definition captures only (names/kinds/spans).
(method name: (identifier) @name) @def.method
(singleton_method name: (identifier) @name) @def.method
(class name: (constant) @name) @def.class
(module name: (constant) @name) @def.module
