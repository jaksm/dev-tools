# Architecture

## Overview

dev-tools is an OpenClaw plugin that provides IDE-grade coding tools to AI agents. It consists of two layers:

1. **Core** (`src/core/`) — Pure TypeScript, zero OpenClaw dependencies. All business logic lives here.
2. **Adapter** (`src/index.ts`) — Thin boundary layer mapping OpenClaw's plugin API to the core.

This separation makes the core testable, portable, and reusable outside OpenClaw.

## Directory Structure

```
src/
├── index.ts                 # Plugin adapter (OC API → Core)
├── core/
│   ├── index.ts             # DevToolsCore class — central orchestrator
│   ├── types.ts             # Shared type contracts (zero OC imports)
│   ├── config.ts            # Config resolution (defaults → plugin config → env vars)
│   ├── storage.ts           # Storage manager (~/.dev-tools/{slug}/)
│   ├── project-registry.ts  # Persistent workspace→project mapping
│   ├── commands.ts          # CLI/slash command handlers (setup, init, status)
│   ├── languages.ts         # Language detection from package files
│   ├── test-detection.ts    # Test runner auto-detection
│   ├── gitignore.ts         # .gitignore parsing and filtering
│   ├── security.ts          # Command blocklist + dangerous pattern detection
│   ├── token-budget.ts      # Response truncation with spillover to disk
│   ├── file-mutex.ts        # Per-file write serialization
│   ├── logging.ts           # JSONL tool call logger
│   ├── tree-sitter/         # Symbol extraction engine
│   │   ├── engine.ts        # Grammar loading + caching
│   │   ├── parser.ts        # File parsing with content-hash cache
│   │   ├── extractor.ts     # Symbol extraction from parse trees
│   │   ├── queries.ts       # Tree-sitter queries per language
│   │   ├── imports.ts       # Import/export extraction
│   │   ├── references.ts    # Type reference extraction
│   │   └── tsconfig-resolver.ts  # Path alias resolution
│   ├── index/               # Symbol indexing + code intelligence
│   │   ├── indexer.ts        # Full + incremental workspace indexing
│   │   ├── symbol-index.ts   # In-memory symbol lookup (by name, file, qualified)
│   │   ├── resolver.ts       # Symbol resolution (name → SymbolInfo)
│   │   ├── import-graph.ts   # File dependency graph
│   │   ├── index-json.ts     # INDEX.json generation
│   │   ├── index-renderer.ts # INDEX.json token-budget rendering
│   │   ├── ranking.ts        # Search result ranking
│   │   └── watcher.ts        # File watcher for incremental updates
│   ├── search/              # Semantic search engine
│   │   ├── embeddings.ts     # Embedding provider interface
│   │   ├── local-embeddings.ts  # Local model (Xenova/transformers.js)
│   │   ├── api-embeddings.ts    # API-based embeddings
│   │   ├── indexer.ts        # Embedding index builder
│   │   ├── hnsw-index.ts     # HNSW vector index (hnswlib-node)
│   │   └── serializer.ts     # Index persistence
│   ├── lsp/                 # Language Server Protocol
│   │   ├── manager.ts        # Server lifecycle, health checks, crash recovery
│   │   ├── client.ts         # LSP JSON-RPC client
│   │   ├── resolver.ts       # Symbol → LSP position resolution
│   │   ├── servers.ts        # Server configs per language
│   │   └── diagnostics.ts    # Diagnostic collection + querying
│   └── task/                # Task planning engine
│       ├── types.ts          # Plan, Task, Checkpoint types
│       ├── storage.ts        # Plan persistence (JSON files)
│       └── helpers.ts        # ID generation, tree walking, aggregation
└── tools/                   # 16 tool implementations
    ├── file-read.ts          # file_read
    ├── file-write.ts         # file_write
    ├── file-edit.ts          # file_edit
    ├── shell.ts              # shell
    ├── grep.ts               # grep (via ripgrep)
    ├── glob.ts               # glob
    ├── ls.ts                 # ls
    ├── code-outline.ts       # code_outline
    ├── code-read.ts          # code_read
    ├── code-search.ts        # code_search
    ├── code-inspect.ts       # code_inspect
    ├── code-diagnose.ts      # code_diagnose
    ├── code-refactor.ts      # code_refactor
    ├── task.ts               # task
    ├── git.ts                # git
    └── test.ts               # test
```

## Storage Layout

All project-specific data is stored under `~/.dev-tools/{project-slug}/`:

```
~/.dev-tools/
├── models/                  # Shared embedding model cache
├── grammars/                # Shared tree-sitter grammar cache
├── my-project/              # Per-project storage (slug from dir name)
│   ├── index/
│   │   ├── INDEX.json       # Full project symbol index
│   │   ├── manifest.json    # File mtimes for incremental re-index
│   │   ├── hnsw.bin         # HNSW vector index
│   │   └── embeddings.json  # Embedding metadata
│   ├── plans/               # Active task plans
│   │   └── {plan-id}.json
│   ├── completed-plans/     # Archived completed plans
│   ├── logs/
│   │   └── tool-calls.jsonl # Tool call audit log
│   └── tool-output/         # Truncated output spillover files
└── registry.json            # workspace→project mapping
```

The slug is derived from the project directory name (e.g., `~/Projects/myapp` → `myapp`).

## Engines

### Tree-sitter (always-on)

Provides symbol extraction for all supported languages. Loads WASM grammars on demand. Symbols are extracted via language-specific tree-sitter queries and stored in the in-memory SymbolIndex.

### Embedding Search (always-on after first index)

Local embedding model (default: `Xenova/all-MiniLM-L6-v2`) generates vectors for all symbols. HNSW index enables fast approximate nearest-neighbor search. Falls back to text search (ripgrep) if embeddings aren't ready.

### LSP (lazy, optional)

Language servers boot on first use of `code_inspect`, `code_diagnose`, or `code_refactor`. Auto-detects installed servers. Crash recovery with configurable restart attempts. If no server is installed, tools gracefully degrade to symbol-index-only results.

## Plugin Adapter

The adapter (`src/index.ts`) handles:

1. **Tool registration** — Builds all 16 tools via `registerTool` factory. Tools resolve the active project at call time (dynamic, not static).
2. **Lifecycle hooks** — `session_start`, `session_end`, `before_prompt_build` for workspace analysis and context injection.
3. **Auto-activation** — On first `before_prompt_build`, resolves the project via: registry match → config `projectRoots` → agent workspace fallback.
4. **Slash command** — `/dev-tools [setup|init|status]` for interactive management.
5. **Tool call logging** — `after_tool_call` hook logs all dev-tools calls to JSONL.

## Key Design Decisions

- **Agent workspace ≠ project directory.** Agent workspaces (`~/.openclaw/workspace-X/`) are decoupled from project directories (`~/Projects/myapp/`). The `projectRoots` config bridges this gap.
- **Lazy everything.** LSP servers, embedding models, and workspace analysis all initialize on first use. No startup cost for unused features.
- **Structured output.** Every tool returns JSON with `success`, `data`, `error`, and `summary` fields. Agents parse structured data, not raw text.
- **Graceful degradation.** Missing LSP → symbol index fallback. Missing ripgrep → error with install hint. Missing embeddings → text search. Nothing crashes.
- **File mutex.** Concurrent writes to the same file are serialized. Different files can be written in parallel.
