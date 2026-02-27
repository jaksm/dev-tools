/**
 * Tree-sitter WASM engine — lazy grammar loading, language ↔ extension mapping.
 */

import Parser from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs/promises";
import v8 from "node:v8";

// Language ↔ file extension mapping
const EXTENSION_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".swift": "swift",
  ".rs": "rust",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "c_sharp",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".dart": "dart",
  ".ex": "elixir",
  ".exs": "elixir",
  ".lua": "lua",
  ".zig": "zig",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "css",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".sql": "sql",
};

// Grammar WASM file name mapping
const GRAMMAR_FILE_MAP: Record<string, string> = {
  typescript: "tree-sitter-typescript",
  tsx: "tree-sitter-tsx",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  swift: "tree-sitter-swift",
  rust: "tree-sitter-rust",
  go: "tree-sitter-go",
  c: "tree-sitter-c",
  cpp: "tree-sitter-cpp",
  c_sharp: "tree-sitter-c_sharp",
  java: "tree-sitter-java",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php",
  kotlin: "tree-sitter-kotlin",
  dart: "tree-sitter-dart",
  elixir: "tree-sitter-elixir",
  lua: "tree-sitter-lua",
  zig: "tree-sitter-zig",
  html: "tree-sitter-html",
  css: "tree-sitter-css",
  json: "tree-sitter-json",
  yaml: "tree-sitter-yaml",
  toml: "tree-sitter-toml",
  bash: "tree-sitter-bash",
};

export class TreeSitterEngine {
  private initialized = false;
  private grammars = new Map<string, Parser.Language>();
  private wasmDir: string;

  constructor(wasmDir?: string) {
    this.wasmDir = wasmDir ?? path.resolve(
      import.meta.dirname ?? __dirname,
      "../../../node_modules/tree-sitter-wasms/out",
    );
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // Prevent V8 Turboshaft OOM on large WASM grammars (Swift, C#, Kotlin, C++).
    // Liftoff baseline compiler is fast enough for tree-sitter workloads.
    v8.setFlagsFromString("--liftoff-only");
    await Parser.init();
    this.initialized = true;
  }

  static languageForFile(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return EXTENSION_MAP[ext] ?? null;
  }

  static get supportedExtensions(): string[] {
    return Object.keys(EXTENSION_MAP);
  }

  static get supportedLanguages(): string[] {
    return [...new Set(Object.values(EXTENSION_MAP))];
  }

  async loadGrammar(language: string): Promise<Parser.Language | null> {
    if (!this.initialized) await this.init();

    const cached = this.grammars.get(language);
    if (cached) return cached;

    const grammarFile = GRAMMAR_FILE_MAP[language];
    if (!grammarFile) return null;

    const wasmPath = path.join(this.wasmDir, `${grammarFile}.wasm`);

    try {
      await fs.access(wasmPath);
    } catch {
      return null;
    }

    const lang = await Parser.Language.load(wasmPath);
    this.grammars.set(language, lang);
    return lang;
  }

  isGrammarLoaded(language: string): boolean {
    return this.grammars.has(language);
  }

  getGrammar(language: string): Parser.Language | null {
    return this.grammars.get(language) ?? null;
  }

  async createParser(language: string): Promise<Parser | null> {
    const grammar = await this.loadGrammar(language);
    if (!grammar) return null;

    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  }

  get loadedGrammarCount(): number {
    return this.grammars.size;
  }

  reset(): void {
    this.grammars.clear();
  }
}
