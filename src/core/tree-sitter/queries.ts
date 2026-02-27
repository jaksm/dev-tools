/**
 * Tree-sitter symbol extraction queries per language.
 * S-expression queries that identify symbol-worthy AST nodes.
 */

// TypeScript/JavaScript/TSX query — the most complex due to language flexibility.
// Covers ~95% of real-world patterns.
export const TYPESCRIPT_QUERY = `
;; Named function declarations
(function_declaration name: (identifier) @name) @definition.function

;; Class declarations
(class_declaration name: (type_identifier) @name) @definition.class

;; Class methods
(class_declaration
  body: (class_body
    (method_definition
      name: (property_identifier) @name) @definition.method))

;; Interfaces
(interface_declaration name: (type_identifier) @name) @definition.interface

;; Type aliases
(type_alias_declaration name: (type_identifier) @name) @definition.type

;; Enums
(enum_declaration name: (identifier) @name) @definition.enum

;; Arrow functions / function expressions assigned to const/let
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function)) @definition.function)

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression)) @definition.function)

;; Same with var
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function)) @definition.function)

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression)) @definition.function)

;; HOC / factory / wrapped patterns (React.forwardRef, memo, etc.)
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression)) @definition.function)

;; Anonymous default exports
(export_statement
  value: (arrow_function)) @definition.default

(export_statement
  value: (function_expression)) @definition.default

(export_statement
  value: (class)) @definition.default

;; Exported const values (non-function, e.g. export const API_URL = "...")
(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.variable)
`;

// JavaScript-specific query (same as TS minus interfaces/types/enums)
export const JAVASCRIPT_QUERY = `
;; Named function declarations
(function_declaration name: (identifier) @name) @definition.function

;; Class declarations
(class_declaration name: (identifier) @name) @definition.class

;; Class methods
(class_declaration
  body: (class_body
    (method_definition
      name: (property_identifier) @name) @definition.method))

;; Arrow functions / function expressions assigned to const/let
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function)) @definition.function)

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression)) @definition.function)

;; Same with var
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function)) @definition.function)

(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression)) @definition.function)

;; HOC / factory / wrapped patterns
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (call_expression)) @definition.function)

;; Anonymous default exports
(export_statement
  value: (arrow_function)) @definition.default

(export_statement
  value: (function_expression)) @definition.default

(export_statement
  value: (class)) @definition.default

;; module.exports
(assignment_expression
  left: (member_expression
    object: (member_expression
      object: (identifier) @_module
      property: (property_identifier) @_exports)
    property: (property_identifier) @name)
  right: [(function_expression) (arrow_function)]) @definition.function

;; Exported const values
(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name)) @definition.variable)
`;

export const PYTHON_QUERY = `
;; Function definitions
(function_definition name: (identifier) @name) @definition.function

;; Class definitions
(class_definition name: (identifier) @name) @definition.class

;; Decorated definitions are captured via the inner function/class

;; Module-level assignments (constants, important variables)
(module
  (expression_statement
    (assignment
      left: (identifier) @name)) @definition.variable)
`;

export const SWIFT_QUERY = `
;; Functions (including methods inside classes/structs)
(function_declaration (simple_identifier) @name) @definition.function

;; Classes, structs, enums, extensions — all use class_declaration in this grammar
;; The keyword child (struct/class/enum/extension) differentiates them
(class_declaration (type_identifier) @name) @definition.class

;; Protocols
(protocol_declaration (type_identifier) @name) @definition.interface

;; Protocol function declarations
(protocol_function_declaration (simple_identifier) @name) @definition.method

;; Properties (let/var declarations with type annotations)
(property_declaration (pattern (simple_identifier) @name)) @definition.variable

;; Enum cases
(enum_entry (simple_identifier) @name) @definition.variable
`;

export const RUST_QUERY = `
;; Functions
(function_item name: (identifier) @name) @definition.function

;; Structs
(struct_item name: (type_identifier) @name) @definition.class

;; Enums
(enum_item name: (type_identifier) @name) @definition.enum

;; Traits
(trait_item name: (type_identifier) @name) @definition.interface

;; Impl blocks
(impl_item type: (type_identifier) @name) @definition.class

;; Type aliases
(type_item name: (type_identifier) @name) @definition.type
`;

export const GO_QUERY = `
;; Functions
(function_declaration name: (identifier) @name) @definition.function

;; Method declarations
(method_declaration name: (field_identifier) @name) @definition.method

;; Struct types
(type_declaration
  (type_spec name: (type_identifier) @name
    type: (struct_type))) @definition.class

;; Interface types
(type_declaration
  (type_spec name: (type_identifier) @name
    type: (interface_type))) @definition.interface

;; Type aliases
(type_declaration
  (type_spec name: (type_identifier) @name)) @definition.type
`;

export const JAVA_QUERY = `
;; Class declarations
(class_declaration name: (identifier) @name) @definition.class

;; Interface declarations
(interface_declaration name: (identifier) @name) @definition.interface

;; Method declarations
(method_declaration name: (identifier) @name) @definition.method

;; Enum declarations
(enum_declaration name: (identifier) @name) @definition.enum
`;

export const CSHARP_QUERY = `
;; Classes (including nested in namespaces)
(class_declaration name: (identifier) @name) @definition.class

;; Interfaces
(interface_declaration name: (identifier) @name) @definition.interface

;; Structs
(struct_declaration name: (identifier) @name) @definition.class

;; Records
(record_declaration name: (identifier) @name) @definition.class

;; Enums
(enum_declaration name: (identifier) @name) @definition.enum

;; Methods
(method_declaration name: (identifier) @name) @definition.method

;; Properties
(property_declaration name: (identifier) @name) @definition.variable
`;

export const KOTLIN_QUERY = `
;; Classes, interfaces, data classes, enums — all use class_declaration
(class_declaration (type_identifier) @name) @definition.class

;; Functions (including extension functions)
(function_declaration (simple_identifier) @name) @definition.function

;; Object declarations (singletons, companions)
(object_declaration (type_identifier) @name) @definition.class

;; Properties
(property_declaration (variable_declaration (simple_identifier) @name)) @definition.variable
`;

// Map language → query string
export const LANGUAGE_QUERIES: Record<string, string> = {
  typescript: TYPESCRIPT_QUERY,
  tsx: TYPESCRIPT_QUERY,  // TSX uses the same TS grammar
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  swift: SWIFT_QUERY,
  rust: RUST_QUERY,
  go: GO_QUERY,
  java: JAVA_QUERY,
  c_sharp: CSHARP_QUERY,
  kotlin: KOTLIN_QUERY,
};
