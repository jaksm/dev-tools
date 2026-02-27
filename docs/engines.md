# Engines

dev-tools has three code intelligence engines, each operating independently with different availability characteristics.

## Tree-sitter (always-on)

**Purpose:** Symbol extraction, import/export parsing, type reference detection.

**Components:**
- `tree-sitter/engine.ts` — Grammar loading with WASM support. Caches loaded grammars by language.
- `tree-sitter/parser.ts` — File parsing with content-hash caching. Same file content → same parse tree without re-parsing.
- `tree-sitter/extractor.ts` — Extracts symbols (functions, classes, methods, interfaces, types, enums, variables) from parse trees.
- `tree-sitter/queries.ts` — Language-specific tree-sitter queries. Covers 95%+ of modern patterns per language.
- `tree-sitter/imports.ts` — Import/export extraction with resolution. Handles path aliases (tsconfig paths), relative imports, barrel exports.
- `tree-sitter/references.ts` — Type reference extraction from struct fields, function signatures, generics.
- `tree-sitter/tsconfig-resolver.ts` — Resolves TypeScript path aliases (`@/*` → `src/*`), supports `extends`, handles JSON comments.

**Symbol types extracted:**
- Functions (named, arrow, expression, HOC/factory patterns)
- Classes with methods
- Interfaces and type aliases
- Enums
- Exported const variables
- Anonymous default exports (as `{filename}::default`)

**Supported languages:** TypeScript, JavaScript (+ TSX/JSX), Python, Rust, Go, Swift, Java, Kotlin, C#, JSON, HTML, CSS, Bash.

## Symbol Index

**Purpose:** Fast in-memory symbol lookup powering `code_outline`, `code_read`, `code_search`, and `code_inspect` fallback.

**Components:**
- `index/symbol-index.ts` — In-memory index with lookup by qualified name, simple name, file path.
- `index/indexer.ts` — Full and incremental workspace indexing. Walks all source files, extracts symbols via tree-sitter, builds index.
- `index/resolver.ts` — Symbol resolution: `"UserService"` → SymbolInfo, `"UserService.authenticate"` → method SymbolInfo. Handles ambiguity with file hints and scope hints.
- `index/import-graph.ts` — File dependency graph built from resolved imports. Used by `code_read` dependencies context.
- `index/index-json.ts` — Generates INDEX.json (full project structure as JSON).
- `index/ranking.ts` — Search result ranking (exact match > prefix > contains > fuzzy).
- `index/watcher.ts` — File watcher for incremental re-indexing during a session. Debounced (configurable, default 2s).

**Incremental indexing:**
- **Within a session:** File watcher detects changes → re-parses only changed files → updates symbol index + embeddings.
- **Across restarts:** Manifest file (`manifest.json`) stores file mtimes. On restart, compares current mtimes to manifest and only re-indexes changed files.

## Embedding Search (HNSW)

**Purpose:** Semantic code search — find code by meaning ("authentication middleware") rather than text.

**Components:**
- `search/embeddings.ts` — Provider interface.
- `search/local-embeddings.ts` — Local model via `@xenova/transformers`. Downloads model to `~/.dev-tools/models/` on first use.
- `search/api-embeddings.ts` — External API provider (configurable endpoint + key).
- `search/indexer.ts` — Builds and maintains the embedding index. Processes symbols from the symbol index, generates vectors, inserts into HNSW.
- `search/hnsw-index.ts` — HNSW approximate nearest-neighbor index via `hnswlib-node`. Supports scoped search (filter by directory path).
- `search/serializer.ts` — Persists HNSW index + metadata to disk for fast reload.

**Search flow:**
1. Query text → embedding vector via local model
2. HNSW nearest-neighbor search → top-K symbol IDs
3. Optional scope filter (`startsWith` on file path)
4. Map IDs back to SymbolInfo from symbol index
5. Return with relevance scores

**Fallback:** If embeddings aren't ready (initial indexing, model download in progress), `code_search` automatically falls back to text search via ripgrep.

## LSP (Language Server Protocol)

**Purpose:** Deep code intelligence — type information, definitions, references, diagnostics, refactoring.

**Components:**
- `lsp/manager.ts` — Server lifecycle management. Starts/stops servers per language root. Health checks. Crash recovery with configurable restart attempts.
- `lsp/client.ts` — JSON-RPC client. Handles initialization, document sync, and all LSP requests (hover, definition, references, rename, code actions, diagnostics).
- `lsp/resolver.ts` — Symbol → LSP position resolver. Takes a SymbolInfo and finds the exact position to query the LSP server.
- `lsp/servers.ts` — Server configurations per language (binary name, args, capabilities).
- `lsp/diagnostics.ts` — Diagnostic collector. Aggregates diagnostics from all servers. Query by file, directory, severity, monorepo root.

**Supported LSP servers:**

| Language | Server | Binary |
|---|---|---|
| TypeScript/JavaScript | typescript-language-server | `typescript-language-server` |
| Python | Pyright | `pyright-langserver` |
| Rust | rust-analyzer | `rust-analyzer` |
| Go | gopls | `gopls` |
| Swift | SourceKit-LSP | `sourcekit-lsp` |

**Lazy boot:** Servers start on first use of `code_inspect`, `code_diagnose`, or `code_refactor` — not at session start. This means zero LSP overhead for agents that never use those tools.

**Auto-detection:** After any `shell` command, the LSP manager's binary prerequisite cache is invalidated. So if an agent runs `npm i -g typescript-language-server`, the next `code_inspect` call will detect and use it — no restart needed.

**Graceful degradation:** When LSP is unavailable, tools explain why:
- "Not installed — run `npm i -g typescript-language-server`"
- "Language not supported by any configured LSP server"
- "Server crashed and exhausted restart attempts"
- "Document not in any language root"

Agents always get a useful result, even without LSP — just less precise (symbol index instead of compiler-accurate types).
