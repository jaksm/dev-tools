/**
 * Tool metadata — IDs, descriptions, and JSON Schema parameter definitions.
 *
 * Use this to register tools with any agent framework (Mastra, LangChain, Vercel AI SDK, etc.)
 * without manually writing descriptions or schemas.
 *
 * @example
 * ```ts
 * import { toolMetadata } from '@jaksm/dev-tools/tools'
 *
 * // Get metadata for a specific tool
 * const meta = toolMetadata.file_read
 * console.log(meta.id)          // 'file_read'
 * console.log(meta.label)       // 'Read File'
 * console.log(meta.description) // multi-line agent guidance
 * console.log(meta.parameters)  // JSON Schema object
 * ```
 */

/** Tool metadata entry — everything an agent framework needs to register a tool. */
export interface ToolMetadataEntry {
  /** Snake_case tool identifier (e.g., 'file_read', 'code_search'). */
  id: string;
  /** Human-readable label (e.g., 'Read File'). */
  label: string;
  /** Multi-line description with usage guidance for the agent. */
  description: string;
  /** JSON Schema definition of the tool's parameters. */
  parameters: Record<string, unknown>;
  /** Which category this tool belongs to. */
  category: "foundation" | "code_intelligence" | "workflow";
}

// ── Foundation Tools ─────────────────────────────────────────────────────────

const file_read: ToolMetadataEntry = {
  id: "file_read",
  label: "Read File",
  description: [
    "Read the contents of a file with line numbers.",
    "Use this to examine source code, configuration files, or any text file in the project.",
    "Automatically detects binary files and suggests similar filenames when the path is wrong.",
    "For large files, use offset and limit to paginate — the response shows total line count so you know how much remains.",
    "Prefer this over shell(cat) because it gives structured output with line numbers and handles edge cases.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root (e.g., 'src/index.ts', 'package.json')" },
      offset: { type: "number", description: "Start reading from this line number (1-indexed). Use with limit for pagination." },
      limit: { type: "number", description: "Maximum number of lines to return. Omit to read the entire file." },
    },
    required: ["path"],
  },
  category: "foundation",
};

const file_write: ToolMetadataEntry = {
  id: "file_write",
  label: "Write File",
  description: [
    "Create a new file or overwrite an existing file with the provided content.",
    "Automatically creates parent directories if they don't exist.",
    "Use this for creating new files. For modifying existing files, prefer file_edit — it's safer and preserves unmodified content.",
    "Returns whether the file was created (new) or overwritten (existing), and the byte count.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root (e.g., 'src/utils/helpers.ts')" },
      content: { type: "string", description: "Complete file content to write" },
    },
    required: ["path", "content"],
  },
  category: "foundation",
};

const file_edit: ToolMetadataEntry = {
  id: "file_edit",
  label: "Edit File",
  description: [
    "Make targeted edits to an existing file using search-and-replace.",
    "This is the primary tool for modifying code. Provide one or more edits, each with oldText (the exact text to find) and newText (the replacement).",
    "Matching is flexible: if an exact match fails, it tries whitespace normalization, indentation flexibility, and other strategies — so small formatting differences won't cause failures.",
    "When oldText matches multiple locations, the edit fails and reports all match locations — use lineHint to disambiguate.",
    "Multiple edits in one call are applied sequentially to the same file. Batch related changes together.",
    "After edits, returns LSP diagnostics if available — check these for introduced errors.",
    "IMPORTANT: oldText must appear in the file. Always read the file first if you're unsure of the exact content.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to workspace root" },
      edits: {
        type: "array",
        description: "One or more edit operations, applied in order",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Text to find in the file. Must match existing content (whitespace-flexible). Include enough surrounding context to be unique." },
            newText: { type: "string", description: "Replacement text. Can be empty string to delete content." },
            lineHint: { type: "number", description: "Approximate line number to resolve ambiguity when oldText appears multiple times" },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  category: "foundation",
};

const shell: ToolMetadataEntry = {
  id: "shell",
  label: "Run Shell Command",
  description: [
    "Execute a shell command in the project directory.",
    "Use this for: installing dependencies, running build scripts, executing one-off commands, or any operation not covered by specialized tools.",
    "Do NOT use for: reading files (use file_read), searching code (use grep/code_search), running tests (use test), or git operations (use git).",
    "Interactive commands (vim, python REPL, etc.) are blocked — only non-interactive commands are allowed.",
    "Dangerous patterns (rm -rf /, curl|bash, etc.) are blocked for safety.",
    "Default timeout is 120 seconds. Set background=true for long-running processes like servers.",
    "Output is returned as stdout/stderr with exit code.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute (e.g., 'npm install', 'make build')" },
      cwd: { type: "string", description: "Working directory relative to workspace root (default: workspace root)" },
      timeout: { type: "number", description: "Timeout in milliseconds (default: 120000). Increase for slow builds." },
      background: { type: "boolean", description: "If true, start the process and return immediately without waiting for completion" },
    },
    required: ["command"],
  },
  category: "foundation",
};

const grep: ToolMetadataEntry = {
  id: "grep",
  label: "Search File Contents",
  description: [
    "Search across files using regex patterns. Powered by ripgrep, respects .gitignore.",
    "Use this when you know the exact text or pattern you're looking for — function names, error messages, import statements, string literals, TODOs.",
    "Prefer code_search for conceptual queries (e.g., 'authentication logic') where you don't know the exact text.",
    "Three output modes: 'content' (matching lines with context — default), 'files' (just file paths), 'count' (match counts per file).",
    "Use glob to filter by file type: e.g., glob='*.ts' for TypeScript only, glob='*.test.*' for test files.",
    "Results are capped at 100 matches. Narrow your search with path and glob if you get too many.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Search pattern (regex by default). Examples: 'TODO', 'function\\s+\\w+', 'import.*from'" },
      path: { type: "string", description: "Directory to search in, relative to workspace root (default: entire workspace)" },
      glob: { type: "string", description: "File glob filter (e.g., '*.ts', '*.{js,jsx}', '!*.test.*')" },
      mode: { type: "string", enum: ["content", "files", "count"], description: "'content' = matching lines with context (default), 'files' = just paths, 'count' = match counts" },
      caseInsensitive: { type: "boolean", description: "Case-insensitive search (default: false)" },
      multiline: { type: "boolean", description: "Enable multiline matching for patterns that span multiple lines" },
      contextLines: { type: "number", description: "Lines of context to show around each match (default: 2)" },
    },
    required: ["pattern"],
  },
  category: "foundation",
};

const glob_tool: ToolMetadataEntry = {
  id: "glob",
  label: "Find Files by Pattern",
  description: [
    "Find files matching a glob pattern. Respects .gitignore.",
    "Use this to discover project structure: find all test files, config files, or files matching a naming pattern.",
    "Returns path, size, and modification time for each match, sorted by most recently modified.",
    "For browsing directory structure, prefer ls. For searching file contents, prefer grep.",
    "Examples: '**/*.test.ts', 'src/**/*.css', '**/{Dockerfile,docker-compose*}', '**/README*'",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern (e.g., '**/*.test.ts', 'src/**/*.css')" },
      path: { type: "string", description: "Base directory to search from (relative to workspace root, default: workspace root)" },
    },
    required: ["pattern"],
  },
  category: "foundation",
};

const ls: ToolMetadataEntry = {
  id: "ls",
  label: "List Directory",
  description: [
    "List contents of a directory as a tree structure.",
    "Shows file sizes and child counts for subdirectories. Respects .gitignore.",
    "Use this first when exploring an unfamiliar project — it gives you the lay of the land.",
    "Default depth is 2 levels. Increase depth to see deeper, but be mindful of large projects.",
    "For finding specific files by pattern, prefer glob. For searching file contents, prefer grep.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path relative to workspace root (default: workspace root)" },
      depth: { type: "number", description: "How many levels deep to recurse (default: 2)" },
    },
    required: [],
  },
  category: "foundation",
};

const git: ToolMetadataEntry = {
  id: "git",
  label: "Git Operations",
  description: [
    "Perform git operations with structured JSON output — no parsing raw git output needed.",
    "action='status': Get staged, unstaged, and untracked files as structured arrays. Check this before committing.",
    "action='diff': View changes with structured hunks, insertions, and deletions per file. Use staged=true for staged changes.",
    "action='commit': Stage files and commit. Provide files to auto-stage, or commit already-staged changes.",
    "action='log': View commit history with hash, message, author, date, and changed files. Filter by author, date, or path.",
    "action='branch': List branches with current branch highlighted. Shows last commit info for each branch.",
    "For complex git operations (rebase, cherry-pick, stash), use the shell tool directly.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "diff", "commit", "log", "branch"], description: "Git operation to perform" },
      message: { type: "string", description: "For 'commit': commit message" },
      files: { type: "array", items: { type: "string" }, description: "For 'commit': files to stage before committing (relative paths)" },
      staged: { type: "boolean", description: "For 'diff': show staged changes instead of unstaged (default: false)" },
      file: { type: "string", description: "For 'diff': show changes for a single file only" },
      author: { type: "string", description: "For 'log': filter by author name or email" },
      since: { type: "string", description: "For 'log': show commits after date (e.g., '2 days ago', '2024-01-15')" },
      path: { type: "string", description: "For 'log': show commits that modified this path" },
      limit: { type: "number", description: "For 'log': max commits to return (default: 10)" },
    },
    required: ["action"],
  },
  category: "foundation",
};

const test: ToolMetadataEntry = {
  id: "test",
  label: "Run Tests",
  description: [
    "Run the project's test suite and get structured results — pass/fail counts, durations, and detailed failure information.",
    "Auto-detects the test framework: Jest, Vitest, pytest, cargo test, swift test, or go test.",
    "Each failure includes: test name, suite, file, line number, error message, and stack trace — everything you need to diagnose and fix.",
    "Run without arguments to execute the full test suite. Use file to run a specific test file, or name to filter by test name.",
    "Always run tests after making changes to verify nothing broke. Parse the structured failures to fix issues systematically.",
    "Default timeout is 5 minutes. Increase for large test suites.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "Run only tests in this file (relative to workspace root)" },
      name: { type: "string", description: "Filter by test name pattern (e.g., 'auth', 'should validate')" },
      suite: { type: "string", description: "Filter by test suite / describe block name" },
      timeout: { type: "number", description: "Timeout in milliseconds (default: 300000 = 5 minutes)" },
    },
    required: [],
  },
  category: "foundation",
};

// ── Code Intelligence Tools ──────────────────────────────────────────────────

const code_outline: ToolMetadataEntry = {
  id: "code_outline",
  label: "Code Outline",
  description: [
    "Get the structure of a file or directory — classes, functions, methods, interfaces, types, and their relationships.",
    "For a file: returns a hierarchical tree (e.g., class → methods → nested classes) with signatures, line numbers, and exports.",
    "For a directory: returns a flat summary of top-level symbols per file — useful to understand a module's public API at a glance.",
    "Use this before reading code to understand what's in a file, or to find the right symbol name for code_read or code_inspect.",
    "Much faster than reading an entire file — gives you the map, then use code_read to zoom into specific symbols.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path relative to workspace root (e.g., 'src/auth/', 'src/services/user.ts')" },
    },
    required: ["path"],
  },
  category: "code_intelligence",
};

const code_read: ToolMetadataEntry = {
  id: "code_read",
  label: "Read Symbol",
  description: [
    "Read the source code of a specific symbol (function, class, method) by name.",
    "Prefer this over file_read when you know the symbol name — it extracts exactly the code you need without reading the entire file.",
    "Automatically includes the file's import statements so you understand dependencies.",
    "Symbol resolution: 'UserService' finds the class, 'UserService.authenticate' finds the method. Use file hint to disambiguate if the name exists in multiple files.",
    "Context modes add surrounding information: 'siblings' = signatures of adjacent functions, 'class' = full class outline with target method expanded, 'dependencies' = symbols referenced by this code.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name — simple ('authenticate') or qualified ('UserService.authenticate')" },
      file: { type: "string", description: "File path hint if the symbol name is ambiguous across files" },
      scope: { type: "string", description: "Scope hint — e.g., class name to find a method: scope='UserService', symbol='authenticate'" },
      context: { type: "string", enum: ["siblings", "class", "dependencies"], description: "'siblings' = adjacent function signatures, 'class' = class outline with target expanded, 'dependencies' = referenced symbols" },
    },
    required: ["symbol"],
  },
  category: "code_intelligence",
};

const code_search: ToolMetadataEntry = {
  id: "code_search",
  label: "Search Code Semantically",
  description: [
    "Search the codebase by meaning, not just text. Uses embeddings to find code that matches your intent.",
    "Use this when you don't know the exact name — describe what the code does: 'user authentication', 'parse JSON response', 'database connection pool'.",
    "Prefer grep when you know the exact text (function name, variable, string literal).",
    "Actions: 'search' (default — semantic or text search), 'stats' (workspace index statistics — call this first to understand the codebase), 'index' (browse the full symbol index with optional path filter).",
    "Semantic mode is default. Falls back to text (ripgrep) during initial indexing or when explicitly set with mode='text'.",
    "Use scope to limit results to a directory (e.g., scope='src/auth' to search only auth module).",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "stats", "index"], description: "'search' = find code (default), 'stats' = index statistics, 'index' = browse full symbol index" },
      query: { type: "string", description: "Natural language description of what you're looking for (e.g., 'error handling middleware', 'database migrations')" },
      mode: { type: "string", enum: ["semantic", "text"], description: "'semantic' = embedding-based (default), 'text' = ripgrep-backed text search" },
      scope: { type: "string", description: "Limit search to a directory (relative path, e.g., 'src/auth')" },
      limit: { type: "number", description: "Max results to return (default: 10)" },
      filter: { type: "string", description: "For action='index': glob filter (e.g., 'src/auth/**')" },
    },
    required: [],
  },
  category: "code_intelligence",
};

const code_inspect: ToolMetadataEntry = {
  id: "code_inspect",
  label: "Inspect Symbol",
  description: [
    "Get complete information about a symbol: its type signature, where it's defined, and every place it's used.",
    "Combines type info (hover), definition location, and all references in one call — no need to call three separate tools.",
    "Uses LSP for precise, compiler-accurate results. Falls back to symbol index analysis when LSP is unavailable.",
    "Use this when you need to understand a symbol's contract (type, parameters, return value), trace its usage across the codebase, or verify a rename is safe.",
    "Set includeReferences=false for faster results when you only need type info and definition location.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      symbol: { type: "string", description: "Symbol name — simple ('authenticate') or qualified ('UserService.authenticate')" },
      file: { type: "string", description: "File path hint to disambiguate if name exists in multiple files" },
      scope: { type: "string", description: "Scope hint (e.g., class name)" },
      line: { type: "number", description: "Line number hint for precise resolution (1-indexed)" },
      includeReferences: { type: "boolean", description: "Include all references across the codebase (default: true). Set false for speed." },
      maxReferences: { type: "number", description: "Maximum references to return (default: 20)" },
    },
    required: ["symbol"],
  },
  category: "code_intelligence",
};

const code_diagnose: ToolMetadataEntry = {
  id: "code_diagnose",
  label: "Diagnose Code",
  description: [
    "Get compiler errors, warnings, and suggested fixes from the language server.",
    "Use action='diagnostics' (default) after making changes to verify your edits didn't break anything.",
    "Use action='health' to check the status of all code intelligence engines (tree-sitter, embeddings, LSP).",
    "Use action='reload' if LSP seems stuck — it restarts all language servers and clears cached diagnostics.",
    "Filter by file, directory, or monorepo root. Severity filter defaults to 'warning' (shows errors + warnings).",
    "Each diagnostic includes location, message, severity, and available quick-fixes that can be applied with code_refactor.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["diagnostics", "health", "lsp_status", "reload"], description: "'diagnostics' = errors/warnings (default), 'health' = engine status, 'lsp_status' = per-server debug info, 'reload' = restart LSP" },
      file: { type: "string", description: "Show diagnostics only for this file (relative to workspace)" },
      directory: { type: "string", description: "Show diagnostics only for files in this directory" },
      root: { type: "string", description: "Filter by monorepo language root (e.g., 'packages/backend')" },
      severity: { type: "string", enum: ["error", "warning", "info", "hint", "all"], description: "Minimum severity to show (default: 'warning' = errors + warnings)" },
      limit: { type: "number", description: "Max diagnostics to return (default: 50)" },
    },
    required: [],
  },
  category: "code_intelligence",
};

const code_refactor: ToolMetadataEntry = {
  id: "code_refactor",
  label: "Refactor Code",
  description: [
    "Perform automated refactoring operations powered by the language server.",
    "action='rename': Rename a symbol across the entire workspace — all references, imports, and type usages updated automatically. Safer than find-and-replace.",
    "action='organize_imports': Clean up imports in a file — remove unused, sort, group.",
    "action='apply_fix': Apply a quick-fix suggested by code_diagnose (e.g., add missing import, fix type error). Reference the fix by file and line number from the diagnostics output.",
    "All actions apply changes to the filesystem directly and report which files were modified.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["rename", "organize_imports", "apply_fix"], description: "Refactoring action to perform" },
      symbol: { type: "string", description: "For 'rename': the symbol to rename (e.g., 'UserService', 'authenticate')" },
      newName: { type: "string", description: "For 'rename': the new name for the symbol" },
      file: { type: "string", description: "For 'rename': file path hint to locate the symbol" },
      scope: { type: "string", description: "For 'rename': scope hint (e.g., class name)" },
      path: { type: "string", description: "For 'organize_imports': the file to organize" },
      fixFile: { type: "string", description: "For 'apply_fix': file containing the diagnostic (from code_diagnose output)" },
      fixLine: { type: "number", description: "For 'apply_fix': line number of the diagnostic (1-indexed)" },
      fixIndex: { type: "number", description: "For 'apply_fix': which fix to apply if multiple diagnostics on the same line (default: 0)" },
    },
    required: ["action"],
  },
  category: "code_intelligence",
};

// ── Workflow Tools ───────────────────────────────────────────────────────────

const task: ToolMetadataEntry = {
  id: "task",
  label: "Task Planning",
  description: [
    "Plan, track, and adapt work with persistent task lists. Use this to stay organized on multi-step work.",
    "Workflow: plan → (status → update → repeat) → checkpoint → export.",
    "action='plan': Create a new plan from a goal and hierarchical task list. Tasks can have subtasks for breakdown.",
    "action='status': Read current plan state — progress, current task, history. Call this frequently to stay oriented.",
    "action='update': Mark a task's progress (in_progress/completed/failed/blocked) and attach notes, findings, decisions, and relevant file paths.",
    "action='add': Insert new tasks under a parent or at root level. Use when scope expands.",
    "action='replan': Cancel tasks and add new ones when the approach changes. Requires a reason for the audit trail.",
    "action='checkpoint': Write a narrative summary at a milestone — auto-aggregates context from completed subtasks.",
    "action='export': Produce a compact summary for handoff to another agent. Use format='summary' (~500 tokens).",
    "action='list': Discover all plans (active + completed).",
    "Plans persist to disk. If planId is omitted, most recent active plan is used.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["plan", "status", "update", "add", "replan", "checkpoint", "export", "list"], description: "Task action to perform" },
      planId: { type: "string", description: "Target a specific plan by ID (default: most recent active plan)" },
      goal: { type: "string", description: "For 'plan': describe what you're trying to accomplish" },
      tasks: { type: "array", description: "For 'plan'/'add': hierarchical task definitions" },
      id: { type: "string", description: "For 'update'/'checkpoint': task ID to update (e.g., '1', '2.1')" },
      status: { type: "string", enum: ["pending", "in_progress", "completed", "failed", "cancelled", "blocked"], description: "For 'update': new status for the task" },
      notes: { type: "string", description: "For 'update': brief notes about what was done or discovered" },
      summary: { type: "string", description: "For 'checkpoint': narrative summary of milestone progress" },
      parentId: { type: "string", description: "For 'add': parent task ID to insert under (use 'root' for top-level)" },
      after: { type: "string", description: "For 'add': insert after this sibling task ID" },
      cancel: { type: "array", items: { type: "string" }, description: "For 'replan': task IDs to cancel" },
      add: { type: "array", description: "For 'replan': new tasks to add" },
      reason: { type: "string", description: "For 'replan': why the plan changed (required — recorded in audit trail)" },
      format: { type: "string", enum: ["summary", "full"], description: "For 'export': 'summary' = compact ~500 tokens (default), 'full' = complete plan JSON" },
    },
    required: ["action"],
  },
  category: "workflow",
};

// ── Exported Metadata Map ────────────────────────────────────────────────────

/**
 * All tool metadata keyed by tool ID.
 *
 * @example
 * ```ts
 * import { toolMetadata } from '@jaksm/dev-tools/tools'
 *
 * // Register all tools with your framework
 * for (const meta of Object.values(toolMetadata)) {
 *   agent.registerTool({
 *     name: meta.id,
 *     description: meta.description,
 *     parameters: meta.parameters,
 *     execute: (params) => myToolExecutor(meta.id, params),
 *   })
 * }
 * ```
 */
export const toolMetadata = {
  file_read,
  file_write,
  file_edit,
  shell,
  grep,
  glob: glob_tool,
  ls,
  git,
  test,
  code_outline,
  code_read,
  code_search,
  code_inspect,
  code_diagnose,
  code_refactor,
  task,
} as const satisfies Record<string, ToolMetadataEntry>;

/** Array of all tool metadata entries. */
export const allToolMetadata: readonly ToolMetadataEntry[] = Object.values(toolMetadata);

/** Tool IDs as a union type. */
export type ToolId = keyof typeof toolMetadata;
