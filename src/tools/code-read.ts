/**
 * code_read tool — read a specific symbol's source code.
 * Context modes: siblings, class, dependencies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SymbolInfo, ToolContext, ToolResult } from "../core/types.js";
import { SymbolIndex } from "../core/index/symbol-index.js";
import { resolveSymbol, type ResolveInput } from "../core/index/resolver.js";

export interface CodeReadParams {
  symbol: string;
  file?: string;
  scope?: string;
  context?: "siblings" | "class" | "dependencies";
}

export interface DependencyInfo {
  symbol: string;
  kind: string;
  signature: string;
  lines?: [number, number];
}

export interface CodeReadResult {
  code: string;
  file: string;
  lines: [number, number];
  imports: string[];
  language: string;
  siblings?: Array<{ name: string; kind: string; signature: string }>;
  classOutline?: Array<{ name: string; kind: string; signature: string; expanded?: boolean }>;
  dependencies?: DependencyInfo[];
}

/**
 * Read a symbol's source code.
 */
export async function codeRead(
  params: CodeReadParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
): Promise<ToolResult<CodeReadResult>> {
  const input: ResolveInput = {
    symbol: params.symbol,
    file: params.file ? resolveFilePath(params.file, ctx.workspaceDir) : undefined,
    scope: params.scope,
  };

  const resolution = resolveSymbol(input, symbolIndex);

  if (resolution.symbols.length === 0) {
    return {
      success: false,
      error: `Symbol not found: ${params.symbol}`,
      summary: `Could not find symbol "${params.symbol}" in the index`,
    };
  }

  if (resolution.ambiguous && !params.file) {
    const locations = resolution.symbols.map(s =>
      `  ${s.qualifiedName} in ${path.relative(ctx.workspaceDir, s.filePath)}:${s.lines[0]}`,
    );
    return {
      success: false,
      error: `Ambiguous symbol "${params.symbol}" found in ${resolution.symbols.length} locations:\n${locations.join("\n")}\nSpecify a file to disambiguate.`,
    };
  }

  const symbol = resolution.symbols[0];

  // Read the file
  let fileContent: string;
  try {
    fileContent = await fs.readFile(symbol.filePath, "utf-8");
  } catch {
    return { success: false, error: `Cannot read file: ${symbol.filePath}` };
  }

  const lines = fileContent.split("\n");
  const code = lines.slice(symbol.lines[0] - 1, symbol.lines[1]).join("\n");

  // Extract imports from the file
  const importLines = lines.filter(l =>
    l.trimStart().startsWith("import ") || l.includes("require("),
  );
  const imports = importLines.map(l => {
    const match = l.match(/from\s+['"]([^'"]+)['"]/) ?? l.match(/require\(['"]([^'"]+)['"]\)/);
    return match?.[1] ?? l.trim();
  });

  const language = getLanguageFromPath(symbol.filePath);
  const relativePath = path.relative(ctx.workspaceDir, symbol.filePath);

  const result: CodeReadResult = {
    code,
    file: relativePath,
    lines: symbol.lines as [number, number],
    imports,
    language,
  };

  // Context modes
  if (params.context === "siblings") {
    result.siblings = getSiblings(symbol, symbolIndex);
  } else if (params.context === "class") {
    result.classOutline = getClassOutline(symbol, symbolIndex);
  } else if (params.context === "dependencies") {
    result.dependencies = getDependencies(symbol, lines, symbolIndex);
  }

  return {
    success: true,
    data: result,
    summary: `${symbol.qualifiedName} (${symbol.lines[1] - symbol.lines[0] + 1} lines) from ${relativePath}`,
  };
}

/**
 * Get signatures of adjacent symbols (siblings context mode).
 */
function getSiblings(symbol: SymbolInfo, index: SymbolIndex): Array<{ name: string; kind: string; signature: string }> {
  const fileSymbols = index.lookupByFile(symbol.filePath);
  const idx = fileSymbols.findIndex(s => s.qualifiedName === symbol.qualifiedName && s.lines[0] === symbol.lines[0]);
  if (idx < 0) return [];

  const siblings: Array<{ name: string; kind: string; signature: string }> = [];

  // Previous sibling
  if (idx > 0) {
    const prev = fileSymbols[idx - 1];
    siblings.push({ name: prev.qualifiedName, kind: prev.kind, signature: prev.signature });
  }

  // Next sibling
  if (idx < fileSymbols.length - 1) {
    const next = fileSymbols[idx + 1];
    siblings.push({ name: next.qualifiedName, kind: next.kind, signature: next.signature });
  }

  return siblings;
}

/**
 * Get class outline with the target method expanded (class context mode).
 */
function getClassOutline(
  symbol: SymbolInfo,
  index: SymbolIndex,
): Array<{ name: string; kind: string; signature: string; expanded?: boolean }> {
  // Find the parent class
  const parentName = symbol.qualifiedName.split(".")[0];
  if (parentName === symbol.qualifiedName) {
    // Not a method — return file outline instead
    return index.lookupByFile(symbol.filePath).map(s => ({
      name: s.qualifiedName,
      kind: s.kind,
      signature: s.signature,
      expanded: s.qualifiedName === symbol.qualifiedName,
    }));
  }

  // Get all symbols for the class
  const classSymbols = index.lookupByFile(symbol.filePath).filter(s =>
    s.qualifiedName === parentName || s.qualifiedName.startsWith(parentName + "."),
  );

  return classSymbols.map(s => ({
    name: s.qualifiedName,
    kind: s.kind,
    signature: s.signature,
    expanded: s.qualifiedName === symbol.qualifiedName,
  }));
}

/**
 * Extract this.xxx dependencies from a method body (dependencies context mode).
 */
function getDependencies(
  symbol: SymbolInfo,
  fileLines: string[],
  index: SymbolIndex,
): DependencyInfo[] {
  const code = fileLines.slice(symbol.lines[0] - 1, symbol.lines[1]).join("\n");

  // Extract this.xxx references
  const thisRefs = new Set<string>();
  const regex = /this\.(\w+)/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    thisRefs.add(match[1]);
  }

  if (thisRefs.size === 0) return [];

  // Resolve against class symbol index
  const parentName = symbol.qualifiedName.split(".")[0];
  const classSymbols = index.lookupByFile(symbol.filePath).filter(s =>
    s.qualifiedName.startsWith(parentName + "."),
  );

  const deps: DependencyInfo[] = [];
  for (const ref of thisRefs) {
    const qualifiedRef = `${parentName}.${ref}`;
    const resolved = classSymbols.find(s => s.qualifiedName === qualifiedRef);

    if (resolved) {
      deps.push({
        symbol: resolved.qualifiedName,
        kind: resolved.kind,
        signature: resolved.signature,
        lines: resolved.lines as [number, number],
      });
    } else {
      // Unresolved — likely a property without explicit declaration
      deps.push({
        symbol: qualifiedRef,
        kind: "property",
        signature: `${ref} (unresolved)`,
      });
    }
  }

  return deps;
}

function resolveFilePath(file: string, workspaceDir: string): string {
  if (path.isAbsolute(file)) return file;
  return path.resolve(workspaceDir, file);
}

function getLanguageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
    ".py": "python", ".swift": "swift", ".rs": "rust", ".go": "go",
    ".java": "java", ".cs": "csharp", ".rb": "ruby", ".php": "php",
  };
  return map[ext] ?? "unknown";
}
