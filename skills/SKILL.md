---
name: dev-tools
description: "Complete coding toolbox — 13 tools for file operations, code intelligence, semantic search, LSP diagnostics, task planning, git, and testing. Use when: writing code, exploring codebases, debugging, refactoring, running tests, or planning multi-step development work. Replaces the need for spawning external coding agents. NOT for: non-code tasks, browser automation, or deployment operations."
metadata:
  {
    "openclaw":
      {
        "emoji": "🛠️",
        "requires": { "bins": ["rg"], "anyBins": ["node", "bun"] },
        "install":
          [
            {
              "id": "rg",
              "kind": "brew",
              "formula": "ripgrep",
              "bins": ["rg"],
              "label": "Install ripgrep (required for grep/search)",
            },
          ],
      },
  }
---

# Dev-Tools — Coding Toolbox

13 native tools for code intelligence, editing, search, diagnostics, and workflow management. Everything a dev agent needs in one plugin — no TUI coding agents, no PTY, no overhead.

## Quick Start

Your workspace was auto-analyzed on session start. Check what's available:

```
code_search { action: "stats" }     ← workspace overview: languages, symbols, embeddings
code_diagnose { action: "health" }  ← engine status: tree-sitter, LSP, embeddings
```

## Tool Selection Guide

**Exploring (what's here?):**
- `ls` — directory tree, first thing in unfamiliar code
- `glob` — find files by pattern (`**/*.test.ts`, `**/Dockerfile`)
- `code_outline` — structure of a file or module (classes, functions, exports)
- `code_search { action: "index" }` — browse the full symbol index

**Finding code (where is it?):**
- `grep` — exact text/regex: function names, imports, strings, TODOs
- `code_search` — semantic: describe what the code *does* ("authentication middleware", "parse config")
- `code_read` — read a specific symbol by name (avoids reading entire files)

**Understanding code (what does it do?):**
- `code_read` — source code of a function/class/method by name
- `code_inspect` — type info + definition + all references (LSP-powered)
- `file_read` — raw file with line numbers (config files, non-code)

**Modifying code:**
- `file_edit` — search-and-replace in existing files (primary editing tool)
- `file_write` — create new files or full rewrites
- `code_refactor { action: "rename" }` — safe cross-workspace symbol rename
- `code_refactor { action: "organize_imports" }` — clean up imports
- `code_refactor { action: "apply_fix" }` — apply suggested fix from diagnostics

**Verifying changes:**
- `test` — run tests, get structured pass/fail with failure details
- `code_diagnose` — LSP errors and warnings after edits
- `shell` — build commands, linters, custom verification scripts

**Workflow:**
- `task` — plan/track multi-step work, checkpoint progress, export summaries
- `git` — structured status/diff/commit/log/branch
- `shell` — anything else (install deps, run scripts, one-off commands)

## The Editing Workflow

The core loop for making changes:

```
1. Understand    code_outline → code_read / code_inspect
2. Plan          task { action: "plan" } (for complex changes)
3. Edit          file_edit (existing) or file_write (new files)
4. Verify        test + code_diagnose
5. Fix           iterate on failures from step 4
6. Commit        git { action: "commit" }
```

### file_edit Best Practices

- **Always read before editing.** Use `code_read` or `file_read` to see current content before calling `file_edit`. The oldText must exist in the file.
- **Include enough context in oldText.** Don't match just `return true;` — include surrounding lines to ensure uniqueness.
- **Use lineHint for disambiguation.** If your oldText appears multiple times, provide the approximate line number.
- **Batch related edits.** Multiple edits to the same file in one `file_edit` call are applied sequentially — more efficient and atomic.
- **Check LSP diagnostics.** `file_edit` returns diagnostics from the language server if available. Read them — they tell you if your edit introduced errors.

## Semantic Search Tips

`code_search` with semantic mode finds code by *meaning*, not text:

```
code_search { query: "handle user authentication" }     ← finds auth middleware, login handlers
code_search { query: "database connection pooling" }     ← finds pool config, connection manager
code_search { query: "parse command line arguments" }    ← finds CLI parser, arg handling
```

For exact text (variable names, imports, strings), use `grep` instead — it's faster and more precise.

Use `scope` to limit results: `code_search { query: "...", scope: "src/auth" }`

## Task Planning

For multi-step work, use the `task` tool to stay organized:

```
task { action: "plan", goal: "Add rate limiting to API", tasks: [
  { title: "Research current middleware stack" },
  { title: "Implement rate limiter", subtasks: [
    { title: "Add rate limit middleware" },
    { title: "Add configuration" },
    { title: "Add tests" }
  ]},
  { title: "Verify full test suite passes" }
]}
```

Call `task { action: "status" }` frequently — it's your orientation tool. After completing work, update with context:

```
task { action: "update", id: "2.1", status: "completed", context: {
  findings: ["Express middleware chain runs sequentially"],
  decisions: ["Used sliding window algorithm — better for bursty traffic"],
  files: ["src/middleware/rate-limit.ts", "src/middleware/rate-limit.test.ts"]
}}
```

## Self-Verification Protocol

Before reporting work as done, verify:

1. **Tests pass:** `test` — 0 failures
2. **No LSP errors:** `code_diagnose` — 0 errors (warnings are acceptable)
3. **Build succeeds:** `shell { command: "<build command>" }` — exit code 0
4. **Review your diff:** `git { action: "diff" }` — check for debug code, console.logs, TODO comments

## Setup

First time:
```bash
openclaw dev-tools setup        # download embedding model, check prerequisites
openclaw dev-tools init          # index current workspace
```

### Optional LSP Servers

Install language servers for full intelligence (type info, references, refactoring):

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# Python
npm i -g pyright

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest

# Swift (ships with Xcode)
xcode-select --install
```

Without LSP servers, `code_inspect` falls back to symbol index (still useful, but no type information), and `code_refactor`/`code_diagnose` are unavailable.

**Tip:** After installing a language server via `shell`, the LSP will auto-detect it on the next tool call — no restart needed.

## Configuration

Add to your `openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "dev-tools": {
        "enabled": true,
        "config": {
          "projectRoots": ["~/Projects/myapp"],
          "search": { "provider": "local" },
          "lsp": { "maxRestartAttempts": 3 },
          "shell": { "defaultTimeout": 120000 },
          "tokenBudget": { "maxResponseTokens": 4000 }
        }
      }
    }
  }
}
```

`projectRoots` maps the agent's workspace to an actual project directory — all tools operate on the project, not the agent workspace.

Settings can also be set via environment variables:

| Setting | Env Var | Default | Description |
|---|---|---|---|
| `search.provider` | `DEV_TOOLS_SEARCH_PROVIDER` | `local` | Embedding provider: `local` or `api` |
| `search.model` | `DEV_TOOLS_SEARCH_MODEL` | `Xenova/all-MiniLM-L6-v2` | Embedding model |
| `shell.defaultTimeout` | `DEV_TOOLS_SHELL_TIMEOUT` | `120000` | Shell command timeout (ms) |
| `tokenBudget.maxResponseTokens` | `DEV_TOOLS_TOKEN_BUDGET` | `4000` | Max tokens per tool response |
| `lsp.maxRestartAttempts` | `DEV_TOOLS_LSP_MAX_RESTARTS` | `3` | LSP crash recovery attempts |
| `lsp.debug` | `DEV_TOOLS_LSP_DEBUG` | `false` | Verbose LSP logging |

## Notes

- All file paths are relative to workspace root unless stated otherwise
- `.gitignore` is respected by `grep`, `glob`, `ls`, and indexing
- Token budget truncation saves full output to disk — use `file_read` or `grep` to access truncated content
- LSP servers lazy-boot on first use — no startup cost until needed
- Symbol index updates incrementally via file watcher — always current
- After gateway restart, a full re-index runs automatically (incremental only works within a session)
- LSP servers auto-detect binary installation mid-session — install via `shell`, then use `code_inspect`/`code_diagnose` immediately
