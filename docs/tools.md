# Tools Reference

16 tools organized into three groups: Foundation (7), Intelligence (6), Workflow (3).

All tools return structured JSON with `success`, `data`, `error`, and optional `summary` fields.

---

## Foundation Tools (7)

### file_read

Read file contents with line numbers, pagination, binary detection, and filename suggestions.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | File path relative to workspace root |
| `offset` | number | | Start line (1-indexed) |
| `limit` | number | | Max lines to return |

**Behavior:**
- Detects binary files by extension and content analysis (null bytes, non-printable ratio)
- Image files (jpg, png, gif, webp, svg, ico) return a descriptive message instead of binary content
- If file not found, searches the parent directory for similar filenames and suggests them
- Respects .gitignore — warns if path is gitignored
- Output includes line numbers, total line count, detected language, and pagination info
- Large output truncated by token budget; full content saved to `tool-output/` with continuation hint

### file_write

Create or overwrite files with automatic parent directory creation.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | File path relative to workspace root |
| `content` | string | ✅ | Complete file content |

**Behavior:**
- Creates parent directories automatically (`mkdir -p`)
- Returns `created` (new file) or `overwritten` (existing) status with byte count
- Uses per-file mutex to serialize concurrent writes

### file_edit

Search-and-replace editing with cascading match strategies.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | File path relative to workspace root |
| `edits` | array | ✅ | Array of `{ oldText, newText, lineHint? }` |

**Behavior:**
- Cascading match strategies (tried in order):
  1. Exact match
  2. Line-trimmed (trim each line)
  3. Block-anchor (first/last line anchors + Levenshtein distance for middle)
  4. Whitespace-normalized (collapse whitespace)
  5. Indentation-flexible (strip minimum indent)
  6. Escape-normalized (normalize string escapes)
  7. Unicode-normalized (NFC + smart quote normalization)
- Multiple edits per call applied sequentially to the same file
- If `oldText` matches multiple locations and no `lineHint`: returns all locations with context for disambiguation
- With `lineHint`: picks nearest match within ±5 lines
- After edits, returns LSP diagnostics if available (errors + warnings)
- Uses per-file mutex

### shell

Execute shell commands with safety guards.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `command` | string | ✅ | Shell command to execute |
| `cwd` | string | | Working directory (relative to workspace root) |
| `timeout` | number | | Timeout in ms (default: 120000) |
| `background` | boolean | | Start and return immediately |

**Behavior:**
- Blocked interactive commands: vim, nano, less, more, top, htop, python/node REPL, ssh, tmux, screen
- Blocked dangerous patterns: `rm -rf /`, `rm -rf ~`, `curl|bash`, `wget|sh`, `mkfs`, `dd if=`, `:(){ :|:& };:`
- Custom blocklist via config `shell.blocklist`
- Returns `{ exitCode, stdout, stderr }` — stdout/stderr truncated by token budget
- Background mode: starts process and returns PID immediately
- After execution, notifies LSP manager to invalidate binary prereq cache (so newly installed LSP servers are detected)

### grep

Regex search via ripgrep, .gitignore-aware.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | ✅ | Regex pattern |
| `path` | string | | Directory to search in |
| `glob` | string | | File glob filter (e.g., `*.ts`) |
| `mode` | string | | `content` (default), `files`, or `count` |
| `caseInsensitive` | boolean | | Case-insensitive search |
| `multiline` | boolean | | Multiline matching |
| `contextLines` | number | | Context lines around matches (default: 2) |

**Behavior:**
- Uses `rg` (ripgrep) — required binary
- `content` mode: returns matches grouped by file with surrounding context
- `files` mode: returns just matching file paths
- `count` mode: returns match count per file
- Results capped at 100 matches
- Respects .gitignore automatically

### glob

Find files by pattern, sorted by modification time.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | ✅ | Glob pattern (e.g., `**/*.test.ts`) |
| `path` | string | | Base directory |

**Behavior:**
- Returns `{ path, size, modified }` for each match
- Sorted by most recently modified first
- Respects .gitignore

### ls

Directory tree with sizes and child counts.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | | Directory (default: workspace root) |
| `depth` | number | | Recursion depth (default: 2) |

**Behavior:**
- Shows files with sizes and directories with child counts
- Respects .gitignore
- Entries sorted: directories first, then files

---

## Intelligence Tools (6)

### code_outline

Hierarchical symbol view for a file or directory.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `path` | string | ✅ | File or directory path |

**Behavior:**
- **File mode:** Returns hierarchical tree (class → methods → nested) with signatures, line numbers, exports
- **Directory mode:** Returns flat summary of top-level symbols per file — module's public API at a glance
- Powered by tree-sitter symbol index (no LSP required)

### code_read

Read a specific symbol's source code by name.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | ✅ | Simple (`authenticate`) or qualified (`UserService.authenticate`) |
| `file` | string | | File path hint for disambiguation |
| `scope` | string | | Scope hint (e.g., class name) |
| `context` | string | | `siblings`, `class`, or `dependencies` |

**Behavior:**
- Resolves symbol via the symbol index
- Automatically includes the file's import statements
- Context modes:
  - `siblings`: signatures of adjacent functions in the same file
  - `class`: full class outline with target method expanded
  - `dependencies`: symbols referenced by `this.xxx` in the code
- If symbol exists in multiple files, returns disambiguation list

### code_search

Semantic or text search, plus index browsing.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `action` | string | | `search` (default), `stats`, or `index` |
| `query` | string | | Search query (for `search` action) |
| `mode` | string | | `semantic` (default) or `text` |
| `scope` | string | | Limit to directory |
| `limit` | number | | Max results (default: 10) |
| `filter` | string | | Glob filter for `index` action |

**Actions:**
- **search**: Semantic (embedding) or text (ripgrep) search. Returns symbols with file, lines, kind, snippet, and relevance score.
- **stats**: Workspace overview — languages, symbol counts by kind, embedding stats, storage size.
- **index**: Browse INDEX.json with optional glob filter.

### code_inspect

Type info + definition + all references via LSP (with symbol index fallback).

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `symbol` | string | ✅ | Symbol name |
| `file` | string | | File path hint |
| `scope` | string | | Scope hint |
| `line` | number | | Line number hint |
| `includeReferences` | boolean | | Include refs (default: true) |
| `maxReferences` | number | | Max refs to return (default: 20) |

**Behavior:**
- With LSP: returns hover type info, definition location, and all references with file/line/preview
- Without LSP: returns symbol info from index with graceful degradation message
- Explains why LSP is unavailable (not installed, language not supported, server crashed, etc.)

### code_diagnose

Compiler errors/warnings, engine health, LSP status.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `action` | string | | `diagnostics` (default), `health`, `lsp_status`, or `reload` |
| `file` | string | | Filter by file |
| `directory` | string | | Filter by directory |
| `root` | string | | Filter by monorepo root |
| `severity` | string | | Min severity: `error`, `warning` (default), `info`, `hint`, `all` |
| `limit` | number | | Max diagnostics (default: 50) |

**Actions:**
- **diagnostics**: LSP errors/warnings with file, line, message, severity, and available quick-fixes. Supports monorepo grouping.
- **health**: Engine status overview — tree-sitter, embeddings, LSP (languages, running servers, capabilities).
- **lsp_status**: Detailed per-server debug info (pid, uptime, root, language, open docs, diagnostics summary).
- **reload**: Restart all LSP servers and clear cached diagnostics.

### code_refactor

Cross-workspace rename, import organization, and quick-fix application.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `rename`, `organize_imports`, or `apply_fix` |
| `symbol` | string | | For rename: symbol to rename |
| `newName` | string | | For rename: new name |
| `file` | string | | File hint for rename |
| `scope` | string | | Scope hint for rename |
| `path` | string | | For organize_imports: file path |
| `fixFile` | string | | For apply_fix: file with diagnostic |
| `fixLine` | number | | For apply_fix: line of diagnostic |
| `fixIndex` | number | | For apply_fix: which fix (default: 0) |

**Behavior:**
- **rename**: Resolves symbol via index → LSP `textDocument/rename`. Applies workspace edit to all affected files. Reports changed files with edit counts.
- **organize_imports**: Requests `source.organizeImports` code action from LSP. Applies resulting edits.
- **apply_fix**: Finds diagnostic at specified line → requests code actions → applies the fix. Uses `fixIndex` when multiple diagnostics exist on the same line.
- After any refactoring, triggers symbol reindex for affected files.

---

## Workflow Tools (3)

### task

Plan, track, and adapt multi-step work with persistent task lists.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `plan`, `status`, `update`, `add`, `replan`, `checkpoint`, `export`, `list` |
| `planId` | string | | Target plan (default: most recent active) |
| `goal` | string | | For plan: goal description |
| `tasks` | array | | For plan/add: task definitions with subtasks |
| `id` | string | | For update/checkpoint: task ID |
| `status` | string | | For update: `pending`, `in_progress`, `completed`, `failed`, `cancelled`, `blocked` |
| `notes` | string | | For update: progress notes |
| `context` | object | | For update: `{ findings, decisions, files }` |
| `parentId` | string | | For add: parent task ID (`root` for top-level) |
| `after` | string | | For add: insert after sibling ID |
| `cancel` | array | | For replan: task IDs to cancel |
| `add` | array | | For replan: new tasks to add |
| `reason` | string | | For replan: why plan changed |
| `summary` | string | | For checkpoint: narrative summary |
| `format` | string | | For export: `summary` (~500 tokens) or `full` (complete JSON) |

**Behavior:**
- Plans persist as JSON files in `~/.dev-tools/{slug}/plans/`
- Completed plans automatically move to `completed-plans/`
- Hierarchical task IDs (1, 1.1, 1.1.1) auto-generated or manually specified
- Checkpoint tasks trigger prompts when all subtasks complete
- Context fields (findings, decisions, files) aggregate up during checkpoints
- History log tracks all status changes with timestamps
- Soft ownership: `createdBy` and `lastModifiedBy` fields

### git

Structured git operations with JSON output.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `status`, `diff`, `commit`, `log`, `branch` |
| `files` | array | | For commit: files to stage |
| `message` | string | | For commit: commit message |
| `staged` | boolean | | For diff: show staged changes |
| `file` | string | | For diff: single file |
| `limit` | number | | For log: max commits (default: 10) |
| `author` | string | | For log: filter by author |
| `since` | string | | For log: filter by date |
| `path` | string | | For log: filter by path |

**Actions:**
- **status**: Returns `{ staged, unstaged, untracked }` arrays with file paths and status codes
- **diff**: Returns per-file hunks with insertions/deletions counts
- **commit**: Stages specified files and commits. Returns hash, message, files committed
- **log**: Returns commits with hash, author, date, message, changed files
- **branch**: Returns all branches with current branch marked, last commit info

### test

Run tests with structured results and framework auto-detection.

**Parameters:**
| Param | Type | Required | Description |
|---|---|---|---|
| `file` | string | | Run only this test file |
| `name` | string | | Filter by test name pattern |
| `suite` | string | | Filter by suite/describe name |
| `timeout` | number | | Timeout in ms (default: 300000) |

**Supported frameworks:**
| Framework | Detection | Output parsing |
|---|---|---|
| Vitest | `vitest` in package.json | JSON reporter |
| Jest | `jest` in package.json | JSON reporter |
| pytest | `pytest.ini`, `setup.cfg`, `pyproject.toml` | Summary line parsing |
| cargo test | `Cargo.toml` | Summary line parsing |
| swift test | `Package.swift` | Summary line parsing |
| go test | `go.mod` | JSON event stream |

**Behavior:**
- Auto-detects framework from workspace analysis
- Suite + name filters combined for vitest/jest (`--testNamePattern`)
- For pytest, suite and name combined via `-k "suite and name"`
- Returns `{ passed, failed, skipped, duration, failures[] }` with per-failure details (name, file, line, error, stack)
- Falls back to raw output parsing when JSON parsing fails
