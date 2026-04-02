/**
 * Barrel export for all dev-tools tool functions.
 *
 * Standalone usage (no OpenClaw required):
 *
 *   import { DevToolsCore } from '@jaksm/dev-tools/core'
 *   import { fileRead, grep, codeSearch } from '@jaksm/dev-tools/tools'
 *
 *   const core = new DevToolsCore({ logger: console })
 *   const workspace = await core.analyzeWorkspace('/path/to/project')
 *   const ctx = core.createToolContext('/path/to/project')
 *   const result = await fileRead({ path: 'src/index.ts' }, ctx)
 */

// ── Foundation Tools ─────────────────────────────────────────────────────────

export { fileRead, type FileReadParams } from "./file-read.js";
export { fileWrite, type FileWriteParams } from "./file-write.js";
export { fileEdit, type FileEditParams, type EditOperation, type FileEditLspOptions } from "./file-edit.js";
export { shell, type ShellParams } from "./shell.js";
export { grep, type GrepParams } from "./grep.js";
export { glob, type GlobParams } from "./glob.js";
export { ls, type LsParams } from "./ls.js";
export { git, type GitParams } from "./git.js";
export { test, type TestParams, type TestResult, type TestFailure } from "./test.js";

// ── Code Intelligence Tools ──────────────────────────────────────────────────

export { codeOutline, type CodeOutlineParams, type OutlineSymbol, type CodeOutlineResult } from "./code-outline.js";
export { codeRead, type CodeReadParams, type CodeReadResult, type DependencyInfo } from "./code-read.js";
export { codeSearch, type CodeSearchParams } from "./code-search.js";
export { codeInspect, type CodeInspectParams, type CodeInspectResult, type DefinitionLocation, type ReferenceLocation } from "./code-inspect.js";
export { codeDiagnose, type CodeDiagnoseParams } from "./code-diagnose.js";
export { codeRefactor, type CodeRefactorParams, type CodeRefactorResult, type FileChange } from "./code-refactor.js";

// ── Workflow Tools ───────────────────────────────────────────────────────────

export { task, type TaskParams } from "./task.js";
