/**
 * Import/export extractor — extract import and export statements from ASTs.
 */

import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import type { ImportInfo, ExportInfo } from "../types.js";
import type { AliasResolver } from "./tsconfig-resolver.js";

export interface ImportExtractorOptions {
  aliasResolver?: AliasResolver | null;
  workspaceDir?: string;
}

export function extractImports(
  tree: Parser.Tree,
  language: string,
  filePath: string,
  aliasResolverOrOpts?: AliasResolver | null | ImportExtractorOptions,
): ImportInfo[] {
  const imports: ImportInfo[] = [];
  const rootNode = tree.rootNode;

  // Normalize options: support both legacy (aliasResolver) and new (options) signatures
  let opts: ImportExtractorOptions;
  if (aliasResolverOrOpts && typeof aliasResolverOrOpts === "object" && "workspaceDir" in aliasResolverOrOpts) {
    opts = aliasResolverOrOpts;
  } else {
    opts = { aliasResolver: aliasResolverOrOpts as AliasResolver | null | undefined };
  }

  if (language === "typescript" || language === "tsx" || language === "javascript") {
    extractTSImports(rootNode, filePath, imports, opts.aliasResolver);
  } else if (language === "python") {
    extractPythonImports(rootNode, filePath, imports, opts.workspaceDir);
  } else if (language === "go") {
    extractGoImports(rootNode, imports);
  } else if (language === "rust") {
    extractRustImports(rootNode, imports);
  }

  return imports;
}

export function extractExports(
  tree: Parser.Tree,
  language: string,
  _filePath: string,
): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const rootNode = tree.rootNode;

  if (language === "typescript" || language === "tsx" || language === "javascript") {
    extractTSExports(rootNode, exports);
  } else if (language === "python") {
    extractPythonExports(rootNode, exports);
  } else if (language === "go") {
    extractGoExports(rootNode, exports);
  } else if (language === "rust") {
    extractRustExports(rootNode, exports);
  } else if (language === "swift") {
    extractSwiftExports(rootNode, exports);
  } else if (language === "java") {
    extractJavaExports(rootNode, exports);
  } else if (language === "c_sharp") {
    extractCSharpExports(rootNode, exports);
  } else if (language === "kotlin") {
    extractKotlinExports(rootNode, exports);
  }

  return exports;
}

function extractTSImports(node: Parser.SyntaxNode, filePath: string, imports: ImportInfo[], aliasResolver?: AliasResolver | null): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "import_statement") {
      const sourceNode = child.childForFieldName("source");
      if (sourceNode) {
        const raw = sourceNode.text.replace(/['"]/g, "");
        let resolved = resolveImportPath(raw, filePath);
        let isRelative = raw.startsWith(".");
        const names: string[] = [];

        // Try alias resolution for non-relative imports
        if (!isRelative && aliasResolver) {
          const aliasResolved = aliasResolver(raw);
          if (aliasResolved) {
            resolved = aliasResolved;
            isRelative = true;
          }
        }

        for (let j = 0; j < child.childCount; j++) {
          const c = child.child(j);
          if (c?.type === "import_clause") {
            collectNames(c, names);
          }
        }

        imports.push({
          source: raw,
          resolved,
          names,
          line: child.startPosition.row + 1,
          isRelative,
        });
      }
    }

    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      const text = child.text;
      const requireMatch = text.match(/require\(['"]([^'"]+)['"]\)/);
      if (requireMatch) {
        const raw = requireMatch[1];
        let resolved = resolveImportPath(raw, filePath);
        let isRelative = raw.startsWith(".");

        if (!isRelative && aliasResolver) {
          const aliasResolved = aliasResolver(raw);
          if (aliasResolved) {
            resolved = aliasResolved;
            isRelative = true;
          }
        }

        imports.push({
          source: raw,
          resolved,
          names: [],
          line: child.startPosition.row + 1,
          isRelative,
        });
      }
    }
  }
}

function collectNames(node: Parser.SyntaxNode, names: string[]): void {
  if (node.type === "identifier") {
    names.push(node.text);
  } else if (node.type === "import_specifier") {
    const alias = node.childForFieldName("alias");
    const nameNode = node.childForFieldName("name");
    names.push((alias ?? nameNode)?.text ?? "");
  } else {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) collectNames(child, names);
    }
  }
}

function extractTSExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "export_statement") {
      const isDefault = child.text.includes("export default");
      const declaration = child.childForFieldName("declaration");

      if (declaration) {
        const nameNode = declaration.childForFieldName("name");
        if (nameNode) {
          exports.push({ name: nameNode.text, isDefault, line: child.startPosition.row + 1 });
        } else if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
          for (let j = 0; j < declaration.childCount; j++) {
            const decl = declaration.child(j);
            if (decl?.type === "variable_declarator") {
              const n = decl.childForFieldName("name");
              if (n) exports.push({ name: n.text, isDefault, line: child.startPosition.row + 1 });
            }
          }
        }
      } else if (isDefault) {
        exports.push({ name: "default", isDefault: true, line: child.startPosition.row + 1 });
      }

      for (let j = 0; j < child.childCount; j++) {
        const c = child.child(j);
        if (c?.type === "export_clause") {
          for (let k = 0; k < c.childCount; k++) {
            const spec = c.child(k);
            if (spec?.type === "export_specifier") {
              const nameNode = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
              if (nameNode) exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }
}

function extractPythonImports(
  node: Parser.SyntaxNode,
  filePath: string,
  imports: ImportInfo[],
  workspaceDir?: string,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "import_statement" || child.type === "import_from_statement") {
      const text = child.text;
      const fromMatch = text.match(/from\s+(\S+)\s+import\s+(.+)/);
      const importMatch = text.match(/^import\s+(.+)/);

      if (fromMatch) {
        const raw = fromMatch[1];
        const names = fromMatch[2].split(",").map((n: string) => n.trim().split(" as ").pop()!.trim()).filter(n => n.length > 0 && !n.startsWith("("));
        const isRelative = raw.startsWith(".");
        const resolved = resolvePythonImport(raw, filePath, workspaceDir);
        imports.push({ source: raw, resolved, names, line: child.startPosition.row + 1, isRelative: isRelative || resolved !== null });
      } else if (importMatch) {
        const raw = importMatch[1].trim();
        const resolved = resolvePythonImport(raw, filePath, workspaceDir);
        imports.push({ source: raw, resolved, names: [raw.split(".").pop()!], line: child.startPosition.row + 1, isRelative: resolved !== null });
      }
    }
  }
}

/**
 * Resolve a Python import to an absolute file path.
 *
 * Relative imports (from .utils, from ..cli.dicts):
 *   Count leading dots, go up that many package levels from current file, resolve remainder.
 *
 * Absolute imports (import httpie.cli.dicts, from httpie.models):
 *   Convert dots to path separators, resolve from workspace root.
 *
 * Module resolution: try module.py then module/__init__.py
 */
function resolvePythonImport(
  raw: string,
  filePath: string,
  workspaceDir?: string,
): string | null {
  if (raw.startsWith(".")) {
    return resolvePythonRelative(raw, filePath);
  }
  if (workspaceDir) {
    return resolvePythonAbsolute(raw, workspaceDir);
  }
  return null;
}

function resolvePythonRelative(raw: string, filePath: string): string | null {
  // Count leading dots
  let dots = 0;
  while (dots < raw.length && raw[dots] === ".") dots++;
  const remainder = raw.slice(dots);

  // Start from current file's directory, go up (dots - 1) levels
  // (1 dot = current package, 2 dots = parent package, etc.)
  let base = path.dirname(filePath);
  for (let i = 1; i < dots; i++) {
    base = path.dirname(base);
  }

  if (!remainder) {
    // `from . import X` — refers to __init__.py of current package
    return resolvePythonModule(base);
  }

  const modulePath = path.join(base, ...remainder.split("."));
  return resolvePythonModule(modulePath);
}

function resolvePythonAbsolute(raw: string, workspaceDir: string): string | null {
  const parts = raw.split(".");
  const modulePath = path.join(workspaceDir, ...parts);
  return resolvePythonModule(modulePath);
}

function resolvePythonModule(modulePath: string): string | null {
  // Try: module.py
  const pyFile = modulePath + ".py";
  try {
    const stat = fs.statSync(pyFile);
    if (stat.isFile()) return pyFile;
  } catch { /* continue */ }

  // Try: module/__init__.py (package)
  const initFile = path.join(modulePath, "__init__.py");
  try {
    const stat = fs.statSync(initFile);
    if (stat.isFile()) return initFile;
  } catch { /* continue */ }

  return null;
}

function extractGoImports(node: Parser.SyntaxNode, imports: ImportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "import_declaration") {
      const text = child.text;
      const matches = text.matchAll(/"([^"]+)"/g);
      for (const m of matches) {
        imports.push({ source: m[1], resolved: null, names: [m[1].split("/").pop()!], line: child.startPosition.row + 1, isRelative: false });
      }
    }
  }
}

function extractRustImports(node: Parser.SyntaxNode, imports: ImportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "use_declaration") {
      const text = child.text.replace(/^use\s+/, "").replace(/;$/, "").trim();
      imports.push({
        source: text, resolved: null,
        names: [text.split("::").pop()!],
        line: child.startPosition.row + 1,
        isRelative: text.startsWith("self::") || text.startsWith("super::") || text.startsWith("crate::"),
      });
    }
  }
}

// ── Export extractors per language ──────────────────────────────────────────

/**
 * Python: top-level functions, classes, and non-underscore-prefixed assignments.
 */
function extractPythonExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "function_definition") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && !nameNode.text.startsWith("_")) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "class_definition") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && !nameNode.text.startsWith("_")) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "expression_statement") {
      // Top-level assignments: X = ...
      const expr = child.child(0);
      if (expr?.type === "assignment") {
        const left = expr.childForFieldName("left");
        if (left?.type === "identifier" && !left.text.startsWith("_")) {
          exports.push({ name: left.text, isDefault: false, line: child.startPosition.row + 1 });
        }
      }
    } else if (child.type === "decorated_definition") {
      // Decorated functions/classes
      for (let j = 0; j < child.childCount; j++) {
        const inner = child.child(j);
        if (inner && (inner.type === "function_definition" || inner.type === "class_definition")) {
          const nameNode = inner.childForFieldName("name");
          if (nameNode && !nameNode.text.startsWith("_")) {
            exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
          }
        }
      }
    }
  }
}

/**
 * Go: top-level declarations where name starts with uppercase (exported).
 */
function extractGoExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === "function_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && isGoExported(nameNode.text)) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "method_declaration") {
      const nameNode = child.childForFieldName("name");
      if (nameNode && isGoExported(nameNode.text)) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "type_declaration") {
      // type X struct { ... }
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec?.type === "type_spec") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode && isGoExported(nameNode.text)) {
            exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
          }
        }
      }
    } else if (child.type === "var_declaration" || child.type === "const_declaration") {
      // var/const X = ... or var/const ( X = ... ; Y = ... )
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec?.type === "var_spec" || spec?.type === "const_spec") {
          const nameNode = spec.childForFieldName("name");
          if (nameNode && isGoExported(nameNode.text)) {
            exports.push({ name: nameNode.text, isDefault: false, line: spec.startPosition.row + 1 });
          }
        }
      }
    }
  }
}

function isGoExported(name: string): boolean {
  return name.length > 0 && name[0] >= "A" && name[0] <= "Z";
}

/**
 * Rust: declarations with `pub` visibility modifier.
 */
function extractRustExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  const pubTypes = ["function_item", "struct_item", "enum_item", "trait_item", "type_item", "const_item", "static_item"];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (pubTypes.includes(child.type) && child.text.startsWith("pub ")) {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "impl_item") {
      // pub methods inside impl blocks
      for (let j = 0; j < child.childCount; j++) {
        const block = child.child(j);
        if (block?.type === "declaration_list") {
          for (let k = 0; k < block.childCount; k++) {
            const item = block.child(k);
            if (item?.type === "function_item" && item.text.startsWith("pub ")) {
              const nameNode = item.childForFieldName("name");
              if (nameNode) {
                exports.push({ name: nameNode.text, isDefault: false, line: item.startPosition.row + 1 });
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Swift: all top-level declarations are module-internal (accessible within project).
 * Private declarations are excluded.
 */
function extractSwiftExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Skip private/fileprivate declarations
    let isPrivate = false;
    for (let j = 0; j < child.childCount; j++) {
      const mod = child.child(j);
      if (mod?.type === "modifiers" && (mod.text.includes("private") || mod.text.includes("fileprivate"))) {
        isPrivate = true;
        break;
      }
    }
    if (isPrivate) continue;

    if (child.type === "class_declaration") {
      // class, struct, enum, extension
      const nameNode = findChildOfType(child, "type_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
      // Also extract non-private methods/properties from body
      const body = findChildOfType(child, "class_body") ?? findChildOfType(child, "enum_class_body");
      if (body) extractSwiftBodyExports(body, exports);
    } else if (child.type === "function_declaration") {
      const nameNode = findChildOfType(child, "simple_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "protocol_declaration") {
      const nameNode = findChildOfType(child, "type_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    }
  }
}

function extractSwiftBodyExports(body: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;

    // Skip private members
    let isPrivate = false;
    for (let j = 0; j < child.childCount; j++) {
      const mod = child.child(j);
      if (mod?.type === "modifiers" && (mod.text.includes("private") || mod.text.includes("fileprivate"))) {
        isPrivate = true;
        break;
      }
    }
    if (isPrivate) continue;

    if (child.type === "function_declaration") {
      const nameNode = findChildOfType(child, "simple_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "property_declaration") {
      const pattern = findChildOfType(child, "pattern");
      if (pattern) {
        const nameNode = findChildOfType(pattern, "simple_identifier");
        if (nameNode) {
          exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
        }
      }
    } else if (child.type === "enum_entry") {
      const nameNode = findChildOfType(child, "simple_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    }
  }
}

function findChildOfType(node: Parser.SyntaxNode, type: string): Parser.SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) return child;
  }
  return null;
}

/**
 * Java/Kotlin/C#: public class/interface/enum and their public methods.
 */
function extractJavaExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    const classTypes = ["class_declaration", "interface_declaration", "enum_declaration"];
    if (classTypes.includes(child.type)) {
      // Check for public modifier
      const isPublic = hasModifier(child, "public");
      const nameNode = child.childForFieldName("name");
      if (nameNode && isPublic) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }

      // Extract public methods from class body
      const body = child.childForFieldName("body");
      if (body) {
        for (let j = 0; j < body.childCount; j++) {
          const member = body.child(j);
          if (member?.type === "method_declaration" && hasModifier(member, "public")) {
            const mName = member.childForFieldName("name");
            if (mName) {
              exports.push({ name: mName.text, isDefault: false, line: member.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }
}

function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    // Swift/Kotlin: `modifiers` container node
    if (child?.type === "modifiers") {
      return child.text.includes(modifier);
    }
    // C#: singular `modifier` node with text like "public"
    if (child?.type === "modifier" && child.text === modifier) return true;
    // Java: direct modifier token node
    if (child?.type === modifier) return true;
  }
  return false;
}

/**
 * C#: public class/interface/struct/record/enum and their public methods.
 * Must recurse into namespace_declaration > declaration_list.
 */
function extractCSharpExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Recurse into namespaces
    if (child.type === "namespace_declaration" || child.type === "file_scoped_namespace_declaration") {
      const declList = findChildOfType(child, "declaration_list");
      if (declList) extractCSharpExports(declList, exports);
      // file-scoped namespaces don't have declaration_list — members are siblings
      else extractCSharpExports(child, exports);
      continue;
    }

    const typeDecls = ["class_declaration", "interface_declaration", "struct_declaration", "record_declaration", "enum_declaration"];
    if (typeDecls.includes(child.type)) {
      const isPublic = hasModifier(child, "public");
      const nameNode = child.childForFieldName("name");
      if (nameNode && isPublic) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }

      // Extract public methods/properties from body
      const body = child.childForFieldName("body") ?? findChildOfType(child, "declaration_list");
      if (body) {
        for (let j = 0; j < body.childCount; j++) {
          const member = body.child(j);
          if (!member) continue;
          if ((member.type === "method_declaration" || member.type === "property_declaration") && hasModifier(member, "public")) {
            const mName = member.childForFieldName("name");
            if (mName) {
              exports.push({ name: mName.text, isDefault: false, line: member.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }
}

/**
 * Kotlin: top-level declarations are public by default.
 * Skip private/internal declarations.
 */
function extractKotlinExports(node: Parser.SyntaxNode, exports: ExportInfo[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    // Check for private/internal visibility modifiers
    let isPrivate = false;
    for (let j = 0; j < child.childCount; j++) {
      const mod = child.child(j);
      if (mod?.type === "modifiers" && (mod.text.includes("private") || mod.text.includes("internal"))) {
        isPrivate = true;
        break;
      }
    }
    if (isPrivate) continue;

    if (child.type === "class_declaration") {
      const nameNode = findChildOfType(child, "type_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "object_declaration") {
      const nameNode = findChildOfType(child, "type_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "function_declaration") {
      const nameNode = findChildOfType(child, "simple_identifier");
      if (nameNode) {
        exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
      }
    } else if (child.type === "property_declaration") {
      // Top-level val/var
      const varDecl = findChildOfType(child, "variable_declaration");
      if (varDecl) {
        const nameNode = findChildOfType(varDecl, "simple_identifier");
        if (nameNode) {
          exports.push({ name: nameNode.text, isDefault: false, line: child.startPosition.row + 1 });
        }
      }
    }
  }
}

function resolveImportPath(raw: string, filePath: string): string | null {
  if (!raw.startsWith(".")) return null;
  const dir = path.dirname(filePath);
  return path.resolve(dir, raw);
}
