# Configuration

## Config Resolution

Configuration is resolved in this order (highest wins):

1. **Environment variables** (`DEV_TOOLS_*`)
2. **Plugin config** from `openclaw.json` → `plugins.entries.dev-tools.config`
3. **Defaults**

## Plugin Config

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "dev-tools": {
        "enabled": true,
        "config": {
          "projectRoots": ["~/Projects/myapp"],
          "search": {
            "provider": "local",
            "model": "Xenova/all-MiniLM-L6-v2",
            "reindexDebounceMs": 2000
          },
          "lsp": {
            "maxRestartAttempts": 3,
            "debug": false
          },
          "index": {
            "maxFileSize": "256KB"
          },
          "shell": {
            "defaultTimeout": 120000,
            "blocklist": []
          },
          "tokenBudget": {
            "maxResponseTokens": 4000
          },
          "roots": [
            { "path": "packages/backend", "language": "typescript" },
            { "path": "packages/mobile", "language": "swift" }
          ]
        }
      }
    }
  }
}
```

## Config Schema

### `projectRoots` (string[])

Project directories to auto-activate on session start. First valid path wins.

```json
"projectRoots": ["~/Projects/myapp", "~/Projects/fallback"]
```

This bridges the gap between agent workspaces (`~/.openclaw/workspace-X/`) and actual project directories. Without this, tools would operate on the agent workspace (which has no code).

**Resolution order:**
1. Project registry match (from previous `dev-tools init`)
2. First valid path in `projectRoots`
3. Agent workspace fallback

### `search`

| Key | Type | Default | Description |
|---|---|---|---|
| `provider` | `"local"` \| `"api"` | `"local"` | Embedding provider |
| `model` | string | `"Xenova/all-MiniLM-L6-v2"` | Embedding model name |
| `reindexDebounceMs` | number | `2000` | Debounce for file watcher re-indexing |

**Local provider:** Uses `@xenova/transformers` to run the model locally. No API key needed. Model downloaded to `~/.dev-tools/models/` on first use.

**API provider:** Uses an external embedding API. Requires `DEV_TOOLS_EMBEDDING_API_KEY` and `DEV_TOOLS_EMBEDDING_API_URL` environment variables.

### `lsp`

| Key | Type | Default | Description |
|---|---|---|---|
| `maxRestartAttempts` | number | `3` | Crash recovery attempts before giving up |
| `debug` | boolean | `false` | Verbose LSP logging |
| `healthCheckIntervalMs` | number | `30000` | Health check interval |
| `servers` | object | `{}` | Per-language server overrides |

### `index`

| Key | Type | Default | Description |
|---|---|---|---|
| `maxFileSize` | string | `"256KB"` | Skip files larger than this |
| `include` | string[] | | Glob patterns to include |
| `exclude` | string[] | | Glob patterns to exclude |

### `shell`

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultTimeout` | number | `120000` | Command timeout in ms |
| `blocklist` | string[] | `[]` | Additional blocked command patterns |

### `tokenBudget`

| Key | Type | Default | Description |
|---|---|---|---|
| `maxResponseTokens` | number | `4000` | Max tokens per tool response |

When a response exceeds the budget, it's truncated and the full output is saved to `~/.dev-tools/{slug}/tool-output/`. The response includes a continuation hint with the spillover file path.

### `roots` (LanguageRootConfig[])

For monorepos: explicitly declare language roots so LSP servers start in the correct directory.

```json
"roots": [
  { "path": "packages/backend", "language": "typescript" },
  { "path": "ios-app", "language": "swift" }
]
```

Without this, dev-tools auto-detects language roots from config files (tsconfig.json, Cargo.toml, etc.).

## Environment Variables

| Variable | Maps to | Default |
|---|---|---|
| `DEV_TOOLS_SEARCH_PROVIDER` | `search.provider` | `local` |
| `DEV_TOOLS_SEARCH_MODEL` | `search.model` | `Xenova/all-MiniLM-L6-v2` |
| `DEV_TOOLS_LSP_MAX_RESTARTS` | `lsp.maxRestartAttempts` | `3` |
| `DEV_TOOLS_LSP_DEBUG` | `lsp.debug` | `false` |
| `DEV_TOOLS_SHELL_TIMEOUT` | `shell.defaultTimeout` | `120000` |
| `DEV_TOOLS_TOKEN_BUDGET` | `tokenBudget.maxResponseTokens` | `4000` |

## Config Validation

On startup, the plugin validates config values and logs warnings for questionable settings:

- `shell.defaultTimeout < 5000` — "very low, most commands will timeout"
- `shell.defaultTimeout > 600000` — "very high, hung commands will block for a long time"
- `tokenBudget.maxResponseTokens < 500` — "very low, most responses will be truncated"
- `lsp.maxRestartAttempts < 1` — "LSP servers won't attempt recovery after crashes"
