/**
 * test tool — Run tests with structured JSON results.
 *
 * Auto-detects framework: Jest, Vitest, pytest, cargo test, swift test, go test.
 * Parses structured output → passed/failed/skipped counts, duration, structured failures.
 * Conditional registration: only if supported test runner detected.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ToolResult, TestRunner } from "../core/types.js";

// ── Params ──────────────────────────────────────────────────────────────────

export interface TestParams {
  file?: string;        // Run tests in a specific file
  suite?: string;       // Filter by suite/describe name
  name?: string;        // Filter by test name
  watch?: boolean;      // Watch mode (not recommended for agents, but available)
  timeout?: number;     // Timeout in ms (default: 300000 = 5 min)
}

// ── Structured Output Types ─────────────────────────────────────────────────

export interface TestFailure {
  test: string;
  suite: string;
  file: string;
  line?: number;
  error: string;
  stack?: string;
}

export interface TestResult {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  duration: string;
  failures: TestFailure[];
  exitCode: number;
  framework: string;
}

// ── Main Entry Point ────────────────────────────────────────────────────────

export async function test(
  params: TestParams,
  runner: TestRunner,
  workspaceDir: string,
): Promise<ToolResult> {
  try {
    switch (runner.framework) {
      case "vitest":
        return await runVitest(params, runner, workspaceDir);
      case "jest":
        return await runJest(params, runner, workspaceDir);
      case "pytest":
        return await runPytest(params, runner, workspaceDir);
      case "cargo":
        return await runCargo(params, runner, workspaceDir);
      case "swift":
        return await runSwift(params, runner, workspaceDir);
      case "go":
        return await runGo(params, runner, workspaceDir);
      default:
        return {
          success: false,
          error: `Unsupported test framework: ${runner.framework}`,
        };
    }
  } catch (e) {
    return {
      success: false,
      error: `Test tool error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ── Vitest ──────────────────────────────────────────────────────────────────

async function runVitest(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["vitest", "run", "--reporter=json"];

  if (params.file) args.push(params.file);
  if (params.name) args.push("--testNamePattern", params.name);

  const { stdout, stderr, exitCode } = await runCommand(
    "npx",
    args,
    runner.root,
    params.timeout,
  );

  try {
    // Vitest JSON output is on stdout
    const json = extractJson(stdout);
    if (!json) {
      return fallbackResult(stdout, stderr, exitCode, "vitest");
    }
    return parseVitestJson(json, exitCode);
  } catch {
    return fallbackResult(stdout, stderr, exitCode, "vitest");
  }
}

function parseVitestJson(json: any, exitCode: number): ToolResult {
  const testResults = json.testResults ?? [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: TestFailure[] = [];

  for (const fileResult of testResults) {
    const assertionResults = fileResult.assertionResults ?? [];
    for (const test of assertionResults) {
      switch (test.status) {
        case "passed":
          passed++;
          break;
        case "failed":
          failed++;
          failures.push({
            test: test.title ?? test.fullName ?? "unknown",
            suite: test.ancestorTitles?.join(" > ") ?? "",
            file: fileResult.name ?? "",
            error: test.failureMessages?.join("\n") ?? "Unknown error",
            stack: extractStack(test.failureMessages?.join("\n") ?? ""),
          });
          break;
        case "pending":
        case "skipped":
        case "todo":
          skipped++;
          break;
      }
    }
  }

  const duration = json.testResults?.[0]?.endTime && json.testResults?.[0]?.startTime
    ? `${((json.testResults.reduce((acc: number, r: any) => acc + ((r.endTime ?? 0) - (r.startTime ?? 0)), 0)) / 1000).toFixed(1)}s`
    : "unknown";

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    exitCode,
    framework: "vitest",
  };

  return {
    success: true,
    data: result,
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped (${duration})`,
  };
}

// ── Jest ─────────────────────────────────────────────────────────────────────

async function runJest(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["jest", "--json", "--no-coverage"];

  if (params.file) args.push(params.file);
  if (params.name) args.push("--testNamePattern", params.name);

  const { stdout, stderr, exitCode } = await runCommand(
    "npx",
    args,
    runner.root,
    params.timeout,
  );

  try {
    const json = extractJson(stdout);
    if (!json) {
      return fallbackResult(stdout, stderr, exitCode, "jest");
    }
    return parseJestJson(json, exitCode);
  } catch {
    return fallbackResult(stdout, stderr, exitCode, "jest");
  }
}

function parseJestJson(json: any, exitCode: number): ToolResult {
  const numPassed = json.numPassedTests ?? 0;
  const numFailed = json.numFailedTests ?? 0;
  const numSkipped = (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0);
  const failures: TestFailure[] = [];

  for (const fileResult of (json.testResults ?? [])) {
    for (const test of (fileResult.assertionResults ?? [])) {
      if (test.status === "failed") {
        failures.push({
          test: test.title ?? test.fullName ?? "unknown",
          suite: test.ancestorTitles?.join(" > ") ?? "",
          file: fileResult.name ?? "",
          error: test.failureMessages?.join("\n") ?? "Unknown error",
          stack: extractStack(test.failureMessages?.join("\n") ?? ""),
        });
      }
    }
  }

  // Jest JSON has a "startTime" at the top level
  const durationMs = json.testResults?.reduce(
    (acc: number, r: any) => acc + ((r.endTime ?? 0) - (r.startTime ?? 0)),
    0,
  ) ?? 0;

  const result: TestResult = {
    passed: numPassed,
    failed: numFailed,
    skipped: numSkipped,
    total: numPassed + numFailed + numSkipped,
    duration: `${(durationMs / 1000).toFixed(1)}s`,
    failures,
    exitCode,
    framework: "jest",
  };

  return {
    success: true,
    data: result,
    summary: `${numPassed} passed, ${numFailed} failed, ${numSkipped} skipped`,
  };
}

// ── Pytest ───────────────────────────────────────────────────────────────────

async function runPytest(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["-m", "pytest", "--tb=short", "-q"];

  if (params.file) args.push(params.file);
  if (params.name) args.push("-k", params.name);

  const { stdout, stderr, exitCode } = await runCommand(
    "python",
    args,
    runner.root,
    params.timeout,
  );

  return parsePytestOutput(stdout, stderr, exitCode);
}

function parsePytestOutput(stdout: string, stderr: string, exitCode: number): ToolResult {
  const output = stdout + "\n" + stderr;

  // Parse summary line — pytest can output counts in any order:
  // "X passed, Y failed, Z skipped in Ns" or "Y failed, X passed in Ns"
  // So we extract each count independently from the summary line.
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let duration = "unknown";

  // Find the summary line (contains "in X.XXs")
  const summaryLine = output.match(/.*(?:\d+\s+(?:passed|failed|skipped|error|warning|deselected).*)+in\s+([\d.]+)s.*/);
  if (summaryLine) {
    duration = `${summaryLine[1]}s`;
  }

  // Extract counts individually — works regardless of order
  const passedMatch = output.match(/(\d+)\s+passed/);
  if (passedMatch) passed = parseInt(passedMatch[1]) || 0;
  const failedMatch = output.match(/(\d+)\s+failed/);
  if (failedMatch) failed = parseInt(failedMatch[1]) || 0;
  const skippedMatch = output.match(/(\d+)\s+skipped/);
  if (skippedMatch) skipped = parseInt(skippedMatch[1]) || 0;
  const durationFallback = output.match(/in\s+([\d.]+)s/);
  if (duration === "unknown" && durationFallback) duration = `${durationFallback[1]}s`;

  // Parse failures: FAILED test_file.py::TestClass::test_name - AssertionError: ...
  const failures: TestFailure[] = [];
  const failureLines = output.match(/FAILED\s+(.+?)(?:\n|$)/g) ?? [];
  for (const line of failureLines) {
    const match = line.match(/FAILED\s+(.+?)::(.+?)(?:::(.+?))?\s*[-–]\s*(.*)/);
    if (match) {
      failures.push({
        test: match[3] ?? match[2],
        suite: match[3] ? match[2] : "",
        file: match[1],
        error: match[4]?.trim() ?? "Unknown error",
      });
    }
  }

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    exitCode,
    framework: "pytest",
  };

  return {
    success: true,
    data: result,
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped (${duration})`,
  };
}

// ── Cargo Test ──────────────────────────────────────────────────────────────

async function runCargo(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["test"];

  if (params.name) args.push(params.name);
  args.push("--", "--color=never");
  if (params.name) args.push("--test-threads=1");

  const { stdout, stderr, exitCode } = await runCommand(
    "cargo",
    args,
    runner.root,
    params.timeout,
  );

  return parseCargoOutput(stdout, stderr, exitCode);
}

function parseCargoOutput(stdout: string, stderr: string, exitCode: number): ToolResult {
  const output = stdout + "\n" + stderr;

  // Parse: test result: ok. X passed; Y failed; Z ignored; ...
  const summaryMatch = output.match(
    /test result:.*?(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/,
  );

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  if (summaryMatch) {
    passed = parseInt(summaryMatch[1]) || 0;
    failed = parseInt(summaryMatch[2]) || 0;
    skipped = parseInt(summaryMatch[3]) || 0;
  }

  // Parse individual failures
  const failures: TestFailure[] = [];
  const failLines = output.match(/test\s+(.+?)\s+\.\.\.\s+FAILED/g) ?? [];
  for (const line of failLines) {
    const match = line.match(/test\s+(.+?)\s+\.\.\.\s+FAILED/);
    if (match) {
      const testName = match[1];
      const parts = testName.split("::");
      failures.push({
        test: parts[parts.length - 1],
        suite: parts.slice(0, -1).join("::"),
        file: "",
        error: `Test ${testName} failed`,
      });
    }
  }

  // Duration from "finished in X.XXs"
  const durationMatch = output.match(/finished in ([\d.]+)s/);
  const duration = durationMatch ? `${durationMatch[1]}s` : "unknown";

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    exitCode,
    framework: "cargo",
  };

  return {
    success: true,
    data: result,
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped (${duration})`,
  };
}

// ── Swift Test ──────────────────────────────────────────────────────────────

async function runSwift(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["test"];

  if (params.name) args.push("--filter", params.name);

  const { stdout, stderr, exitCode } = await runCommand(
    "swift",
    args,
    runner.root,
    params.timeout,
  );

  return parseSwiftOutput(stdout, stderr, exitCode);
}

function parseSwiftOutput(stdout: string, stderr: string, exitCode: number): ToolResult {
  const output = stdout + "\n" + stderr;

  // Parse: Test Suite 'All tests' passed at ... Executed X tests, with Y failures
  const summaryMatch = output.match(
    /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?/,
  );

  let total = 0;
  let failed = 0;
  let passed = 0;
  let skipped = 0;

  if (summaryMatch) {
    total = parseInt(summaryMatch[1]) || 0;
    failed = parseInt(summaryMatch[2]) || 0;
    passed = total - failed;
  }

  // Parse skipped
  const skippedMatch = output.match(/(\d+)\s+skipped/);
  if (skippedMatch) {
    skipped = parseInt(skippedMatch[1]) || 0;
    passed = total - failed - skipped;
  }

  // Parse failures: file.swift:line: error: TestClass.testMethod : XCTAssert...
  const failures: TestFailure[] = [];
  const failPattern = /(.+\.swift):(\d+):\s*error:\s*(.+?)\.(\w+)\s*:\s*(.*)/g;
  let failMatch;
  while ((failMatch = failPattern.exec(output)) !== null) {
    failures.push({
      test: failMatch[4],
      suite: failMatch[3],
      file: failMatch[1],
      line: parseInt(failMatch[2]),
      error: failMatch[5],
    });
  }

  // Duration
  const durationMatch = output.match(/([\d.]+)\s*seconds/);
  const duration = durationMatch ? `${durationMatch[1]}s` : "unknown";

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total,
    duration,
    failures,
    exitCode,
    framework: "swift",
  };

  return {
    success: true,
    data: result,
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped (${duration})`,
  };
}

// ── Go Test ─────────────────────────────────────────────────────────────────

async function runGo(
  params: TestParams,
  runner: TestRunner,
  _workspaceDir: string,
): Promise<ToolResult> {
  const args = ["test", "-json"];

  if (params.file) {
    args.push(`./${path.dirname(params.file)}/...`);
  } else {
    args.push("./...");
  }

  if (params.name) args.push("-run", params.name);

  const { stdout, stderr, exitCode } = await runCommand(
    "go",
    args,
    runner.root,
    params.timeout,
  );

  return parseGoJson(stdout, stderr, exitCode);
}

function parseGoJson(stdout: string, _stderr: string, exitCode: number): ToolResult {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: TestFailure[] = [];
  const failureOutput = new Map<string, string[]>(); // test → output lines

  const lines = stdout.trim().split("\n").filter(Boolean);

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const testName = event.Test;
      if (!testName) continue; // Package-level events

      switch (event.Action) {
        case "pass":
          passed++;
          break;
        case "fail":
          failed++;
          failures.push({
            test: testName,
            suite: event.Package ?? "",
            file: "",
            error: (failureOutput.get(`${event.Package}/${testName}`) ?? []).join("\n") || "Test failed",
          });
          break;
        case "skip":
          skipped++;
          break;
        case "output":
          if (event.Output) {
            const key = `${event.Package}/${testName}`;
            if (!failureOutput.has(key)) failureOutput.set(key, []);
            failureOutput.get(key)!.push(event.Output.trimEnd());
          }
          break;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  // Duration from package-level events
  let duration = "unknown";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (!event.Test && event.Elapsed) {
        duration = `${event.Elapsed}s`;
      }
    } catch {
      // skip
    }
  }

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration,
    failures,
    exitCode,
    framework: "go",
  };

  return {
    success: true,
    data: result,
    summary: `${passed} passed, ${failed} failed, ${skipped} skipped (${duration})`,
  };
}

// ── Command Runner ──────────────────────────────────────────────────────────

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout?: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: timeout ?? 300000, // 5 min default
        maxBuffer: 50 * 1024 * 1024, // 50MB
        env: {
          ...process.env,
          TERM: "dumb",
          NO_COLOR: "1",
          FORCE_COLOR: "0",
          CI: "true", // Many test runners produce cleaner output in CI
        },
      },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number ?? 1) : (error ? 1 : 0);
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      },
    );
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract JSON from potentially noisy output (may have preamble text).
 */
function extractJson(output: string): any | null {
  // Try direct parse first
  try {
    return JSON.parse(output);
  } catch {
    // Look for JSON start
  }

  // Find first { or [ and try to parse from there
  const jsonStart = output.search(/[\[{]/);
  if (jsonStart < 0) return null;

  // Try progressively from each { or [ 
  for (let i = jsonStart; i < output.length; i++) {
    if (output[i] === "{" || output[i] === "[") {
      try {
        return JSON.parse(output.slice(i));
      } catch {
        // Try next position
      }
    }
  }

  return null;
}

/**
 * Extract stack trace from an error string.
 */
function extractStack(errorStr: string): string {
  const lines = errorStr.split("\n");
  const stackLines = lines.filter(l => l.trim().startsWith("at ") || l.match(/^\s+at /));
  return stackLines.join("\n").trim() || "";
}

/**
 * Fallback: when JSON parsing fails, return raw output with basic parsing.
 */
function fallbackResult(
  stdout: string,
  stderr: string,
  exitCode: number,
  framework: string,
): ToolResult {
  const output = (stdout + "\n" + stderr).trim();

  // Try to extract basic counts from output
  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);
  const skipMatch = output.match(/(\d+)\s+(?:skip|pending|todo)/i);

  const passed = passMatch ? parseInt(passMatch[1]) : 0;
  const failed = failMatch ? parseInt(failMatch[1]) : 0;
  const skipped = skipMatch ? parseInt(skipMatch[1]) : 0;

  const result: TestResult = {
    passed,
    failed,
    skipped,
    total: passed + failed + skipped,
    duration: "unknown",
    failures: [],
    exitCode,
    framework,
  };

  return {
    success: true,
    data: {
      ...result,
      rawOutput: output.slice(0, 5000), // Truncate for safety
      note: "JSON parsing failed, results extracted from raw output",
    },
    summary: exitCode === 0
      ? `Tests passed (${framework})`
      : `Tests failed with exit code ${exitCode} (${framework})`,
  };
}
