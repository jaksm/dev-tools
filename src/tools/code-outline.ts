/**
 * code_outline tool — hierarchical view of symbols in a file or directory.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { SymbolInfo, ToolContext, ToolResult } from "../core/types.js";
import { SymbolIndex } from "../core/index/symbol-index.js";

export interface CodeOutlineParams {
  path: string;
}

export interface OutlineSymbol {
  name: string;
  kind: string;
  lines: [number, number];
  signature?: string;
  docs?: string | null;
  children?: OutlineSymbol[];
}

export interface CodeOutlineResult {
  path: string;
  symbols: OutlineSymbol[];
  exports: string[];
  type: "file" | "directory";
}

/**
 * Generate code outline for a file or directory.
 */
export async function codeOutline(
  params: CodeOutlineParams,
  ctx: ToolContext,
  symbolIndex: SymbolIndex,
): Promise<ToolResult<CodeOutlineResult>> {
  const targetPath = path.isAbsolute(params.path)
    ? params.path
    : path.resolve(ctx.workspaceDir, params.path);

  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch {
    return { success: false, error: `Path not found: ${params.path}` };
  }

  if (stat.isFile()) {
    return outlineFile(targetPath, params.path, symbolIndex);
  } else if (stat.isDirectory()) {
    return outlineDirectory(targetPath, params.path, ctx, symbolIndex);
  }

  return { success: false, error: `Not a file or directory: ${params.path}` };
}

function outlineFile(
  filePath: string,
  displayPath: string,
  symbolIndex: SymbolIndex,
): ToolResult<CodeOutlineResult> {
  const symbols = symbolIndex.lookupByFile(filePath);
  if (symbols.length === 0) {
    return {
      success: true,
      data: { path: displayPath, symbols: [], exports: [], type: "file" },
      summary: `No symbols found in ${displayPath}`,
    };
  }

  // Build hierarchical tree
  const tree = buildHierarchy(symbols);
  const exports = symbols
    .filter(s => s.code?.includes("export "))
    .map(s => s.qualifiedName);

  return {
    success: true,
    data: { path: displayPath, symbols: tree, exports, type: "file" },
    summary: `${symbols.length} symbols in ${displayPath}`,
  };
}

async function outlineDirectory(
  dirPath: string,
  displayPath: string,
  _ctx: ToolContext,
  symbolIndex: SymbolIndex,
): Promise<ToolResult<CodeOutlineResult>> {
  const allSymbols: OutlineSymbol[] = [];
  const allExports: string[] = [];

  // Get all indexed files in this directory
  const files = symbolIndex.files.filter(f => f.startsWith(dirPath + path.sep));

  for (const filePath of files) {
    const symbols = symbolIndex.lookupByFile(filePath);
    if (symbols.length === 0) continue;

    const relativePath = path.relative(dirPath, filePath);

    // Flat list: file name → top-level symbols
    for (const s of symbols) {
      // Only include top-level symbols (not methods within classes)
      if (!s.qualifiedName.includes(".")) {
        allSymbols.push({
          name: `${relativePath}::${s.qualifiedName}`,
          kind: s.kind,
          lines: s.lines as [number, number],
          signature: s.signature,
          docs: s.docs,
        });
      }
    }

    const exports = symbols
      .filter(s => s.code?.includes("export "))
      .map(s => `${relativePath}::${s.qualifiedName}`);
    allExports.push(...exports);
  }

  return {
    success: true,
    data: { path: displayPath, symbols: allSymbols, exports: allExports, type: "directory" },
    summary: `${allSymbols.length} symbols across ${files.length} files in ${displayPath}`,
  };
}

/**
 * Build hierarchical tree from flat symbol list.
 * Classes contain their methods as children.
 */
function buildHierarchy(symbols: SymbolInfo[]): OutlineSymbol[] {
  const result: OutlineSymbol[] = [];
  const classMap = new Map<string, OutlineSymbol>();

  // First pass: create class/interface/enum entries
  for (const s of symbols) {
    if (s.kind === "class" || s.kind === "interface" || s.kind === "enum") {
      const entry: OutlineSymbol = {
        name: s.qualifiedName,
        kind: s.kind,
        lines: s.lines as [number, number],
        signature: s.signature,
        docs: s.docs,
        children: [],
      };
      classMap.set(s.qualifiedName, entry);
      result.push(entry);
    }
  }

  // Second pass: attach methods to their parent classes, add standalone symbols
  for (const s of symbols) {
    if (s.kind === "class" || s.kind === "interface" || s.kind === "enum") continue;

    if (s.kind === "method" && s.qualifiedName.includes(".")) {
      const parentName = s.qualifiedName.split(".")[0];
      const parent = classMap.get(parentName);
      if (parent?.children) {
        parent.children.push({
          name: s.qualifiedName.split(".").pop()!,
          kind: s.kind,
          lines: s.lines as [number, number],
          signature: s.signature,
          docs: s.docs,
        });
        continue;
      }
    }

    // Standalone symbol
    result.push({
      name: s.qualifiedName,
      kind: s.kind,
      lines: s.lines as [number, number],
      signature: s.signature,
      docs: s.docs,
    });
  }

  return result;
}
