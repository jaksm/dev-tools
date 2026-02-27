/**
 * dev-tools — OpenClaw Plugin Adapter (thin boundary layer)
 * 
 * Maps OpenClaw's OpenClawPluginApi → DevToolsCore interfaces.
 * Zero business logic here — everything is in src/core/.
 */

import path from "node:path";
import { Type } from "@sinclair/typebox";
import { DevToolsCore } from "./core/index.js";
import { fileRead, type FileReadParams } from "./tools/file-read.js";
import { fileWrite, type FileWriteParams } from "./tools/file-write.js";
import { fileEdit, type FileEditParams } from "./tools/file-edit.js";
import { shell, type ShellParams } from "./tools/shell.js";
import { grep, type GrepParams } from "./tools/grep.js";
import { glob, type GlobParams } from "./tools/glob.js";
import { ls, type LsParams } from "./tools/ls.js";
import { codeOutline, type CodeOutlineParams } from "./tools/code-outline.js";
import { codeRead, type CodeReadParams } from "./tools/code-read.js";
import { codeSearch, type CodeSearchParams } from "./tools/code-search.js";
import { codeInspect, type CodeInspectParams } from "./tools/code-inspect.js";
import { codeDiagnose, type CodeDiagnoseParams } from "./tools/code-diagnose.js";
import { codeRefactor, type CodeRefactorParams } from "./tools/code-refactor.js";
import { task as taskTool, type TaskParams } from "./tools/task.js";
import { git as gitTool, type GitParams } from "./tools/git.js";
import { test as testTool, type TestParams } from "./tools/test.js";
import { handleSetup, handleInit } from "./core/commands.js";
import { resolveConfig, validateConfig } from "./core/config.js";

// OpenClaw plugin types — we define our own minimal interfaces to avoid
// depending on OC's internal paths. The adapter layer maps at runtime.

interface OpenClawPluginApi {
  id: string;
  name: string;
  logger: { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
  pluginConfig?: Record<string, unknown>;
  registerTool: (factory: (ctx: OpenClawPluginToolContext) => AnyAgentTool[] | AnyAgentTool | null | undefined, opts?: Record<string, unknown>) => void;
  on: (hookName: string, handler: (...args: unknown[]) => unknown, opts?: Record<string, unknown>) => void;
  registerCommand?: (command: { name: string; description: string; handler: (ctx: { args: string[]; workspaceDir?: string }) => Promise<unknown> | unknown }) => void;
}

interface OpenClawPluginToolContext {
  workspaceDir?: string;
  agentId?: string;
  sessionKey?: string;
}

interface AnyAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

// ── Tool Definition Helper ──────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

function createTool(
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  execute: (params: Record<string, unknown>) => Promise<unknown>,
): AnyAgentTool {
  return {
    name,
    label,
    description,
    parameters: parameters as AnyAgentTool["parameters"],
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = await execute(params);
      return jsonResult(result);
    },
  } as AnyAgentTool;
}

// ── Plugin Registration ─────────────────────────────────────────────────────

export default function register(api: OpenClawPluginApi) {
  const config = resolveConfig(api.pluginConfig);
  const configWarnings = validateConfig(config);
  if (configWarnings.length > 0) {
    for (const w of configWarnings) {
      api.logger.warn(`[dev-tools config] ${w}`);
    }
  }

  const core = new DevToolsCore({
    config: config as unknown as Record<string, unknown>,
    logger: api.logger,
  });

  // Register tools via factory — runs per session
  api.registerTool((ctx: OpenClawPluginToolContext) => {
    const agentWorkspace = ctx.workspaceDir;
    if (!agentWorkspace) {
      api.logger.warn("[dev-tools] No workspaceDir available — skipping tool registration");
      return null;
    }

    // Tools use a dynamic project root that can be changed via `dev-tools init <path>`.
    // By default, falls back to the agent workspace for backward compatibility.
    const tools = buildTools(core, agentWorkspace);
    return tools;
  });

  // ── Lifecycle Hooks ───────────────────────────────────────────────────────

  // Resolve agent workspace from gateway config — lifecycle hooks don't receive workspaceDir
  const gwConfig = (api as unknown as { config?: Record<string, unknown> }).config;
  const agentsDefaults = (gwConfig?.agents as Record<string, unknown>)?.defaults as Record<string, unknown> | undefined;
  const agentWorkspaceFromConfig = (agentsDefaults?.workspace as string) ?? undefined;

  api.logger.info(`[dev-tools] Agent workspace: ${agentWorkspaceFromConfig ?? "NOT FOUND"}, projectRoots: ${JSON.stringify(config.projectRoots)}`);

  // ── Auto-activation ──────────────────────────────────────────────────────
  // Moved from session_start (which only fires for brand-new sessions) to a
  // one-time lazy init that triggers on the first before_prompt_build. This
  // ensures activation works even when sessions are resumed after a gateway
  // restart (the common case).
  let activated = false;

  async function ensureProjectActivated(): Promise<string | undefined> {
    const agentWorkspace = agentWorkspaceFromConfig;
    if (!agentWorkspace) return undefined;

    // Already activated in-memory?
    if (activated && core.hasActiveProject(agentWorkspace)) {
      return core.getActiveProject(agentWorkspace);
    }

    // Priority: 1) registry match, 2) config projectRoots, 3) agent workspace fallback
    let projectDir = await core.tryAutoActivate(agentWorkspace);
    if (!projectDir) {
      const configRoots = core.getConfig().projectRoots;
      if (configRoots?.length) {
        const fsModule = await import("node:fs/promises");
        const pathModule = await import("node:path");
        for (const root of configRoots) {
          const resolved = root.startsWith("~")
            ? pathModule.default.join(process.env.HOME || "", root.slice(1))
            : pathModule.default.resolve(root);
          try {
            await fsModule.default.access(resolved);
            core.setActiveProject(agentWorkspace, resolved);
            api.logger.info(`[dev-tools] Auto-activated project from config: ${resolved}`);
            projectDir = resolved;
            break;
          } catch {
            // Path doesn't exist — try next
          }
        }
      }
    }
    if (!projectDir) projectDir = core.getActiveProject(agentWorkspace);

    if (!activated && projectDir) {
      await core.analyzeWorkspace(projectDir);
      await core.onSessionStart(projectDir, "auto-activate");
      activated = true;
      api.logger.info(`[dev-tools] Project activated: ${projectDir}`);
    }

    return projectDir;
  }

  api.on("session_start", async () => {
    // Ensure activation on new sessions too
    await ensureProjectActivated();
  });

  api.on("session_end", async (...args: unknown[]) => {
    const hookCtx = (args[0] ?? {}) as { sessionId?: string };
    await core.onSessionEnd(hookCtx.sessionId ?? "unknown");
  });

  api.on("before_prompt_build", async (..._args: unknown[]) => {
    if (!agentWorkspaceFromConfig) return undefined;

    // Ensure project is activated (one-time lazy init after gateway restart)
    await ensureProjectActivated();

    const projectDir = core.getActiveProject(agentWorkspaceFromConfig);
    const status = core.getWorkspaceStatus(projectDir);
    if (status) {
      return { prependContext: status };
    }
    return undefined;
  });

  // ── Slash Command ────────────────────────────────────────────────────────

  if (api.registerCommand) {
    api.registerCommand({
      name: "dev-tools",
      description: "Dev-tools status, setup, and management. Usage: /dev-tools [setup|init <path>|status]",
      handler: async (ctx) => {
        const subcommand = ctx.args[0] ?? "status";
        const config = (api.pluginConfig ?? {}) as import("./core/types.js").DevToolsConfig;

        if (subcommand === "setup") {
          return handleSetup(config, api.logger, ctx.workspaceDir);
        }

        if (subcommand === "init") {
          // Accept a project path argument: /dev-tools init /path/to/project
          // Falls back to agent workspace if no path given (backward compatible)
          const targetPath = ctx.args[1]
            ? path.resolve(ctx.args[1])
            : ctx.workspaceDir;

          if (!targetPath) {
            return { success: false, error: "No path specified. Usage: /dev-tools init <project-path>" };
          }

          const result = await handleInit(config, api.logger, targetPath);

          // Set as active project for this agent workspace
          if (result.success && ctx.workspaceDir) {
            core.setActiveProject(ctx.workspaceDir, targetPath);
            // Trigger workspace analysis so tools have full context
            await core.analyzeWorkspace(targetPath);
            await core.onSessionStart(targetPath, "init");
          }

          return {
            ...result,
            activeProject: targetPath,
            agentWorkspace: ctx.workspaceDir,
          };
        }

        // Default: status
        if (!ctx.workspaceDir) {
          return { status: "no workspace", message: "No workspace directory available." };
        }
        const projectDir = core.getActiveProject(ctx.workspaceDir);
        return {
          status: "active",
          agentWorkspace: ctx.workspaceDir,
          activeProject: projectDir,
          projectIsExplicit: core.hasActiveProject(ctx.workspaceDir),
          workspaceStatus: core.getWorkspaceStatus(projectDir),
        };
      },
    });
  }

  // ── Tool Call Logging ─────────────────────────────────────────────────────

  api.on("after_tool_call", (...args: unknown[]) => {
    const event = (args[0] ?? {}) as { toolName: string; params: Record<string, unknown>; result?: unknown; error?: string; durationMs?: number };
    const hookCtx = (args[1] ?? {}) as { workspaceDir?: string };
    const ourTools = [
      "file_read", "file_write", "file_edit", "shell", "grep", "glob", "ls",
      "code_outline", "code_read", "code_search", "code_inspect", "code_diagnose", "code_refactor",
      "task", "git", "test",
    ];
    if (!ourTools.includes(event.toolName)) return;

    // Log against the active project dir, not agent workspace
    const logDir = hookCtx.workspaceDir
      ? core.getActiveProject(hookCtx.workspaceDir)
      : undefined;

    core.logToolCall({
      toolName: event.toolName,
      params: event.params,
      result: event.result,
      error: event.error,
      durationMs: event.durationMs,
    }, logDir);
  });
}

// ── Build Tools (Foundation + Intelligence) ─────────────────────────────────

function buildTools(
  core: DevToolsCore,
  agentWorkspace: string,
): AnyAgentTool[] {
  // Dynamic project root resolver — returns the active project dir (or agent workspace as fallback).
  // This is called at tool execution time, so it picks up changes from `dev-tools init`.
  function getProjectDir(): string {
    return core.getActiveProject(agentWorkspace);
  }

  // Lazy workspace resolver — tools get the workspace at call time
  async function getToolContext(): Promise<import("./core/types.js").ToolContext> {
    const projectDir = getProjectDir();
    let workspace = await core.analyzeWorkspace(projectDir);
    if (!workspace) {
      // Fallback minimal workspace
      workspace = {
        root: projectDir,
        hasGit: false,
        languages: [],
        testRunners: [],
        gitignoreFilter: () => false,
      };
    }
    return core.createToolContext(projectDir, workspace);
  }

  return [
    // ── file_read ─────────────────────────────────────────────────────────
    createTool(
      "file_read",
      "Read File",
      [
        "Read the contents of a file with line numbers.",
        "Use this to examine source code, configuration files, or any text file in the project.",
        "Automatically detects binary files and suggests similar filenames when the path is wrong.",
        "For large files, use offset and limit to paginate — the response shows total line count so you know how much remains.",
        "Prefer this over shell(cat) because it gives structured output with line numbers and handles edge cases.",
      ].join("\n"),
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root (e.g., 'src/index.ts', 'package.json')" }),
        offset: Type.Optional(Type.Number({ description: "Start reading from this line number (1-indexed). Use with limit for pagination." })),
        limit: Type.Optional(Type.Number({ description: "Maximum number of lines to return. Omit to read the entire file." })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        return fileRead(params as unknown as FileReadParams, ctx);
      },
    ),

    // ── file_write ────────────────────────────────────────────────────────
    createTool(
      "file_write",
      "Write File",
      [
        "Create a new file or overwrite an existing file with the provided content.",
        "Automatically creates parent directories if they don't exist.",
        "Use this for creating new files. For modifying existing files, prefer file_edit — it's safer and preserves unmodified content.",
        "Returns whether the file was created (new) or overwritten (existing), and the byte count.",
      ].join("\n"),
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root (e.g., 'src/utils/helpers.ts')" }),
        content: Type.String({ description: "Complete file content to write" }),
      }),
      async (params) => {
        const ctx = await getToolContext();
        return fileWrite(params as unknown as FileWriteParams, ctx);
      },
    ),

    // ── file_edit ─────────────────────────────────────────────────────────
    createTool(
      "file_edit",
      "Edit File",
      [
        "Make targeted edits to an existing file using search-and-replace.",
        "This is the primary tool for modifying code. Provide one or more edits, each with oldText (the exact text to find) and newText (the replacement).",
        "Matching is flexible: if an exact match fails, it tries whitespace normalization, indentation flexibility, and other strategies — so small formatting differences won't cause failures.",
        "When oldText matches multiple locations, the edit fails and reports all match locations — use lineHint to disambiguate.",
        "Multiple edits in one call are applied sequentially to the same file. Batch related changes together.",
        "After edits, returns LSP diagnostics if available — check these for introduced errors.",
        "IMPORTANT: oldText must appear in the file. Always read the file first if you're unsure of the exact content.",
      ].join("\n"),
      Type.Object({
        path: Type.String({ description: "File path relative to workspace root" }),
        edits: Type.Array(
          Type.Object({
            oldText: Type.String({ description: "Text to find in the file. Must match existing content (whitespace-flexible). Include enough surrounding context to be unique." }),
            newText: Type.String({ description: "Replacement text. Can be empty string to delete content." }),
            lineHint: Type.Optional(Type.Number({ description: "Approximate line number to resolve ambiguity when oldText appears multiple times" })),
          }),
          { description: "One or more edit operations, applied in order" },
        ),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const lspManager = core.getLspManager(getProjectDir());
        return fileEdit(params as unknown as FileEditParams, ctx, { lspManager });
      },
    ),

    // ── shell ─────────────────────────────────────────────────────────────
    createTool(
      "shell",
      "Run Shell Command",
      [
        "Execute a shell command in the project directory.",
        "Use this for: installing dependencies, running build scripts, executing one-off commands, or any operation not covered by specialized tools.",
        "Do NOT use for: reading files (use file_read), searching code (use grep/code_search), running tests (use test), or git operations (use git).",
        "Interactive commands (vim, python REPL, etc.) are blocked — only non-interactive commands are allowed.",
        "Dangerous patterns (rm -rf /, curl|bash, etc.) are blocked for safety.",
        "Default timeout is 120 seconds. Set background=true for long-running processes like servers.",
        "Output is returned as stdout/stderr with exit code.",
      ].join("\n"),
      Type.Object({
        command: Type.String({ description: "Shell command to execute (e.g., 'npm install', 'make build')" }),
        cwd: Type.Optional(Type.String({ description: "Working directory relative to workspace root (default: workspace root)" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 120000). Increase for slow builds." })),
        background: Type.Optional(Type.Boolean({ description: "If true, start the process and return immediately without waiting for completion" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const result = await shell(params as unknown as ShellParams, ctx);
        // Notify LSP manager that a shell command ran (invalidates prereq cache)
        core.notifyShellCommand(getProjectDir());
        return result;
      },
    ),

    // ── grep ──────────────────────────────────────────────────────────────
    createTool(
      "grep",
      "Search File Contents",
      [
        "Search across files using regex patterns. Powered by ripgrep, respects .gitignore.",
        "Use this when you know the exact text or pattern you're looking for — function names, error messages, import statements, string literals, TODOs.",
        "Prefer code_search for conceptual queries (e.g., 'authentication logic') where you don't know the exact text.",
        "Three output modes: 'content' (matching lines with context — default), 'files' (just file paths), 'count' (match counts per file).",
        "Use glob to filter by file type: e.g., glob='*.ts' for TypeScript only, glob='*.test.*' for test files.",
        "Results are capped at 100 matches. Narrow your search with path and glob if you get too many.",
      ].join("\n"),
      Type.Object({
        pattern: Type.String({ description: "Search pattern (regex by default). Examples: 'TODO', 'function\\s+\\w+', 'import.*from'" }),
        path: Type.Optional(Type.String({ description: "Directory to search in, relative to workspace root (default: entire workspace)" })),
        glob: Type.Optional(Type.String({ description: "File glob filter (e.g., '*.ts', '*.{js,jsx}', '!*.test.*')" })),
        mode: Type.Optional(Type.Union([
          Type.Literal("content"),
          Type.Literal("files"),
          Type.Literal("count"),
        ], { description: "'content' = matching lines with context (default), 'files' = just paths, 'count' = match counts" })),
        caseInsensitive: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
        multiline: Type.Optional(Type.Boolean({ description: "Enable multiline matching for patterns that span multiple lines" })),
        contextLines: Type.Optional(Type.Number({ description: "Lines of context to show around each match (default: 2)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        return grep(params as unknown as GrepParams, ctx);
      },
    ),

    // ── glob ──────────────────────────────────────────────────────────────
    createTool(
      "glob",
      "Find Files by Pattern",
      [
        "Find files matching a glob pattern. Respects .gitignore.",
        "Use this to discover project structure: find all test files, config files, or files matching a naming pattern.",
        "Returns path, size, and modification time for each match, sorted by most recently modified.",
        "For browsing directory structure, prefer ls. For searching file contents, prefer grep.",
        "Examples: '**/*.test.ts', 'src/**/*.css', '**/{Dockerfile,docker-compose*}', '**/README*'",
      ].join("\n"),
      Type.Object({
        pattern: Type.String({ description: "Glob pattern (e.g., '**/*.test.ts', 'src/**/*.css')" }),
        path: Type.Optional(Type.String({ description: "Base directory to search from (relative to workspace root, default: workspace root)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        return glob(params as unknown as GlobParams, ctx);
      },
    ),

    // ── ls ────────────────────────────────────────────────────────────────
    createTool(
      "ls",
      "List Directory",
      [
        "List contents of a directory as a tree structure.",
        "Shows file sizes and child counts for subdirectories. Respects .gitignore.",
        "Use this first when exploring an unfamiliar project — it gives you the lay of the land.",
        "Default depth is 2 levels. Increase depth to see deeper, but be mindful of large projects.",
        "For finding specific files by pattern, prefer glob. For searching file contents, prefer grep.",
      ].join("\n"),
      Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path relative to workspace root (default: workspace root)" })),
        depth: Type.Optional(Type.Number({ description: "How many levels deep to recurse (default: 2)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        return ls(params as unknown as LsParams, ctx);
      },
    ),

    // ── code_outline ──────────────────────────────────────────────────────
    createTool(
      "code_outline",
      "Code Outline",
      [
        "Get the structure of a file or directory — classes, functions, methods, interfaces, types, and their relationships.",
        "For a file: returns a hierarchical tree (e.g., class → methods → nested classes) with signatures, line numbers, and exports.",
        "For a directory: returns a flat summary of top-level symbols per file — useful to understand a module's public API at a glance.",
        "Use this before reading code to understand what's in a file, or to find the right symbol name for code_read or code_inspect.",
        "Much faster than reading an entire file — gives you the map, then use code_read to zoom into specific symbols.",
      ].join("\n"),
      Type.Object({
        path: Type.String({ description: "File or directory path relative to workspace root (e.g., 'src/auth/', 'src/services/user.ts')" }),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        return codeOutline(params as unknown as CodeOutlineParams, ctx, symbolIndex);
      },
    ),

    // ── code_read ─────────────────────────────────────────────────────────
    createTool(
      "code_read",
      "Read Symbol",
      [
        "Read the source code of a specific symbol (function, class, method) by name.",
        "Prefer this over file_read when you know the symbol name — it extracts exactly the code you need without reading the entire file.",
        "Automatically includes the file's import statements so you understand dependencies.",
        "Symbol resolution: 'UserService' finds the class, 'UserService.authenticate' finds the method. Use file hint to disambiguate if the name exists in multiple files.",
        "Context modes add surrounding information: 'siblings' = signatures of adjacent functions, 'class' = full class outline with target method expanded, 'dependencies' = symbols referenced by this code.",
      ].join("\n"),
      Type.Object({
        symbol: Type.String({ description: "Symbol name — simple ('authenticate') or qualified ('UserService.authenticate')" }),
        file: Type.Optional(Type.String({ description: "File path hint if the symbol name is ambiguous across files" })),
        scope: Type.Optional(Type.String({ description: "Scope hint — e.g., class name to find a method: scope='UserService', symbol='authenticate'" })),
        context: Type.Optional(Type.Union([
          Type.Literal("siblings"),
          Type.Literal("class"),
          Type.Literal("dependencies"),
        ], { description: "'siblings' = adjacent function signatures, 'class' = class outline with target expanded, 'dependencies' = referenced symbols" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        return codeRead(params as unknown as CodeReadParams, ctx, symbolIndex);
      },
    ),

    // ── code_search ───────────────────────────────────────────────────────
    createTool(
      "code_search",
      "Search Code Semantically",
      [
        "Search the codebase by meaning, not just text. Uses embeddings to find code that matches your intent.",
        "Use this when you don't know the exact name — describe what the code does: 'user authentication', 'parse JSON response', 'database connection pool'.",
        "Prefer grep when you know the exact text (function name, variable, string literal).",
        "Actions: 'search' (default — semantic or text search), 'stats' (workspace index statistics — call this first to understand the codebase), 'index' (browse the full symbol index with optional path filter).",
        "Semantic mode is default. Falls back to text (ripgrep) during initial indexing or when explicitly set with mode='text'.",
        "Use scope to limit results to a directory (e.g., scope='src/auth' to search only auth module).",
      ].join("\n"),
      Type.Object({
        action: Type.Optional(Type.Union([
          Type.Literal("search"),
          Type.Literal("stats"),
          Type.Literal("index"),
        ], { description: "'search' = find code (default), 'stats' = index statistics, 'index' = browse full symbol index" })),
        query: Type.Optional(Type.String({ description: "Natural language description of what you're looking for (e.g., 'error handling middleware', 'database migrations')" })),
        mode: Type.Optional(Type.Union([
          Type.Literal("semantic"),
          Type.Literal("text"),
        ], { description: "'semantic' = embedding-based (default), 'text' = ripgrep-backed text search" })),
        scope: Type.Optional(Type.String({ description: "Limit search to a directory (relative path, e.g., 'src/auth')" })),
        limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10)" })),
        filter: Type.Optional(Type.String({ description: "For action='index': glob filter (e.g., 'src/auth/**')" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        const embeddingIndexer = core.getEmbeddingIndexer(getProjectDir());
        return codeSearch(params as unknown as CodeSearchParams, ctx, symbolIndex, embeddingIndexer);
      },
    ),

    // ── code_inspect ──────────────────────────────────────────────────────
    createTool(
      "code_inspect",
      "Inspect Symbol",
      [
        "Get complete information about a symbol: its type signature, where it's defined, and every place it's used.",
        "Combines type info (hover), definition location, and all references in one call — no need to call three separate tools.",
        "Uses LSP for precise, compiler-accurate results. Falls back to symbol index analysis when LSP is unavailable.",
        "Use this when you need to understand a symbol's contract (type, parameters, return value), trace its usage across the codebase, or verify a rename is safe.",
        "Set includeReferences=false for faster results when you only need type info and definition location.",
      ].join("\n"),
      Type.Object({
        symbol: Type.String({ description: "Symbol name — simple ('authenticate') or qualified ('UserService.authenticate')" }),
        file: Type.Optional(Type.String({ description: "File path hint to disambiguate if name exists in multiple files" })),
        scope: Type.Optional(Type.String({ description: "Scope hint (e.g., class name)" })),
        line: Type.Optional(Type.Number({ description: "Line number hint for precise resolution (1-indexed)" })),
        includeReferences: Type.Optional(Type.Boolean({ description: "Include all references across the codebase (default: true). Set false for speed." })),
        maxReferences: Type.Optional(Type.Number({ description: "Maximum references to return (default: 20)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        const lspManager = core.getLspManager(getProjectDir());
        const lspResolver = core.getLspResolver(getProjectDir());
        return codeInspect(params as unknown as CodeInspectParams, ctx, symbolIndex, lspManager, lspResolver);
      },
    ),

    // ── code_diagnose ─────────────────────────────────────────────────────
    createTool(
      "code_diagnose",
      "Diagnose Code Issues",
      [
        "Get compiler errors, warnings, and suggested fixes from the language server.",
        "Use action='diagnostics' (default) after making changes to verify your edits didn't break anything.",
        "Use action='health' to check the status of all code intelligence engines (tree-sitter, embeddings, LSP).",
        "Use action='reload' if LSP seems stuck — it restarts all language servers and clears cached diagnostics.",
        "Filter by file, directory, or monorepo root. Severity filter defaults to 'warning' (shows errors + warnings).",
        "Each diagnostic includes location, message, severity, and available quick-fixes that can be applied with code_refactor.",
      ].join("\n"),
      Type.Object({
        action: Type.Optional(Type.Union([
          Type.Literal("diagnostics"),
          Type.Literal("health"),
          Type.Literal("lsp_status"),
          Type.Literal("reload"),
        ], { description: "'diagnostics' = errors/warnings (default), 'health' = engine status, 'lsp_status' = per-server debug info, 'reload' = restart LSP" })),
        file: Type.Optional(Type.String({ description: "Show diagnostics only for this file (relative to workspace)" })),
        directory: Type.Optional(Type.String({ description: "Show diagnostics only for files in this directory" })),
        root: Type.Optional(Type.String({ description: "Filter by monorepo language root (e.g., 'packages/backend')" })),
        severity: Type.Optional(Type.Union([
          Type.Literal("error"),
          Type.Literal("warning"),
          Type.Literal("info"),
          Type.Literal("hint"),
          Type.Literal("all"),
        ], { description: "Minimum severity to show (default: 'warning' = errors + warnings)" })),
        limit: Type.Optional(Type.Number({ description: "Max diagnostics to return (default: 50)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        const lspManager = core.getLspManager(getProjectDir());
        const embeddingIndexer = core.getEmbeddingIndexer(getProjectDir());
        return codeDiagnose(params as unknown as CodeDiagnoseParams, ctx, symbolIndex, lspManager, embeddingIndexer);
      },
    ),

    // ── code_refactor ─────────────────────────────────────────────────────
    createTool(
      "code_refactor",
      "Refactor Code",
      [
        "Perform automated refactoring operations powered by the language server.",
        "action='rename': Rename a symbol across the entire workspace — all references, imports, and type usages updated automatically. Safer than find-and-replace.",
        "action='organize_imports': Clean up imports in a file — remove unused, sort, group.",
        "action='apply_fix': Apply a quick-fix suggested by code_diagnose (e.g., add missing import, fix type error). Reference the fix by file and line number from the diagnostics output.",
        "All actions apply changes to the filesystem directly and report which files were modified.",
      ].join("\n"),
      Type.Object({
        action: Type.Union([
          Type.Literal("rename"),
          Type.Literal("organize_imports"),
          Type.Literal("apply_fix"),
        ], { description: "Refactoring action to perform" }),
        symbol: Type.Optional(Type.String({ description: "For 'rename': the symbol to rename (e.g., 'UserService', 'authenticate')" })),
        file: Type.Optional(Type.String({ description: "For 'rename': file path hint to locate the symbol" })),
        scope: Type.Optional(Type.String({ description: "For 'rename': scope hint (e.g., class name)" })),
        newName: Type.Optional(Type.String({ description: "For 'rename': the new name for the symbol" })),
        path: Type.Optional(Type.String({ description: "For 'organize_imports': the file to organize" })),
        fixFile: Type.Optional(Type.String({ description: "For 'apply_fix': file containing the diagnostic (from code_diagnose output)" })),
        fixLine: Type.Optional(Type.Number({ description: "For 'apply_fix': line number of the diagnostic (1-indexed)" })),
        fixIndex: Type.Optional(Type.Number({ description: "For 'apply_fix': which fix to apply if multiple diagnostics on the same line (default: 0)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const symbolIndex = core.getSymbolIndex(getProjectDir());
        const lspManager = core.getLspManager(getProjectDir());
        const lspResolver = core.getLspResolver(getProjectDir());
        const onFilesChanged = async (files: string[]) => {
          await core.reindexFiles(getProjectDir(), files);
        };
        return codeRefactor(params as unknown as CodeRefactorParams, ctx, symbolIndex, lspManager, lspResolver, onFilesChanged);
      },
    ),

    // ── task ───────────────────────────────────────────────────────────────
    createTool(
      "task",
      "Task Planner",
      [
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
      Type.Object({
        action: Type.Union([
          Type.Literal("plan"),
          Type.Literal("status"),
          Type.Literal("update"),
          Type.Literal("add"),
          Type.Literal("replan"),
          Type.Literal("checkpoint"),
          Type.Literal("export"),
          Type.Literal("list"),
        ], { description: "Task action to perform" }),
        goal: Type.Optional(Type.String({ description: "For 'plan': describe what you're trying to accomplish" })),
        tasks: Type.Optional(Type.Array(
          Type.Object({
            id: Type.Optional(Type.String({ description: "Hierarchical ID (e.g., '1', '1.1', '1.1.1'). Auto-generated if omitted." })),
            title: Type.String({ description: "Task title — concise, actionable (e.g., 'Add input validation to signup form')" }),
            checkpoint: Type.Optional(Type.Boolean({ description: "If true, triggers a checkpoint prompt when all subtasks complete" })),
            subtasks: Type.Optional(Type.Array(Type.Any(), { description: "Nested subtask definitions" })),
          }),
          { description: "For 'plan'/'add': hierarchical task definitions" },
        )),
        id: Type.Optional(Type.String({ description: "For 'update'/'checkpoint': task ID to update (e.g., '1', '2.1')" })),
        status: Type.Optional(Type.Union([
          Type.Literal("pending"),
          Type.Literal("in_progress"),
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("cancelled"),
          Type.Literal("blocked"),
        ], { description: "For 'update': new status for the task" })),
        notes: Type.Optional(Type.String({ description: "For 'update': brief notes about what was done or discovered" })),
        context: Type.Optional(Type.Object({
          findings: Type.Optional(Type.Array(Type.String(), { description: "Key discoveries (e.g., 'API requires auth header', 'Config stored in .env')" })),
          decisions: Type.Optional(Type.Array(Type.String(), { description: "Decisions made and reasoning (e.g., 'Used bcrypt over argon2 — better Node.js support')" })),
          files: Type.Optional(Type.Array(Type.String(), { description: "Files created, modified, or relevant to this task" })),
        }, { description: "For 'update': structured context that persists across the plan" })),
        planId: Type.Optional(Type.String({ description: "Target a specific plan by ID (default: most recent active plan)" })),
        parentId: Type.Optional(Type.String({ description: "For 'add': parent task ID to insert under (use 'root' for top-level)" })),
        after: Type.Optional(Type.String({ description: "For 'add': insert after this sibling task ID" })),
        reason: Type.Optional(Type.String({ description: "For 'replan': why the plan changed (required — recorded in audit trail)" })),
        cancel: Type.Optional(Type.Array(Type.String(), { description: "For 'replan': task IDs to cancel" })),
        add: Type.Optional(Type.Array(Type.Object({
          id: Type.Optional(Type.String()),
          title: Type.String(),
          parentId: Type.Optional(Type.String({ description: "Parent task ID to insert under (default: root)" })),
          checkpoint: Type.Optional(Type.Boolean()),
          subtasks: Type.Optional(Type.Array(Type.Any())),
        }), { description: "For 'replan': new tasks to add" })),
        summary: Type.Optional(Type.String({ description: "For 'checkpoint': narrative summary of milestone progress" })),
        format: Type.Optional(Type.Union([
          Type.Literal("summary"),
          Type.Literal("full"),
        ], { description: "For 'export': 'summary' = compact ~500 tokens (default), 'full' = complete plan JSON" })),
      }),
      async (params) => {
        const taskStorage = core.getTaskStorage(getProjectDir());
        return taskTool(params as unknown as TaskParams, taskStorage);
      },
    ),

    // ── git ────────────────────────────────────────────────────────────────
    createTool(
      "git",
      "Git Operations",
      [
        "Perform git operations with structured JSON output — no parsing raw git output needed.",
        "action='status': Get staged, unstaged, and untracked files as structured arrays. Check this before committing.",
        "action='diff': View changes with structured hunks, insertions, and deletions per file. Use staged=true for staged changes.",
        "action='commit': Stage files and commit. Provide files to auto-stage, or commit already-staged changes.",
        "action='log': View commit history with hash, message, author, date, and changed files. Filter by author, date, or path.",
        "action='branch': List branches with current branch highlighted. Shows last commit info for each branch.",
        "For complex git operations (rebase, cherry-pick, stash), use the shell tool directly.",
      ].join("\n"),
      Type.Object({
        action: Type.Union([
          Type.Literal("status"),
          Type.Literal("diff"),
          Type.Literal("commit"),
          Type.Literal("log"),
          Type.Literal("branch"),
        ], { description: "Git operation to perform" }),
        message: Type.Optional(Type.String({ description: "For 'commit': commit message" })),
        files: Type.Optional(Type.Array(Type.String(), { description: "For 'commit': files to stage before committing (relative paths)" })),
        staged: Type.Optional(Type.Boolean({ description: "For 'diff': show staged changes instead of unstaged (default: false)" })),
        file: Type.Optional(Type.String({ description: "For 'diff': show changes for a single file only" })),
        limit: Type.Optional(Type.Number({ description: "For 'log': max commits to return (default: 10)" })),
        author: Type.Optional(Type.String({ description: "For 'log': filter by author name or email" })),
        since: Type.Optional(Type.String({ description: "For 'log': show commits after date (e.g., '2 days ago', '2024-01-15')" })),
        path: Type.Optional(Type.String({ description: "For 'log': show commits that modified this path" })),
      }),
      async (params) => {
        return gitTool(params as unknown as GitParams, getProjectDir());
      },
    ),

    // ── test ───────────────────────────────────────────────────────────────
    createTool(
      "test",
      "Run Tests",
      [
        "Run the project's test suite and get structured results — pass/fail counts, durations, and detailed failure information.",
        "Auto-detects the test framework: Jest, Vitest, pytest, cargo test, swift test, or go test.",
        "Each failure includes: test name, suite, file, line number, error message, and stack trace — everything you need to diagnose and fix.",
        "Run without arguments to execute the full test suite. Use file to run a specific test file, or name to filter by test name.",
        "Always run tests after making changes to verify nothing broke. Parse the structured failures to fix issues systematically.",
        "Default timeout is 5 minutes. Increase for large test suites.",
      ].join("\n"),
      Type.Object({
        file: Type.Optional(Type.String({ description: "Run only tests in this file (relative to workspace root)" })),
        suite: Type.Optional(Type.String({ description: "Filter by test suite / describe block name" })),
        name: Type.Optional(Type.String({ description: "Filter by test name pattern (e.g., 'auth', 'should validate')" })),
        timeout: Type.Optional(Type.Number({ description: "Timeout in milliseconds (default: 300000 = 5 minutes)" })),
      }),
      async (params) => {
        const ctx = await getToolContext();
        const runners = ctx.workspace.testRunners;
        if (runners.length === 0) {
          return {
            success: false,
            error: "No supported test runner detected. Supported: Jest, Vitest, pytest, cargo test, swift test, go test. Use shell tool to run tests manually.",
          };
        }
        // Use the first detected runner (or match by file if multiple)
        let runner = runners[0];
        if (params.file && runners.length > 1) {
          const filePath = path.resolve(getProjectDir(), params.file as string);
          const matched = runners.find(r => filePath.startsWith(r.root));
          if (matched) runner = matched;
        }
        return testTool(params as unknown as TestParams, runner, getProjectDir());
      },
    ),
  ];
}
