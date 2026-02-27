/**
 * Integration smoke test — exercises every Phase 1 tool against a real project.
 * Run: node test-integration.mjs [project-path]
 */

import { DevToolsCore } from "./dist/core/index.js";
import { createStorageManager } from "./dist/core/storage.js";
import { fileRead } from "./dist/tools/file-read.js";
import { fileWrite } from "./dist/tools/file-write.js";
import { fileEdit } from "./dist/tools/file-edit.js";
import { shell } from "./dist/tools/shell.js";
import { grep } from "./dist/tools/grep.js";
import { glob } from "./dist/tools/glob.js";
import { ls } from "./dist/tools/ls.js";
import { checkBlockedCommand, checkDangerousPatterns, validatePath } from "./dist/core/security.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const PROJECT = process.argv[2] || path.join(os.homedir(), "Projects/jaksa/gptappbuilder-io");

let passed = 0;
let failed = 0;

function assert(condition, label, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ": " + JSON.stringify(detail) : ""}`);
    failed++;
  }
}

async function main() {
  console.log(`\n🔧 Dev-Tools Phase 1 Integration Test`);
  console.log(`   Project: ${PROJECT}\n`);

  // ── Core: Workspace Analysis ──────────────────────────────────────────
  console.log("── Workspace Analysis ──");
  const core = new DevToolsCore({
    logger: { info: () => {}, warn: console.warn, error: console.error },
  });

  const ws = await core.analyzeWorkspace(PROJECT);
  assert(ws !== null, "Workspace analyzed");
  assert(ws.root === PROJECT, "Root matches");
  assert(ws.languages.length > 0, `Languages detected: ${ws.languages.map(l => l.language).join(", ")}`);
  assert(typeof ws.gitignoreFilter === "function", "Gitignore filter is a function");
  assert(ws.gitignoreFilter("node_modules/foo.js") === true, "node_modules is ignored");
  assert(ws.gitignoreFilter("src/index.ts") === false, "src/index.ts is not ignored");

  const status = core.getWorkspaceStatus(PROJECT);
  assert(status && status.includes("[dev-tools]"), `Status injection: ${status?.split("\n")[0]}`);

  // ── Core: Storage ─────────────────────────────────────────────────────
  console.log("\n── Storage ──");
  const storage = createStorageManager(PROJECT);
  assert(storage.slug.length > 0, `Slug: ${storage.slug}`);
  assert(storage.storageDir.includes(".dev-tools"), `Storage dir: ${storage.storageDir}`);
  await storage.ensureDirs();
  const dirExists = await fs.access(storage.storageDir).then(() => true).catch(() => false);
  assert(dirExists, "Storage directories created");

  // ── Core: Security ────────────────────────────────────────────────────
  console.log("\n── Security ──");
  const sec = { workspaceRoot: PROJECT, storageDir: storage.storageDir, jailEnabled: true };
  assert(validatePath("src/index.ts", sec).ok, "src/index.ts passes jail");
  assert(!validatePath("/etc/passwd", sec).ok, "/etc/passwd blocked by jail");
  assert(!validatePath("../../etc/passwd", sec).ok, "../../etc/passwd blocked by jail");
  assert(checkBlockedCommand("vim").blocked, "vim blocked");
  assert(!checkBlockedCommand("npm test").blocked, "npm test allowed");
  assert(checkDangerousPatterns("rm -rf /").blocked, "rm -rf / blocked");
  assert(!checkDangerousPatterns("rm -rf dist/").blocked, "rm -rf dist/ allowed");

  // ── Tool Context ──────────────────────────────────────────────────────
  const ctx = core.createToolContext(PROJECT, ws);

  // ── file_read ─────────────────────────────────────────────────────────
  console.log("\n── file_read ──");
  const readResult = await fileRead({ path: "package.json" }, ctx);
  assert(readResult.content && readResult.content.includes("│"), "Read with line numbers");
  assert(readResult.lines > 0, `Line count: ${readResult.lines}`);
  assert(readResult.language === "json", `Language: ${readResult.language}`);

  // Offset/limit
  const readSlice = await fileRead({ path: "package.json", offset: 2, limit: 3 }, ctx);
  assert(readSlice.showing?.from === 2, "Offset applied");
  assert(readSlice.showing?.to === 4, "Limit applied");

  // Not found with suggestions
  const readMissing = await fileRead({ path: "packge.json" }, ctx);
  assert(readMissing.error === "file_not_found", "File not found error");

  // Binary detection
  const binaryExts = ["node_modules/.package-lock.json"]; // try a known file
  // Just test the gitignore detection
  const readIgnored = await fileRead({ path: "node_modules/.package-lock.json" }, ctx);
  assert(readIgnored.error === "file_ignored" || readIgnored.error === "file_not_found", `Ignored/not found: ${readIgnored.error}`);

  // ── file_write + file_edit ────────────────────────────────────────────
  console.log("\n── file_write + file_edit ──");
  const testFile = path.join("__test_temp__", "edit-test.txt");
  const writeResult = await fileWrite({
    path: testFile,
    content: "line one\nline two\nline three\nline four\n",
  }, ctx);
  assert(writeResult.created === true, "File created");

  // Exact match edit
  const editResult = await fileEdit({
    path: testFile,
    edits: [{ oldText: "line two", newText: "LINE TWO MODIFIED" }],
  }, ctx);
  assert(editResult.applied === 1, `Edit applied: ${editResult.applied}`);
  assert(!editResult.strategies, "Used exact match (no fuzzy needed)");

  // Read back to verify
  const readBack = await fileRead({ path: testFile }, ctx);
  assert(readBack.content.includes("LINE TWO MODIFIED"), "Edit verified in file");

  // Whitespace-normalized edit
  await fileWrite({ path: testFile, content: "  function hello() {\n    return 'world';\n  }\n" }, ctx);
  const wsEdit = await fileEdit({
    path: testFile,
    edits: [{ oldText: "function hello() {\nreturn 'world';\n}", newText: "function hello() {\n    return 'universe';\n  }" }],
  }, ctx);
  assert(wsEdit.applied === 1, `Whitespace-normalized edit applied`);
  if (wsEdit.strategies) assert(true, `Used strategy: ${wsEdit.strategies.join(", ")}`);

  // Ambiguity test
  await fileWrite({ path: testFile, content: "foo\nbar\nfoo\nbar\n" }, ctx);
  const ambigEdit = await fileEdit({
    path: testFile,
    edits: [{ oldText: "foo", newText: "baz" }],
  }, ctx);
  assert(ambigEdit.failures?.length > 0 || ambigEdit.applied === 0, "Ambiguous edit caught");

  // Ambiguity resolved with lineHint
  const hintEdit = await fileEdit({
    path: testFile,
    edits: [{ oldText: "foo", newText: "baz", lineHint: 3 }],
  }, ctx);
  assert(hintEdit.applied === 1, "lineHint resolved ambiguity");

  // Clean up test file
  await fs.rm(path.join(PROJECT, "__test_temp__"), { recursive: true, force: true });

  // ── shell ─────────────────────────────────────────────────────────────
  console.log("\n── shell ──");
  const shellResult = await shell({ command: "echo hello && echo world" }, ctx);
  assert(shellResult.exitCode === 0, "Shell exit code 0");
  assert(shellResult.stdout.includes("hello"), "Shell stdout captured");

  const shellPwd = await shell({ command: "pwd" }, ctx);
  assert(shellPwd.stdout.trim() === PROJECT, `Shell cwd is project root`);

  const shellBlocked = await shell({ command: "vim" }, ctx);
  assert(shellBlocked.error === "blocked_command", "vim blocked by shell");

  const shellTimeout = await shell({ command: "sleep 5", timeout: 1000 }, ctx);
  assert(shellTimeout.timedOut === true || shellTimeout.exitCode !== 0, "Timeout works");

  // ── grep ──────────────────────────────────────────────────────────────
  console.log("\n── grep ──");
  const grepResult = await grep({ pattern: "import", path: "src", glob: "*.ts" }, ctx);
  if (grepResult.error === "ripgrep_not_found") {
    assert(false, "ripgrep not installed — grep tests skipped");
  } else {
    assert(grepResult.matches !== undefined, `Grep found matches: ${grepResult.totalMatches}`);
    assert(grepResult.totalMatches > 0, "Grep has results");

    const grepCount = await grep({ pattern: "import", mode: "count" }, ctx);
    assert(grepCount.matches !== undefined || grepCount.totalMatches >= 0, "Grep count mode works");
  }

  // ── glob ──────────────────────────────────────────────────────────────
  console.log("\n── glob ──");
  const globResult = await glob({ pattern: "**/*.ts", path: "src" }, ctx);
  assert(globResult.files !== undefined, `Glob found files: ${globResult.total}`);
  assert(globResult.total > 0, "Glob has results");
  if (globResult.files.length > 0) {
    assert(globResult.files[0].size !== undefined, "Glob includes file size");
    assert(globResult.files[0].modified !== undefined, "Glob includes mtime");
  }

  // ── ls ────────────────────────────────────────────────────────────────
  console.log("\n── ls ──");
  const lsResult = await ls({}, ctx);
  assert(lsResult.entries !== undefined, `ls returned entries: ${lsResult.entries.length}`);
  const dirs = lsResult.entries.filter(e => e.type === "dir");
  const files = lsResult.entries.filter(e => e.type === "file");
  assert(dirs.length > 0, `Directories found: ${dirs.length}`);
  assert(files.length > 0, `Files found: ${files.length}`);
  assert(dirs[0]?.children !== undefined, "Dir has child count");
  assert(files[0]?.size !== undefined, "File has size");

  // Check gitignore filtering
  const nodeModulesEntry = lsResult.entries.find(e => e.name === "node_modules/");
  assert(!nodeModulesEntry, "node_modules excluded from ls");

  const lsDeep = await ls({ depth: 1 }, ctx);
  const lsDeep2 = await ls({ depth: 3 }, ctx);
  assert(true, `Depth 1: ${lsDeep.entries.length} entries, Depth 3: ${lsDeep2.entries.length} entries`);

  // ── Token Budget ──────────────────────────────────────────────────────
  console.log("\n── Token Budget ──");
  const { truncateIfNeeded } = await import("./dist/core/token-budget.js");
  const budget = { maxResponseTokens: 10, toolOutputDir: path.join(storage.storageDir, "tool-output") };
  const bigContent = "x".repeat(1000);
  const truncResult = await truncateIfNeeded(bigContent, "tail", budget);
  assert(truncResult.truncated === true, "Large content truncated");
  assert(truncResult.savedPath !== undefined, `Saved to: ${truncResult.savedPath}`);
  assert(truncResult.content.length < bigContent.length, "Truncated content is shorter");

  // ── Logging ───────────────────────────────────────────────────────────
  console.log("\n── Logging ──");
  core.logToolCall({
    toolName: "file_read",
    params: { path: "package.json" },
    result: { lines: 30 },
    durationMs: 5,
  }, PROJECT);
  // Flush
  await core.onSessionEnd("test");
  const logDir = storage.logsDir();
  const logFiles = await fs.readdir(logDir).catch(() => []);
  assert(logFiles.length > 0, `Log files written: ${logFiles.join(", ")}`);

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
