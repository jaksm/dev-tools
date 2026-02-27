/**
 * Symbol extractor — runs tree-sitter queries against ASTs to extract symbols.
 */

import Parser from "web-tree-sitter";
import path from "node:path";
import { LANGUAGE_QUERIES } from "./queries.js";
import type { SymbolInfo, SymbolKind } from "../types.js";

/**
 * Extract symbols from a parsed AST.
 */
export function extractSymbols(
  tree: Parser.Tree,
  language: string,
  filePath: string,
  source: string,
): SymbolInfo[] {
  const queryStr = LANGUAGE_QUERIES[language];
  if (!queryStr) return [];

  const lang = tree.getLanguage();
  let query: Parser.Query;
  try {
    query = lang.query(queryStr);
  } catch {
    return [];
  }

  const matches = query.matches(tree.rootNode);
  const symbols: SymbolInfo[] = [];
  const lines = source.split("\n");

  // Track classes for qualified name building
  const classNames: Map<number, string> = new Map();

  // First pass: collect class names
  for (const match of matches) {
    const patternName = getPatternName(match);
    if (patternName === "class" || patternName === "interface" || patternName === "enum") {
      const nameCapture = match.captures.find(c => c.name === "name");
      if (nameCapture) {
        const defCapture = match.captures.find(c => c.name.startsWith("definition."));
        if (defCapture) {
          classNames.set(defCapture.node.startPosition.row, nameCapture.node.text);
        }
      }
    }
  }

  for (const match of matches) {
    const patternName = getPatternName(match);
    if (!patternName) continue;

    const defCapture = match.captures.find(c => c.name.startsWith("definition."));
    if (!defCapture) continue;

    const nameCapture = match.captures.find(c => c.name === "name");
    const node = defCapture.node;

    const kind = mapKind(patternName);
    let name: string;

    if (patternName === "default") {
      const basename = path.basename(filePath, path.extname(filePath));
      name = `${basename}::default`;
    } else if (!nameCapture) {
      continue;
    } else {
      name = nameCapture.node.text;
    }

    // Build qualified name for methods
    let qualifiedName = name;
    if (kind === "method") {
      const parentClass = findParentClass(node, classNames);
      if (parentClass) {
        qualifiedName = `${parentClass}.${name}`;
      }
    }

    const docs = extractDocs(lines, node.startPosition.row);
    const startLine = node.startPosition.row;
    const endLine = node.endPosition.row;
    const signature = buildSignature(lines, startLine, kind);
    const code = lines.slice(startLine, endLine + 1).join("\n");

    symbols.push({
      qualifiedName,
      kind,
      filePath,
      lines: [startLine + 1, endLine + 1],
      signature,
      docs,
      code,
    });
  }

  return symbols;
}

function getPatternName(match: Parser.QueryMatch): string | null {
  for (const capture of match.captures) {
    if (capture.name.startsWith("definition.")) {
      return capture.name.replace("definition.", "");
    }
  }
  return null;
}

function mapKind(patternName: string): SymbolKind {
  switch (patternName) {
    case "function": return "function";
    case "class": return "class";
    case "method": return "method";
    case "interface": return "interface";
    case "type": return "type";
    case "enum": return "enum";
    case "variable": return "variable";
    case "default": return "function";
    default: return "function";
  }
}

function findParentClass(node: Parser.SyntaxNode, classNames: Map<number, string>): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "class_body") {
      const classDecl = current.parent;
      if (classDecl) {
        const className = classNames.get(classDecl.startPosition.row);
        if (className) return className;
      }
    }
    current = current.parent;
  }
  return null;
}

function extractDocs(lines: string[], defLine: number): string | null {
  if (defLine === 0) return null;

  let endIdx = defLine - 1;
  while (endIdx >= 0 && lines[endIdx].trim() === "") endIdx--;
  if (endIdx < 0) return null;

  const endLine = lines[endIdx].trim();

  if (endLine.endsWith("*/")) {
    let startIdx = endIdx;
    while (startIdx > 0 && !lines[startIdx].trim().startsWith("/**") && !lines[startIdx].trim().startsWith("/*")) {
      startIdx--;
    }
    const docLines = lines.slice(startIdx, endIdx + 1)
      .map(l => l.trim().replace(/^\/\*\*?\s?/, "").replace(/\*\/\s?$/, "").replace(/^\*\s?/, ""))
      .filter(l => l.length > 0);
    return docLines.join(" ").trim() || null;
  }

  if (endLine.startsWith("//") || endLine.startsWith("#") || endLine.startsWith("///")) {
    let startIdx = endIdx;
    while (startIdx > 0) {
      const prev = lines[startIdx - 1].trim();
      if (prev.startsWith("//") || prev.startsWith("#") || prev.startsWith("///")) {
        startIdx--;
      } else {
        break;
      }
    }
    const docLines = lines.slice(startIdx, endIdx + 1)
      .map(l => l.trim().replace(/^\/\/\/?\s?/, "").replace(/^#\s?/, ""))
      .filter(l => l.length > 0);
    return docLines.join(" ").trim() || null;
  }

  return null;
}

function buildSignature(lines: string[], startLine: number, kind: SymbolKind): string {
  const line = lines[startLine]?.trim() ?? "";

  if (kind === "class" || kind === "interface" || kind === "enum") {
    return line.replace(/\{.*$/, "").trim();
  }

  let sig = line;
  if (!sig.includes("{") && !sig.includes("=>")) {
    for (let i = startLine + 1; i < Math.min(startLine + 5, lines.length); i++) {
      sig += " " + lines[i].trim();
      if (sig.includes("{") || sig.includes("=>")) break;
    }
  }

  const braceIdx = sig.indexOf("{");
  if (braceIdx > 0) sig = sig.substring(0, braceIdx).trim();

  return sig;
}
