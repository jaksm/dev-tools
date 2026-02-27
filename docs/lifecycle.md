# Lifecycle & Hooks

## Plugin Registration

On gateway start, `register(api)` is called once:

1. **Resolve config** — merge defaults + plugin config + env vars
2. **Create DevToolsCore** — central orchestrator (pure TS, no OC dependency)
3. **Register tool factory** — `api.registerTool()` with a factory that builds all 16 tools per session
4. **Register hooks** — `session_start`, `session_end`, `before_prompt_build`, `after_tool_call`
5. **Register slash command** — `/dev-tools [setup|init|status]`

## Auto-Activation

The plugin decouples **agent workspaces** (`~/.openclaw/workspace-X/`) from **project directories** (`~/Projects/myapp/`). Auto-activation resolves which project an agent should work on.

**Trigger:** First `before_prompt_build` call (lazy, not on session_start).

Why `before_prompt_build` instead of `session_start`: Session start only fires for brand-new sessions. After a gateway restart, existing sessions resume without a new session_start. `before_prompt_build` fires on every prompt, so activation works reliably after restarts.

**Resolution order:**
1. **Project registry** — Check `~/.dev-tools/registry.json` for a saved workspace→project mapping (from previous `dev-tools init`)
2. **Config projectRoots** — Try each path in `config.projectRoots` array, first valid path wins
3. **Agent workspace fallback** — Use the agent's own workspace directory

**On activation:**
1. `analyzeWorkspace(projectDir)` — detect languages, test runners, .gitignore, git
2. `onSessionStart(projectDir)` — ensure storage dirs, clean old tool output, start file watcher
3. `indexWorkspace(projectDir)` — parse all source files, extract symbols, build import graph
4. `startEmbeddingIndex(projectDir)` — generate embeddings for all symbols

Activation happens once per gateway lifecycle (`activated` flag). Subsequent `before_prompt_build` calls skip re-activation.

## Context Injection

On every `before_prompt_build`, the plugin returns a `prependContext` string that's injected at the top of the agent's prompt. Format:

```
[dev-tools] 16 tools active | /path/to/project
Languages: typescript, python
Test runners: vitest (vitest), pytest (pytest)
Symbols: 2171 indexed (45s ago)
Semantic search: ready (2387 embeddings)
LSP: typescript (active), python (idle)

Tool guide: ls/glob to explore → code_outline for structure → ...
```

This tells the agent:
- Which project is active
- What languages were detected
- How many symbols are indexed (and how fresh)
- Whether semantic search is ready
- Which LSP servers are running

## Session Lifecycle

### session_start
- Triggers `ensureProjectActivated()` (same as before_prompt_build)
- Ensures activation happens for both new sessions and resumed sessions

### session_end
- Flush JSONL log buffers
- Stop file watcher
- Dispose embedding model resources

### after_tool_call
- Logs all dev-tools tool calls to `~/.dev-tools/{slug}/logs/tool-calls.jsonl`
- Only logs calls to the 16 dev-tools tools (ignores other plugins' tools)
- Logs against the active project dir (not agent workspace)

## File Watcher

Started during session activation. Watches the project directory for file changes.

**On file change:**
1. Debounce (configurable, default 2s)
2. Re-parse changed file via tree-sitter
3. Update symbol index (add/remove/update symbols)
4. Re-generate embeddings for changed symbols
5. Notify LSP via `textDocument/didSave` (if server is running)

**Limitations:**
- Only active during a session — stops on session_end
- Full re-index happens on next session start (using mtime manifest for efficiency)

## Slash Commands

### `/dev-tools setup`
Downloads the embedding model and tree-sitter grammars. Checks prerequisites (ripgrep, node/bun). Reports installed LSP servers.

### `/dev-tools init [path]`
Indexes a project directory. If `path` is provided, uses that directory; otherwise uses the agent workspace. Sets the active project mapping. Triggers full workspace analysis.

### `/dev-tools status`
Shows current state: agent workspace, active project, whether project is explicitly set, and the workspace status string.

## Project Registry

`~/.dev-tools/registry.json` persists workspace→project mappings:

```json
{
  "/Users/me/.openclaw/workspace-jaksa": "/Users/me/Projects/myapp"
}
```

Updated when:
- `/dev-tools init <path>` is run
- `setActiveProject()` is called

Read during auto-activation to restore the mapping after gateway restarts.

## Incremental Re-indexing

### Within a session
File watcher detects changes → re-parses only changed files → updates index + embeddings.

### Across restarts
Manifest file (`~/.dev-tools/{slug}/index/manifest.json`) stores `{ filePath: mtime }` for every indexed file.

On restart:
1. Load manifest from previous session
2. Walk project files, compare current mtime to manifest
3. Only re-parse files where mtime changed
4. Add new files, remove deleted files
5. Save updated manifest

This reduces re-index time from minutes to seconds for large projects where only a few files changed.
