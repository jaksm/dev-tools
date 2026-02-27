/**
 * File parser — parse source files into ASTs with caching and incremental re-parse.
 */

import Parser from "web-tree-sitter";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { TreeSitterEngine } from "./engine.js";

interface ParsedFile {
  tree: Parser.Tree;
  language: string;
  hash: string;
  parsedAt: number;
}

export class FileParser {
  private engine: TreeSitterEngine;
  private cache = new Map<string, ParsedFile>();
  private parsers = new Map<string, Parser>();

  constructor(engine: TreeSitterEngine) {
    this.engine = engine;
  }

  async parseFile(filePath: string, source?: string): Promise<{ tree: Parser.Tree; language: string } | null> {
    const language = TreeSitterEngine.languageForFile(filePath);
    if (!language) return null;

    const content = source ?? await fs.readFile(filePath, "utf-8");
    const hash = crypto.createHash("md5").update(content).digest("hex");

    const cached = this.cache.get(filePath);
    if (cached && cached.hash === hash && cached.language === language) {
      return { tree: cached.tree, language: cached.language };
    }

    const parser = await this.getOrCreateParser(language);
    if (!parser) return null;

    const tree = parser.parse(content);

    this.cache.set(filePath, { tree, language, hash, parsedAt: Date.now() });
    return { tree, language };
  }

  async parseString(source: string, language: string): Promise<Parser.Tree | null> {
    const parser = await this.getOrCreateParser(language);
    if (!parser) return null;
    return parser.parse(source);
  }

  private async getOrCreateParser(language: string): Promise<Parser | null> {
    let parser = this.parsers.get(language);
    if (parser) return parser;

    const created = await this.engine.createParser(language);
    if (!created) return null;
    this.parsers.set(language, created);
    return created;
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  isCached(filePath: string): boolean {
    return this.cache.has(filePath);
  }
}
