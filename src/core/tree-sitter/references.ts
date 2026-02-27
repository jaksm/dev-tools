/**
 * Type-reference extractor — extracts type names referenced across files.
 * Used to build a type-usage dependency graph for languages without
 * file-level imports (Swift) and to enhance ranking for all languages.
 */

import Parser from "web-tree-sitter";

/** Per-language query to capture type references */
const TYPE_REF_QUERIES: Record<string, string> = {
  // Swift: user_type > type_identifier captures all type usages
  swift: "(user_type (type_identifier) @ref)",

  // TypeScript/TSX/JavaScript: type_identifier captures type annotations, generics, etc.
  typescript: "(type_identifier) @ref",
  tsx: "(type_identifier) @ref",
  javascript: "(type_identifier) @ref",

  // Go: type_identifier in signatures, struct fields, etc.
  go: "(type_identifier) @ref",

  // Rust: type_identifier in struct fields, fn signatures, impl blocks, etc.
  rust: "(type_identifier) @ref",

  // Python: type annotations use `type > identifier`
  python: "(type (identifier) @ref)",

  // Java: type_identifier
  java: "(type_identifier) @ref",

  // C#: no type_identifier node — extract from type contexts
  c_sharp: [
    "(base_list (identifier) @ref)",
    "(generic_name (identifier) @ref)",
    "(variable_declaration type: (identifier) @ref)",
    "(type_argument_list (identifier) @ref)",
  ].join("\n"),

  // Kotlin: type_identifier in type references
  kotlin: "(type_identifier) @ref",
};

/**
 * Extract all type names referenced in a file's AST.
 * Returns a deduplicated list of type name strings.
 */
export function extractTypeReferences(
  tree: Parser.Tree,
  language: string,
): string[] {
  const queryStr = TYPE_REF_QUERIES[language];
  if (!queryStr) return [];

  const lang = tree.getLanguage();
  let query: Parser.Query;
  try {
    query = lang.query(queryStr);
  } catch {
    return [];
  }

  const matches = query.matches(tree.rootNode);
  const refs = new Set<string>();

  for (const match of matches) {
    for (const capture of match.captures) {
      if (capture.name === "ref") {
        refs.add(capture.node.text);
      }
    }
  }

  return [...refs];
}
