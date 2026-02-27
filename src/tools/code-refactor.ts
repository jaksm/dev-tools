/**
 * code_refactor tool — automated code refactoring via LSP.
 *
 * Actions:
 * - "rename": Rename a symbol across the entire workspace
 * - "organize_imports": Clean up imports in a file
 * - "apply_fix": Apply a specific code action/fix from code_diagnose output
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  WorkspaceEdit,
  TextEdit,
  TextDocumentEdit,
  CreateFile,
  RenameFile,
  DeleteFile,
  CodeAction,
} from "vscode-languageserver-protocol";
import type { ToolContext, ToolResult } from "../core/types.js";
import type { LspManager, ClientUnavailableReason } from "../core/lsp/manager.js";
import type { LspResolver } from "../core/lsp/resolver.js";
import type { SymbolIndex } from "../core/index/symbol-index.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface CodeRefactorParams {
  action: "rename" | "organize_imports" | "apply_fix";
  /** For rename: symbol to rename */
  symbol?: string;
  /** For rename: file hint to disambiguate */
  file?: string;
  /** For rename: scope hint */
  scope?: string;
  /** For rename: new name */
  newName?: string;
  /** For organize_imports: file to organize */
  path?: string;
  /** For apply_fix: diagnostic code or index from code_diagnose output */
  fixIndex?: number;
  /** For apply_fix: file containing the diagnostic */
  fixFile?: string;
  /** For apply_fix: line of the diagnostic */
  fixLine?: number;
}

export interface FileChange {
  file: string;
  type: "modified" | "created" | "renamed" | "deleted";
  edits?: number;
  /** Renamed from (for rename type) */
  from?: string;
}

export interface CodeRefactorResult {
  action: string;
  changes: FileChange[];
  totalEdits: number;
  message: string;
}

// ── Tool Implementation ─────────────────────────────────────────────────────

export async function codeRefactor(
  params: CodeRefactorParams,
  ctx: ToolContext,
  _symbolIndex: SymbolIndex,
  lspManager: LspManager | null,
  lspResolver: LspResolver | null,
): Promise<ToolResult<CodeRefactorResult>> {
  if (!lspManager) {
    return {
      success: false,
      error: "LSP not available. code_refactor requires a running language server. Try code_diagnose { action: 'health' } to check.",
      data: {
        action: params.action,
        changes: [],
        totalEdits: 0,
        message: "LSP not available",
      } as CodeRefactorResult,
    };
  }

  switch (params.action) {
    case "rename":
      return handleRename(params, ctx, lspManager, lspResolver);
    case "organize_imports":
      return handleOrganizeImports(params, ctx, lspManager);
    case "apply_fix":
      return handleApplyFix(params, ctx, lspManager);
    default:
      return {
        success: false,
        error: `Unknown action: ${params.action}. Valid: rename, organize_imports, apply_fix`,
      };
  }
}

// ── Action: rename ──────────────────────────────────────────────────────────

async function handleRename(
  params: CodeRefactorParams,
  ctx: ToolContext,
  lspManager: LspManager,
  lspResolver: LspResolver | null,
): Promise<ToolResult<CodeRefactorResult>> {
  if (!params.symbol) {
    return { success: false, error: "Missing required parameter: symbol" };
  }
  if (!params.newName) {
    return { success: false, error: "Missing required parameter: newName" };
  }
  if (!lspResolver) {
    return { success: false, error: "LSP resolver not available" };
  }

  // Resolve symbol to LSP position
  const posResult = await lspResolver.resolve({
    symbol: params.symbol,
    file: params.file ? resolvePath(params.file, ctx.workspaceDir) : undefined,
    scope: params.scope,
  });

  if (!posResult.position) {
    return {
      success: false,
      error: posResult.error ?? `Could not resolve symbol "${params.symbol}" to a position`,
    };
  }

  if (posResult.ambiguous && !params.file) {
    const locs = posResult.candidates.map(s =>
      `  ${s.qualifiedName} in ${path.relative(ctx.workspaceDir, s.filePath)}:${s.lines[0]}`,
    );
    return {
      success: false,
      error: `Ambiguous symbol "${params.symbol}":\n${locs.join("\n")}\nSpecify file to disambiguate.`,
    };
  }

  const pos = posResult.position;
  const { client, reason } = await lspManager.getClientWithReason(pos.filePath);
  if (!client) {
    const msg = reason ? formatRefactorError(reason) : `No LSP server available for ${pos.filePath}`;
    return { success: false, error: msg };
  }

  await client.ensureDocumentOpen(pos.filePath);

  // Execute rename
  let workspaceEdit: WorkspaceEdit | null;
  try {
    workspaceEdit = await client.rename(
      pos.uri,
      { line: pos.line, character: pos.character },
      params.newName,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `LSP rename failed: ${msg}` };
  }

  if (!workspaceEdit) {
    return { success: false, error: "LSP returned no workspace edit for rename" };
  }

  // Apply the workspace edit
  const changes = await applyWorkspaceEdit(workspaceEdit, ctx.workspaceDir);
  const totalEdits = changes.reduce((sum, c) => sum + (c.edits ?? 0), 0);

  return {
    success: true,
    data: {
      action: "rename",
      changes,
      totalEdits,
      message: `Renamed "${params.symbol}" → "${params.newName}" across ${changes.length} file${changes.length !== 1 ? "s" : ""} (${totalEdits} edit${totalEdits !== 1 ? "s" : ""})`,
    },
    summary: `Renamed → "${params.newName}" in ${changes.length} file${changes.length !== 1 ? "s" : ""} (${totalEdits} edits)`,
  };
}

// ── Action: organize_imports ────────────────────────────────────────────────

async function handleOrganizeImports(
  params: CodeRefactorParams,
  ctx: ToolContext,
  lspManager: LspManager,
): Promise<ToolResult<CodeRefactorResult>> {
  if (!params.path) {
    return { success: false, error: "Missing required parameter: path" };
  }

  const absPath = resolvePath(params.path, ctx.workspaceDir);
  const { client, reason } = await lspManager.getClientWithReason(absPath);
  if (!client) {
    const msg = reason ? formatRefactorError(reason) : `No LSP server available for ${params.path}`;
    return { success: false, error: msg };
  }

  const uri = pathToFileURL(absPath).toString();
  await client.ensureDocumentOpen(absPath);

  // Request code actions of kind "source.organizeImports"
  let codeActions: (CodeAction | { title: string })[] | null;
  try {
    codeActions = await client.codeAction(
      uri,
      { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      [],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `LSP code action request failed: ${msg}` };
  }

  if (!codeActions || codeActions.length === 0) {
    return {
      success: true,
      data: {
        action: "organize_imports",
        changes: [],
        totalEdits: 0,
        message: "No import organization needed.",
      },
      summary: "Imports already organized",
    };
  }

  // Find the organize imports action
  const organizeAction = codeActions.find(a => {
    if ("kind" in a && typeof a.kind === "string") {
      return a.kind === "source.organizeImports";
    }
    return a.title.toLowerCase().includes("organize import");
  }) as CodeAction | undefined;

  if (!organizeAction || !organizeAction.edit) {
    return {
      success: true,
      data: {
        action: "organize_imports",
        changes: [],
        totalEdits: 0,
        message: "No organize imports action available from LSP.",
      },
      summary: "No organize imports action available",
    };
  }

  const changes = await applyWorkspaceEdit(organizeAction.edit, ctx.workspaceDir);
  const totalEdits = changes.reduce((sum, c) => sum + (c.edits ?? 0), 0);

  return {
    success: true,
    data: {
      action: "organize_imports",
      changes,
      totalEdits,
      message: `Organized imports in ${params.path} (${totalEdits} edit${totalEdits !== 1 ? "s" : ""})`,
    },
    summary: `Organized imports (${totalEdits} edits)`,
  };
}

// ── Action: apply_fix ───────────────────────────────────────────────────────

async function handleApplyFix(
  params: CodeRefactorParams,
  ctx: ToolContext,
  lspManager: LspManager,
): Promise<ToolResult<CodeRefactorResult>> {
  if (!params.fixFile) {
    return { success: false, error: "Missing required parameter: fixFile" };
  }
  if (params.fixLine === undefined) {
    return { success: false, error: "Missing required parameter: fixLine" };
  }

  const absPath = resolvePath(params.fixFile, ctx.workspaceDir);
  const { client, reason } = await lspManager.getClientWithReason(absPath);
  if (!client) {
    const msg = reason ? formatRefactorError(reason) : `No LSP server available for ${params.fixFile}`;
    return { success: false, error: msg };
  }

  const uri = pathToFileURL(absPath).toString();
  await client.ensureDocumentOpen(absPath);

  // Get diagnostics at the specified line from our collector
  const collector = lspManager.diagnostics;
  const fileDiagnostics = collector.getForUri(uri);
  const line0 = params.fixLine - 1; // 1-indexed → 0-indexed

  // Find diagnostics at or near this line
  const matchingDiags = fileDiagnostics.filter(d =>
    d.raw.range.start.line === line0 ||
    (d.raw.range.start.line <= line0 && d.raw.range.end.line >= line0),
  );

  if (matchingDiags.length === 0) {
    return {
      success: false,
      error: `No diagnostics found at ${params.fixFile}:${params.fixLine}. Run code_diagnose first.`,
    };
  }

  // Request code actions for the diagnostic range
  const targetDiag = params.fixIndex !== undefined && params.fixIndex < matchingDiags.length
    ? matchingDiags[params.fixIndex]
    : matchingDiags[0];

  let codeActions: (CodeAction | { title: string })[] | null;
  try {
    codeActions = await client.codeAction(
      uri,
      targetDiag.raw.range,
      [targetDiag.raw],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `LSP code action request failed: ${msg}` };
  }

  if (!codeActions || codeActions.length === 0) {
    return {
      success: false,
      error: `No fixes available for diagnostic at ${params.fixFile}:${params.fixLine}: "${targetDiag.message}"`,
    };
  }

  // Apply the first quickfix action (or the indexed one)
  const quickfixes = codeActions.filter(a =>
    "kind" in a && typeof a.kind === "string" && a.kind.startsWith("quickfix"),
  ) as CodeAction[];

  const fixToApply = quickfixes.length > 0 ? quickfixes[0] : codeActions[0] as CodeAction;

  if (!fixToApply.edit) {
    return {
      success: false,
      error: `Code action "${fixToApply.title}" has no edit to apply.`,
    };
  }

  const changes = await applyWorkspaceEdit(fixToApply.edit, ctx.workspaceDir);
  const totalEdits = changes.reduce((sum, c) => sum + (c.edits ?? 0), 0);

  return {
    success: true,
    data: {
      action: "apply_fix",
      changes,
      totalEdits,
      message: `Applied fix "${fixToApply.title}" (${totalEdits} edit${totalEdits !== 1 ? "s" : ""} in ${changes.length} file${changes.length !== 1 ? "s" : ""})`,
    },
    summary: `Applied: "${fixToApply.title}" (${totalEdits} edits)`,
  };
}

// ── Workspace Edit Application ──────────────────────────────────────────────

/**
 * Apply an LSP WorkspaceEdit to the filesystem.
 * Handles both `changes` (uri → TextEdit[]) and `documentChanges` formats.
 */
async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  workspaceDir: string,
): Promise<FileChange[]> {
  const fileChanges: FileChange[] = [];

  // Handle documentChanges (preferred, more expressive)
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("kind" in change) {
        // Resource operation (create/rename/delete)
        const result = await applyResourceOp(change as CreateFile | RenameFile | DeleteFile, workspaceDir);
        if (result) fileChanges.push(result);
      } else {
        // TextDocumentEdit
        const docEdit = change as TextDocumentEdit;
        const result = await applyTextEdits(docEdit.textDocument.uri, docEdit.edits as TextEdit[], workspaceDir);
        if (result) fileChanges.push(result);
      }
    }
    return fileChanges;
  }

  // Handle changes (simpler format: uri → TextEdit[])
  if (edit.changes) {
    for (const [uri, textEdits] of Object.entries(edit.changes)) {
      const result = await applyTextEdits(uri, textEdits, workspaceDir);
      if (result) fileChanges.push(result);
    }
  }

  return fileChanges;
}

/**
 * Apply text edits to a single file.
 */
async function applyTextEdits(
  uri: string,
  edits: TextEdit[],
  workspaceDir: string,
): Promise<FileChange | null> {
  if (edits.length === 0) return null;

  let filePath: string;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    filePath = uri;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return null; // Can't read file
  }

  const lines = content.split("\n");

  // Sort edits in reverse order (bottom-up) to preserve line numbers
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  // Apply each edit
  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const startChar = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endChar = edit.range.end.character;

    // Convert line/character positions to string offsets
    let startOffset = 0;
    for (let i = 0; i < startLine && i < lines.length; i++) {
      startOffset += lines[i].length + 1; // +1 for \n
    }
    startOffset += Math.min(startChar, (lines[startLine] ?? "").length);

    let endOffset = 0;
    for (let i = 0; i < endLine && i < lines.length; i++) {
      endOffset += lines[i].length + 1;
    }
    endOffset += Math.min(endChar, (lines[endLine] ?? "").length);

    // Build new content using offsets on the original string
    const currentContent = lines.join("\n");
    const newContent = currentContent.slice(0, startOffset) + edit.newText + currentContent.slice(endOffset);

    // Re-split for next iteration
    lines.length = 0;
    lines.push(...newContent.split("\n"));
  }

  const newContent = lines.join("\n");
  await fs.writeFile(filePath, newContent, "utf-8");

  return {
    file: path.relative(workspaceDir, filePath),
    type: "modified",
    edits: edits.length,
  };
}

/**
 * Apply a resource operation (create/rename/delete file).
 */
async function applyResourceOp(
  op: CreateFile | RenameFile | DeleteFile,
  workspaceDir: string,
): Promise<FileChange | null> {
  if (op.kind === "create") {
    let filePath: string;
    try { filePath = fileURLToPath(op.uri); } catch { filePath = op.uri; }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "", "utf-8");

    return {
      file: path.relative(workspaceDir, filePath),
      type: "created",
    };
  }

  if (op.kind === "rename") {
    let oldPath: string, newPath: string;
    try { oldPath = fileURLToPath(op.oldUri); } catch { oldPath = op.oldUri; }
    try { newPath = fileURLToPath(op.newUri); } catch { newPath = op.newUri; }

    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.rename(oldPath, newPath);

    return {
      file: path.relative(workspaceDir, newPath),
      type: "renamed",
      from: path.relative(workspaceDir, oldPath),
    };
  }

  if (op.kind === "delete") {
    let filePath: string;
    try { filePath = fileURLToPath(op.uri); } catch { filePath = op.uri; }

    await fs.unlink(filePath);

    return {
      file: path.relative(workspaceDir, filePath),
      type: "deleted",
    };
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolvePath(filePath: string, workspaceDir: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceDir, filePath);
}

/**
 * Format a ClientUnavailableReason into an agent-friendly error message.
 */
function formatRefactorError(reason: ClientUnavailableReason): string {
  switch (reason.kind) {
    case "prerequisite_missing":
      return `LSP server '${reason.command}' not found for ${reason.language}. Install: ${reason.installHint ?? reason.command}. Then retry.`;
    case "no_server_configured":
      return `No LSP server configured for ${reason.language}. code_refactor requires LSP.`;
    case "server_disabled":
      return `LSP server disabled for ${reason.language}. Enable it in config, then retry.`;
    case "crash_limit_exceeded":
      return `${reason.language} LSP server crashed ${reason.attempts} times. Run code_diagnose { action: "reload" } to retry, or use shell for type checking (e.g., 'npx tsc --noEmit').`;
    case "no_matching_root":
      return `File not in any registered language root. code_refactor requires LSP.`;
    case "disposed":
      return "LSP manager disposed (session ending).";
  }
}
