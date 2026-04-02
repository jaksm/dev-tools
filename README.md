# @jaksm/dev-tools

IDE-grade coding tools for AI agents. Tree-sitter parsing, semantic search, LSP intelligence, and 16 battle-tested tools — in a single package.

Built for [OpenClaw](https://github.com/openclaw/openclaw) but works standalone with **any** agent framework (Mastra, LangChain, Vercel AI SDK, or raw function calls).

## What's Inside

| Category | Tools | What They Do |
|---|---|---|
| **Foundation** | `fileRead`, `fileWrite`, `fileEdit`, `grep`, `glob`, `ls`, `shell` | File operations with line numbers, cascading fuzzy edit matching, ripgrep search, gitignore-aware listing |
| **Code Intelligence** | `codeOutline`, `codeRead`, `codeSearch`, `codeInspect`, `codeDiagnose`, `codeRefactor` | Symbol index, semantic search (HNSW + embeddings), LSP hover/references/rename, diagnostics |
| **Workflow** | `git`, `test`, `task` | Structured git output, multi-framework test runner (Jest/Vitest/pytest/cargo/swift/go), persistent task planning |

### Key Features

- **Tree-sitter parsing** — 15+ languages, incremental re-indexing
- **Semantic code search** — local embeddings via HuggingFace transformers + HNSW vector index
- **LSP integration** — TypeScript, Python, Go, Rust — hover, references, rename, diagnostics
- **Cascading edit matching** — 6 strategies (exact → whitespace → indentation → escape → unicode → block-anchor) so agents don't fail on whitespace differences
- **Zero OpenClaw dependency** — core tools are pure TypeScript functions

## Installation

### As an OpenClaw Plugin

```bash
openclaw plugin add @jaksm/dev-tools
```

The plugin auto-registers all tools, analyzes your workspace on session start, and injects context (languages detected, symbol count, test runners) into agent prompts.

### As a Standalone Package

```bash
npm install @jaksm/dev-tools
```

## Usage

### OpenClaw Plugin (zero config)

Install and it works. Tools appear automatically in your agent's tool list. The plugin handles workspace analysis, symbol indexing, and LSP lifecycle.

### Standalone — Direct Tool Import

```typescript
import { DevToolsCore } from '@jaksm/dev-tools/core'
import { fileRead, grep, codeSearch, codeOutline } from '@jaksm/dev-tools/tools'

// 1. Create core instance (manages indexing, LSP, embeddings)
const core = new DevToolsCore({ logger: console })

// 2. Analyze workspace (detects languages, test runners, parses symbols)
const workspace = await core.analyzeWorkspace('/path/to/project')

// 3. Create tool context
const ctx = core.createToolContext('/path/to/project', workspace!)

// 4. Use tools directly
const file = await fileRead({ path: 'src/index.ts' }, ctx)
const results = await grep({ pattern: 'TODO', mode: 'content' }, ctx)

// 5. Use code intelligence (needs symbol index)
const symbolIndex = core.getSymbolIndex('/path/to/project')
const outline = await codeOutline({ path: 'src/' }, ctx, symbolIndex)

// 6. Semantic search (needs embedding indexer — initialized automatically)
const embeddingIndexer = core.getEmbeddingIndexer('/path/to/project')
const search = await codeSearch(
  { query: 'authentication logic', mode: 'semantic' },
  ctx, symbolIndex, embeddingIndexer
)

// 7. Cleanup when done
await core.dispose()
```

### Standalone — With Any Agent Framework

The tools are plain async functions. Wire them into any framework's tool system:

```typescript
// Example: Mastra / Vercel AI SDK style
import { fileRead, grep, codeSearch } from '@jaksm/dev-tools/tools'
import { DevToolsCore } from '@jaksm/dev-tools/core'

const core = new DevToolsCore({ logger: console })
const workspace = await core.analyzeWorkspace(projectDir)
const ctx = core.createToolContext(projectDir, workspace!)
const symbolIndex = core.getSymbolIndex(projectDir)

// Register as agent tools
const tools = {
  file_read: {
    description: 'Read file contents with line numbers',
    parameters: { path: 'string', offset: 'number?', limit: 'number?' },
    execute: (params) => fileRead(params, ctx),
  },
  grep: {
    description: 'Search file contents with ripgrep',
    parameters: { pattern: 'string', path: 'string?', glob: 'string?' },
    execute: (params) => grep(params, ctx),
  },
  code_search: {
    description: 'Semantic code search',
    parameters: { query: 'string', mode: 'string?' },
    execute: (params) => codeSearch(params, ctx, symbolIndex, core.getEmbeddingIndexer(projectDir)),
  },
}
```

## Tool Reference

### Foundation Tools

#### `fileRead(params, ctx)`
Read files with line numbers, pagination, binary detection, and "did you mean?" suggestions for wrong paths.

#### `fileWrite(params, ctx)`
Create or overwrite files. Auto-creates parent directories.

#### `fileEdit(params, ctx, lspOptions?)`
Surgical text replacement with 6-strategy cascading match (handles whitespace/indentation differences). Optionally returns LSP diagnostics after edit.

#### `grep(params, ctx)`
Ripgrep wrapper. Modes: `content` (lines + context), `files` (paths only), `count` (per-file counts). Respects `.gitignore`.

#### `glob(params, ctx)`
Find files by pattern. Returns path, size, modification time. Respects `.gitignore`.

#### `ls(params, ctx)`
Directory tree with file sizes and child counts. Configurable depth.

#### `shell(params, ctx)`
Execute shell commands with timeout, blocklist, and dangerous pattern detection.

#### `git(params, workspaceDir)`
Structured git output — status, diff (with hunks), commit, log, branch. No output parsing needed.

#### `test(params, runner, workspaceDir)`
Multi-framework test runner with structured results. Supports: Jest, Vitest, pytest, cargo test, swift test, go test.

### Code Intelligence Tools

#### `codeOutline(params, ctx, symbolIndex)`
File/directory structure — classes, functions, methods with signatures and line numbers.

#### `codeRead(params, ctx, symbolIndex)`
Read a specific symbol's source code by name. Context modes: `siblings`, `class`, `dependencies`.

#### `codeSearch(params, ctx, symbolIndex, embeddingIndexer)`
Semantic search by concept ("authentication logic") or text. Also: `stats` (index info), `index` (browse symbols).

#### `codeInspect(params, ctx, symbolIndex, lspManager)`
Type signature + definition + references in one call. LSP-powered with index fallback.

#### `codeDiagnose(params, ctx, symbolIndex, lspManager)`
Compiler errors, warnings, quick-fixes. Actions: `diagnostics`, `health`, `lsp_status`, `reload`.

#### `codeRefactor(params, ctx, symbolIndex, lspManager)`
LSP-powered rename, organize imports, apply quick-fix. All filesystem changes applied automatically.

### Workflow Tools

#### `task(params, storage)`
Persistent task planning with hierarchical subtasks, checkpoints, and progress tracking.

## Architecture

```
@jaksm/dev-tools
├── src/
│   ├── index.ts          # OpenClaw plugin adapter (thin boundary)
│   ├── core/             # Pure TypeScript core (zero OC deps)
│   │   ├── index.ts      # DevToolsCore class
│   │   ├── types.ts      # All type definitions
│   │   ├── tree-sitter/  # Multi-language parsing engine
│   │   ├── index/        # Symbol index, workspace indexer, import graph
│   │   ├── search/       # Embedding provider + HNSW vector index
│   │   ├── lsp/          # Language Server Protocol manager
│   │   └── task/         # Task storage and plan management
│   └── tools/            # Individual tool implementations
│       ├── index.ts      # Barrel export (import from '@jaksm/dev-tools/tools')
│       ├── file-read.ts
│       ├── code-search.ts
│       └── ...
```

The adapter layer (`src/index.ts`) maps OpenClaw's plugin API to the pure TS core. If you're not using OpenClaw, import from `/tools` and `/core` directly — zero adapter overhead.

## Configuration

When used as an OpenClaw plugin, configure via `openclaw.plugin.json` or plugin config:

```json
{
  "search": {
    "provider": "local",
    "reindexDebounceMs": 5000
  },
  "lsp": {
    "servers": {
      "typescript": { "enabled": true },
      "python": { "enabled": true }
    }
  },
  "tokenBudget": {
    "maxResponseTokens": 50000
  }
}
```

When used standalone, pass config to `DevToolsCore`:

```typescript
const core = new DevToolsCore({
  config: {
    search: { provider: 'local' },
    lsp: { servers: { typescript: { enabled: true } } },
  },
  logger: console,
})
```

## Requirements

- Node.js >= 20
- For LSP tools: language servers must be installed (`typescript-language-server`, `pyright`, etc.)
- For semantic search: runs local embeddings via `@huggingface/transformers` (no API key needed)

## License

MIT
