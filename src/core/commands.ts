/**
 * CLI/slash command handlers for dev-tools.
 * 
 * Supports:
 * - `openclaw dev-tools setup` — download model, grammars, validate prereqs
 * - `openclaw dev-tools init` — initialize dev-tools for a workspace
 * - `/dev-tools status` — show status in agent session
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import type { Logger, DevToolsConfig } from "./types.js";
import { createStorageManager } from "./storage.js";
import { TreeSitterEngine } from "./tree-sitter/engine.js";

const MODEL_CACHE_DIR = `${process.env.HOME}/.dev-tools/models`;
const GRAMMAR_DIR = `${process.env.HOME}/.dev-tools/grammars`;

interface SetupResult {
  success: boolean;
  model: { status: string; path: string; size?: string };
  grammars: { status: string; path: string; count?: number };
  prerequisites: Array<{ name: string; status: "found" | "missing"; path?: string; installHint?: string }>;
  workspace?: { languages: string[]; testRunners: string[] };
}

interface InitResult {
  success: boolean;
  storageDir: string;
  indexed: { files: number; symbols: number; durationMs: number };
  embeddings: { status: string; symbols?: number; durationMs?: number };
}

/**
 * Check if a binary is available on PATH.
 */
function whichBinary(name: string): string | null {
  try {
    return execSync(`which ${name}`, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

/**
 * Get directory size in bytes.
 */
async function dirSize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      } else if (entry.isDirectory()) {
        total += await dirSize(fullPath);
      }
    }
  } catch {
    // Dir doesn't exist
  }
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `openclaw dev-tools setup` — download model, verify grammars, check prerequisites.
 */
export async function handleSetup(
  _config: DevToolsConfig,
  logger: Logger,
  workspaceDir?: string,
): Promise<SetupResult> {
  const result: SetupResult = {
    success: true,
    model: { status: "checking", path: MODEL_CACHE_DIR },
    grammars: { status: "checking", path: GRAMMAR_DIR },
    prerequisites: [],
  };

  // ── 1. Embedding model ──────────────────────────────────────────────────
  logger.info("[dev-tools setup] Checking embedding model...");
  try {
    // Check if model already cached
    const modelDir = path.join(MODEL_CACHE_DIR, "Xenova--all-MiniLM-L6-v2");
    try {
      await fs.access(modelDir);
      const size = await dirSize(modelDir);
      result.model = { status: "cached", path: modelDir, size: formatBytes(size) };
      logger.info(`[dev-tools setup] Model already cached (${formatBytes(size)})`);
    } catch {
      // Download model by loading the provider
      logger.info("[dev-tools setup] Downloading embedding model (Xenova/all-MiniLM-L6-v2)...");
      const { LocalEmbeddingProvider } = await import("./search/local-embeddings.js");
      const provider = new LocalEmbeddingProvider({ logger });
      await provider.init();
      const size = await dirSize(MODEL_CACHE_DIR);
      result.model = { status: "downloaded", path: MODEL_CACHE_DIR, size: formatBytes(size) };
      await provider.dispose();
      logger.info(`[dev-tools setup] Model downloaded (${formatBytes(size)})`);
    }
  } catch (e) {
    result.model = { status: `error: ${e}`, path: MODEL_CACHE_DIR };
    result.success = false;
  }

  // ── 2. Tree-sitter grammars ─────────────────────────────────────────────
  logger.info("[dev-tools setup] Checking tree-sitter grammars...");
  try {
    const engine = new TreeSitterEngine();
    await engine.init();

    // Grammars come from tree-sitter-wasms npm package, no download needed
    const supportedLanguages = [
      "typescript", "tsx", "javascript", "python", "swift",
      "rust", "go", "java", "c_sharp", "kotlin",
      "json", "html", "css", "bash",
    ];
    let loaded = 0;
    for (const lang of supportedLanguages) {
      try {
        await engine.loadGrammar(lang);
        loaded++;
      } catch {
        // Grammar not available
      }
    }
    result.grammars = { status: "ready", path: "bundled (tree-sitter-wasms)", count: loaded };
    logger.info(`[dev-tools setup] ${loaded}/${supportedLanguages.length} grammars available`);
  } catch (e) {
    result.grammars = { status: `error: ${e}`, path: GRAMMAR_DIR };
    result.success = false;
  }

  // ── 3. Prerequisites ────────────────────────────────────────────────────
  logger.info("[dev-tools setup] Checking prerequisites...");

  const prereqs: Array<{ name: string; bin: string; installHint: string }> = [
    { name: "ripgrep", bin: "rg", installHint: "brew install ripgrep" },
    { name: "TypeScript LSP", bin: "typescript-language-server", installHint: "npm i -g typescript-language-server typescript" },
    { name: "Python LSP (pyright)", bin: "pyright-langserver", installHint: "npm i -g pyright" },
    { name: "Swift LSP (sourcekit)", bin: "sourcekit-lsp", installHint: "Xcode ships this (xcode-select --install)" },
    { name: "Rust Analyzer", bin: "rust-analyzer", installHint: "rustup component add rust-analyzer" },
    { name: "Go LSP (gopls)", bin: "gopls", installHint: "go install golang.org/x/tools/gopls@latest" },
  ];

  for (const p of prereqs) {
    const binPath = whichBinary(p.bin);
    result.prerequisites.push({
      name: p.name,
      status: binPath ? "found" : "missing",
      path: binPath ?? undefined,
      installHint: binPath ? undefined : p.installHint,
    });
  }

  const missing = result.prerequisites.filter(p => p.status === "missing");
  if (missing.length > 0) {
    logger.info(`[dev-tools setup] ${missing.length} optional prerequisites missing (LSP servers are lazy-loaded)`);
  }

  // Ripgrep is required
  if (result.prerequisites.find(p => p.name === "ripgrep" && p.status === "missing")) {
    result.success = false;
    logger.warn("[dev-tools setup] ripgrep is REQUIRED — text search and grep will not work");
  }

  // ── 4. Workspace detection (optional) ───────────────────────────────────
  if (workspaceDir) {
    logger.info(`[dev-tools setup] Detecting workspace stack at ${workspaceDir}...`);
    try {
      const { detectLanguages } = await import("./languages.js");
      const { createGitignoreFilter } = await import("./gitignore.js");
      const { detectTestRunners } = await import("./test-detection.js");

      const gitignoreFilter = await createGitignoreFilter(workspaceDir);
      const languages = await detectLanguages(workspaceDir, gitignoreFilter);
      const testRunners = await detectTestRunners(workspaceDir, languages);

      result.workspace = {
        languages: languages.map(l => l.language).filter((v, i, a) => a.indexOf(v) === i),
        testRunners: testRunners.map(t => t.name),
      };
    } catch (e) {
      logger.warn(`[dev-tools setup] Workspace detection failed: ${e}`);
    }
  }

  return result;
}

/**
 * `openclaw dev-tools init` — create storage, run full index, generate INDEX.json, embed.
 */
export async function handleInit(
  config: DevToolsConfig,
  logger: Logger,
  workspaceDir: string,
): Promise<InitResult> {
  const storage = createStorageManager(workspaceDir);
  await storage.ensureDirs();

  logger.info(`[dev-tools init] Initializing dev-tools for ${workspaceDir}`);
  logger.info(`[dev-tools init] Storage: ${storage.storageDir}`);

  // ── 1. Full symbol index ────────────────────────────────────────────────
  const { createGitignoreFilter } = await import("./gitignore.js");
  const { SymbolIndex } = await import("./index/symbol-index.js");
  const { WorkspaceIndexer } = await import("./index/indexer.js");
  const { ImportGraph } = await import("./index/import-graph.js");
  const { generateIndexJson, writeIndexJson } = await import("./index/index-json.js");

  const engine = new TreeSitterEngine();
  await engine.init();
  const { FileParser } = await import("./tree-sitter/parser.js");
  const parser = new FileParser(engine);
  const symbolIndex = new SymbolIndex();

  const indexer = new WorkspaceIndexer({
    engine,
    parser,
    symbolIndex,
    logger,
  });

  const gitignoreFilter = await createGitignoreFilter(workspaceDir);

  const indexStart = Date.now();
  const indexResult = await indexer.indexWorkspace(workspaceDir, gitignoreFilter);
  const indexDurationMs = Date.now() - indexStart;

  logger.info(
    `[dev-tools init] Indexed ${indexResult.symbolCount} symbols from ${indexResult.filesIndexed} files (${indexDurationMs}ms)`,
  );

  // Build import graph + INDEX.json
  const importGraph = new ImportGraph();
  importGraph.build(indexer.getAllImportsExports(), workspaceDir);
  importGraph.addTypeReferenceEdges(indexer.getFileTypeRefs(), symbolIndex);

  const indexJson = generateIndexJson({
    symbolIndex,
    importGraph,
    fileImports: indexer.getAllImportsExports(),
    workspaceDir,
    fileLineCounts: indexer.getFileLineCounts(),
  });
  await writeIndexJson(indexJson, storage.indexDir());

  const result: InitResult = {
    success: true,
    storageDir: storage.storageDir,
    indexed: {
      files: indexResult.filesIndexed,
      symbols: indexResult.symbolCount,
      durationMs: indexDurationMs,
    },
    embeddings: { status: "skipped" },
  };

  // ── 2. Embedding indexing ───────────────────────────────────────────────
  try {
    logger.info("[dev-tools init] Starting embedding indexing...");
    const { createEmbeddingProvider } = await import("./search/embeddings.js");
    const { EmbeddingIndexer } = await import("./search/indexer.js");

    const provider = await createEmbeddingProvider(config, logger);
    await provider.init();

    const embeddingIndexer = new EmbeddingIndexer({
      embeddingProvider: provider,
      symbolIndex,
      workspaceDir,
      storageDir: storage.indexDir(),
      logger,
    });
    await embeddingIndexer.init();

    const embedStart = Date.now();
    const embedResult = await embeddingIndexer.indexAll((indexed, total) => {
      if (indexed % 200 === 0) {
        logger.info(`[dev-tools init] Embedding progress: ${indexed}/${total}`);
      }
    });
    const embedDurationMs = Date.now() - embedStart;

    await embeddingIndexer.persist();
    await embeddingIndexer.dispose();
    await provider.dispose();

    result.embeddings = {
      status: "complete",
      symbols: embedResult.indexed,
      durationMs: embedDurationMs,
    };

    logger.info(
      `[dev-tools init] Embedded ${embedResult.indexed} symbols (${embedResult.skipped} cached) in ${embedDurationMs}ms`,
    );
  } catch (e) {
    logger.warn(`[dev-tools init] Embedding indexing failed: ${e}`);
    result.embeddings = { status: `error: ${e}` };
  }

  return result;
}
