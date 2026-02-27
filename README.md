# dev-tools

A complete coding toolbox for OpenClaw agents. 13 native tools for file operations, code intelligence, semantic search, LSP diagnostics, task planning, git, and testing.

**Replaces the need for spawning external coding agents** (Claude Code, Codex, etc.) — agents get structured tool calls with JSON output instead of wrestling with TUI processes.

## Quick Setup

```bash
# 1. Install prerequisites
brew install ripgrep                                    # required for grep/search
npm i -g typescript-language-server typescript           # optional: TypeScript LSP

# 2. Run setup (downloads embedding model, checks prerequisites)
openclaw dev-tools setup

# 3. Initialize for a workspace (indexes code, builds embeddings)
cd ~/your-project
openclaw dev-tools init
```

## Tools

### Foundation (7)

| Tool | Purpose |
|---|---|
| `file_read` | Read files with line numbers, pagination, binary detection |
| `file_write` | Create/overwrite files, auto-create directories |
| `file_edit` | Search-and-replace with flexible matching, multiple edits per call |
| `shell` | Execute commands with safety guards (blocked interactive/dangerous commands) |
| `grep` | Fast regex search via ripgrep, .gitignore-aware |
| `glob` | Find files by pattern, sorted by modification time |
| `ls` | Directory tree with sizes and child counts |

### Intelligence (6)

| Tool | Purpose |
|---|---|
| `code_outline` | Hierarchical symbol view: classes → methods → nested structure |
| `code_read` | Read specific symbol's source code by name |
| `code_search` | Semantic search by meaning ("auth middleware") or text, plus index browsing |
| `code_inspect` | Type info + definition + all references via LSP (falls back to symbol index) |
| `code_diagnose` | LSP errors/warnings, engine health, server status |
| `code_refactor` | Cross-workspace rename, organize imports, apply quick-fixes |

### Workflow (3)

| Tool | Purpose |
|---|---|
| `task` | Plan/track multi-step work: 8 actions (plan, status, update, add, replan, checkpoint, export, list) |
| `git` | Structured git: status, diff, commit, log, branch — JSON output |
| `test` | Run tests with structured results: 6 frameworks (Jest, Vitest, pytest, cargo, swift, go) |

## Architecture

```
┌─────────────────────────────────────────┐
│           OpenClaw Agent Session         │
│  ┌────────────────────────────────────┐  │
│  │     dev-tools plugin (adapter)     │  │
│  │  ┌──────────────────────────────┐  │  │
│  │  │   DevToolsCore (pure TS)     │  │  │
│  │  │  ┌────────┐  ┌───────────┐  │  │  │
│  │  │  │  Tools  │  │  Engines  │  │  │  │
│  │  │  │ 16 impl │  │ tree-sit  │  │  │  │
│  │  │  │         │  │ HNSW+emb  │  │  │  │
│  │  │  │         │  │ LSP mgr   │  │  │  │
│  │  │  └────────┘  └───────────┘  │  │  │
│  │  └──────────────────────────────┘  │  │
│  └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
                    │
                    ▼
         ~/.dev-tools/{project-slug}/
         ├── index/          ← symbol index, embeddings, INDEX.json
         ├── plans/          ← task plans (active + completed)
         ├── logs/           ← tool call JSONL logs
         └── tool-output/    ← truncated output spillover
```

**Core has zero OpenClaw dependencies.** The adapter layer maps OC's plugin API to the pure-TS core. This makes the core testable, portable, and reusable outside OpenClaw.

## SKILL.md Variants

Three skill files for different setups:

| File | For | Description |
|---|---|---|
| `SKILL.md` | Solo agents, general use | Full tool guide with selection patterns, editing workflow, self-verification |
| `SKILL-developer.md` | Developer (tech lead) agents | Adds master planning, worktree dispatch, review/merge protocol, checkpoint management |
| `SKILL-subagent.md` | Sub-agents in multi-agent setup | Focused execution: explore → implement → test → verify → export |

Assign via OpenClaw tool policy. The tools work identically regardless of which skill is loaded.

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "dev-tools": {
      "search": {
        "provider": "local",
        "model": "Xenova/all-MiniLM-L6-v2"
      },
      "lsp": {
        "maxRestartAttempts": 3,
        "debug": false
      },
      "shell": {
        "defaultTimeout": 120000,
        "jail": true
      },
      "tokenBudget": {
        "maxResponseTokens": 4000
      }
    }
  }
}
```

Or via environment variables: `DEV_TOOLS_SEARCH_PROVIDER`, `DEV_TOOLS_SHELL_TIMEOUT`, `DEV_TOOLS_LSP_DEBUG`, etc.

## Supported Languages

| Language | Tree-sitter | Semantic Search | LSP Server |
|---|---|---|---|
| TypeScript/TSX | ✅ | ✅ | `typescript-language-server` |
| JavaScript/JSX | ✅ | ✅ | `typescript-language-server` |
| Python | ✅ | ✅ | `pyright-langserver` |
| Rust | ✅ | ✅ | `rust-analyzer` |
| Go | ✅ | ✅ | `gopls` |
| Swift | ✅ | ✅ | `sourcekit-lsp` |
| Java | ✅ | ✅ | — |
| Kotlin | ✅ | ✅ | — |
| C# | ✅ | ✅ | — |
| JSON, HTML, CSS, Bash | ✅ | — | — |

Tree-sitter provides symbol extraction and code intelligence for all listed languages. LSP adds type information, references, and refactoring for languages with configured servers.

## Development

```bash
# Run tests (891+ tests)
cd ~/.openclaw/extensions/dev-tools
npx vitest run

# Type check
npx tsc --noEmit

# Watch mode
npx vitest
```

## License

MIT
