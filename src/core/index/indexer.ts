/**
 * Workspace indexer — walk workspace, parse files, extract symbols, build index.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { TreeSitterEngine } from "../tree-sitter/engine.js";
import { FileParser } from "../tree-sitter/parser.js";
import { extractSymbols } from "../tree-sitter/extractor.js";
import { extractImports, extractExports } from "../tree-sitter/imports.js";
import { extractTypeReferences } from "../tree-sitter/references.js";
import { createAliasResolver, type AliasResolver } from "../tree-sitter/tsconfig-resolver.js";
import { SymbolIndex } from "./symbol-index.js";
import type { ImportInfo, ExportInfo, Logger } from "../types.js";

export interface IndexerResult {
  filesIndexed: number;
  symbolCount: number;
  errors: Array<{ file: string; error: string }>;
  durationMs: number;
}

export interface FileImportsExports {
  imports: ImportInfo[];
  exports: ExportInfo[];
}

export class WorkspaceIndexer {
  private engine: TreeSitterEngine;
  private parser: FileParser;
  private symbolIndex: SymbolIndex;
  private fileImports = new Map<string, FileImportsExports>();
  private fileLineCounts = new Map<string, number>();
  private fileTypeRefs = new Map<string, string[]>();
  private aliasResolver: AliasResolver | null = null;
  private workspaceDir: string | undefined;
  private logger: Logger;

  constructor(opts: {
    engine: TreeSitterEngine;
    parser: FileParser;
    symbolIndex: SymbolIndex;
    logger: Logger;
  }) {
    this.engine = opts.engine;
    this.parser = opts.parser;
    this.symbolIndex = opts.symbolIndex;
    this.logger = opts.logger;
  }

  /**
   * Full workspace index — walk all source files, parse, extract symbols.
   */
  async indexWorkspace(
    workspaceDir: string,
    gitignoreFilter: (path: string) => boolean,
    onProgress?: (indexed: number, total: number) => void,
  ): Promise<IndexerResult> {
    const start = Date.now();
    const errors: Array<{ file: string; error: string }> = [];

    // Store workspace dir for Python import resolution
    this.workspaceDir = workspaceDir;

    // Initialize alias resolver for TypeScript path aliases
    this.aliasResolver = await createAliasResolver(workspaceDir);
    if (this.aliasResolver) {
      this.logger.info("[dev-tools] TypeScript path alias resolver initialized");
    }

    // Collect all source files
    const files = await this.collectFiles(workspaceDir, gitignoreFilter);
    this.logger.info(`[dev-tools] Indexing ${files.length} files...`);

    // Ensure grammars are loaded for detected languages
    const languageSet = new Set<string>();
    for (const f of files) {
      const lang = TreeSitterEngine.languageForFile(f);
      if (lang) languageSet.add(lang);
    }
    for (const lang of languageSet) {
      await this.engine.loadGrammar(lang);
    }

    // Parse and extract
    let indexed = 0;
    for (const filePath of files) {
      try {
        await this.indexFile(filePath);
        indexed++;
        if (onProgress && indexed % 100 === 0) {
          onProgress(indexed, files.length);
        }
      } catch (e) {
        errors.push({ file: filePath, error: String(e) });
      }
    }

    const result: IndexerResult = {
      filesIndexed: indexed,
      symbolCount: this.symbolIndex.size,
      errors,
      durationMs: Date.now() - start,
    };

    this.logger.info(
      `[dev-tools] Indexed ${result.symbolCount} symbols from ${result.filesIndexed} files in ${result.durationMs}ms`,
    );

    return result;
  }

  /**
   * Index a single file — parse, extract symbols + imports/exports, update index.
   */
  async indexFile(filePath: string, source?: string): Promise<void> {
    const content = source ?? await fs.readFile(filePath, "utf-8");
    const result = await this.parser.parseFile(filePath, content);
    if (!result) return;

    const { tree, language } = result;

    // Track line count
    this.fileLineCounts.set(filePath, content.split("\n").length);

    // Extract symbols
    const symbols = extractSymbols(tree, language, filePath, content);
    this.symbolIndex.bulkInsertForFile(filePath, symbols);

    // Extract imports/exports
    const imports = extractImports(tree, language, filePath, {
      aliasResolver: this.aliasResolver,
      workspaceDir: this.workspaceDir,
    });
    const exports = extractExports(tree, language, filePath);
    this.fileImports.set(filePath, { imports, exports });

    // Extract type references for cross-file dependency analysis
    const typeRefs = extractTypeReferences(tree, language);
    if (typeRefs.length > 0) {
      this.fileTypeRefs.set(filePath, typeRefs);
    }
  }

  /**
   * Re-index a single file (after change).
   */
  async reindexFile(filePath: string): Promise<void> {
    this.parser.invalidate(filePath);
    await this.indexFile(filePath);
  }

  /**
   * Remove a file from the index (after deletion).
   */
  removeFile(filePath: string): void {
    this.symbolIndex.removeByFile(filePath);
    this.fileImports.delete(filePath);
    this.parser.invalidate(filePath);
  }

  /**
   * Get imports/exports for a file.
   */
  getFileImportsExports(filePath: string): FileImportsExports | null {
    return this.fileImports.get(filePath) ?? null;
  }

  /**
   * Get all file import/export data.
   */
  getAllImportsExports(): Map<string, FileImportsExports> {
    return this.fileImports;
  }

  /**
   * Get all file line counts.
   */
  getFileLineCounts(): Map<string, number> {
    return this.fileLineCounts;
  }

  /**
   * Get all file type references (type names referenced per file).
   */
  getFileTypeRefs(): Map<string, string[]> {
    return this.fileTypeRefs;
  }

  /**
   * Collect all source files in workspace, respecting gitignore.
   */
  private async collectFiles(
    dir: string,
    gitignoreFilter: (path: string) => boolean,
    rootDir?: string,
  ): Promise<string[]> {
    const root = rootDir ?? dir;
    const files: string[] = [];

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return files;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(root, fullPath);

      if (gitignoreFilter(relativePath)) continue;

      if (entry.isDirectory()) {
        // Skip hidden directories
        if (entry.name.startsWith(".")) continue;
        const subFiles = await this.collectFiles(fullPath, gitignoreFilter, root);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        const lang = TreeSitterEngine.languageForFile(fullPath);
        if (lang) {
          // Skip very large files (>1MB)
          try {
            const stat = await fs.stat(fullPath);
            if (stat.size < 1_000_000) {
              files.push(fullPath);
            }
          } catch {
            // Skip on stat error
          }
        }
      }
    }

    return files;
  }
}
