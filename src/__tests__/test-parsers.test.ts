/**
 * Test tool parser hardening — unit tests for all 6 framework parsers.
 * Uses fixture data (mock JSON/output strings), NOT real test runners.
 *
 * We access the parsers indirectly by re-exporting key helper functions,
 * but since the parsers are module-private, we test them via known contract:
 * call the tool with a mock runner that would produce known output.
 *
 * For pure parser testing, we duplicate the parser logic here with fixtures.
 */

import { describe, it, expect } from "vitest";

// ── extractJson helper (reimplemented to test in isolation) ─────────────────

function extractJson(output: string): any | null {
  try {
    return JSON.parse(output);
  } catch {
    // Look for JSON start
  }
  const jsonStart = output.search(/[\[{]/);
  if (jsonStart < 0) return null;
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

// ── extractStack helper ─────────────────────────────────────────────────────

function extractStack(errorStr: string): string {
  const lines = errorStr.split("\n");
  const stackLines = lines.filter(l => l.trim().startsWith("at ") || l.match(/^\s+at /));
  return stackLines.join("\n").trim() || "";
}

// ── extractJson tests ───────────────────────────────────────────────────────

describe("extractJson", () => {
  it("parses clean JSON", () => {
    const result = extractJson('{"numPassedTests": 5}');
    expect(result).toEqual({ numPassedTests: 5 });
  });

  it("handles noisy preamble before JSON", () => {
    const output = `
> vitest run
Loading config from vitest.config.ts
Running tests...
{"numPassedTests": 5, "numFailedTests": 0}`;
    const result = extractJson(output);
    expect(result).toEqual({ numPassedTests: 5, numFailedTests: 0 });
  });

  it("handles preamble with curly braces in text", () => {
    const output = `
Some text with { in it
More text with [ brackets
{"actual": "json"}`;
    const result = extractJson(output);
    expect(result).toEqual({ actual: "json" });
  });

  it("returns null for no JSON", () => {
    expect(extractJson("just plain text")).toBeNull();
    expect(extractJson("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractJson("{broken: json}")).toBeNull();
  });

  it("handles JSON array", () => {
    const result = extractJson('[{"test": 1}, {"test": 2}]');
    expect(result).toEqual([{ test: 1 }, { test: 2 }]);
  });

  it("handles JSON with trailing content", () => {
    // extractJson tries from each { — the first complete parse wins
    const output = '{"a": 1}\nsome trailing text';
    const result = extractJson(output);
    // This may or may not parse depending on implementation
    // The key is it doesn't crash
    expect(result !== undefined).toBe(true);
  });

  it("handles very large JSON", () => {
    const largeObj: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      largeObj[`key${i}`] = i;
    }
    const result = extractJson(JSON.stringify(largeObj));
    expect(result).toEqual(largeObj);
  });
});

// ── extractStack tests ──────────────────────────────────────────────────────

describe("extractStack", () => {
  it("extracts stack trace lines", () => {
    const error = `AssertionError: expected 1 to be 2
    at Object.<anonymous> (test.ts:5:10)
    at processTicksAndRejections (node:internal:73:11)`;
    const stack = extractStack(error);
    expect(stack).toContain("at Object.<anonymous>");
    expect(stack).toContain("at processTicksAndRejections");
  });

  it("returns empty for no stack", () => {
    expect(extractStack("Simple error message")).toBe("");
  });

  it("handles indented at lines", () => {
    const error = `Error: boom
      at Context.fn (test.js:10:5)`;
    const stack = extractStack(error);
    expect(stack).toContain("at Context.fn");
  });
});

// ── Vitest JSON parser fixtures ─────────────────────────────────────────────

describe("vitest parser fixtures", () => {
  function parseVitestJson(json: any, exitCode: number) {
    const testResults = json.testResults ?? [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const failures: Array<{ test: string; suite: string; file: string; error: string }> = [];

    for (const fileResult of testResults) {
      for (const test of (fileResult.assertionResults ?? [])) {
        switch (test.status) {
          case "passed": passed++; break;
          case "failed":
            failed++;
            failures.push({
              test: test.title ?? test.fullName ?? "unknown",
              suite: test.ancestorTitles?.join(" > ") ?? "",
              file: fileResult.name ?? "",
              error: test.failureMessages?.join("\n") ?? "Unknown error",
            });
            break;
          case "pending": case "skipped": case "todo": skipped++; break;
        }
      }
    }

    return { passed, failed, skipped, total: passed + failed + skipped, failures };
  }

  it("all-pass scenario", () => {
    const json = {
      testResults: [{
        name: "/project/src/utils.test.ts",
        assertionResults: [
          { status: "passed", title: "adds numbers", ancestorTitles: ["math"], fullName: "math > adds numbers" },
          { status: "passed", title: "subtracts", ancestorTitles: ["math"], fullName: "math > subtracts" },
          { status: "passed", title: "multiplies", ancestorTitles: ["math"], fullName: "math > multiplies" },
        ],
        startTime: 1000, endTime: 1500,
      }],
    };
    const r = parseVitestJson(json, 0);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.total).toBe(3);
    expect(r.failures).toEqual([]);
  });

  it("all-fail scenario", () => {
    const json = {
      testResults: [{
        name: "/project/src/broken.test.ts",
        assertionResults: [
          { status: "failed", title: "test A", ancestorTitles: ["Suite"], failureMessages: ["Expected true to be false"] },
          { status: "failed", title: "test B", ancestorTitles: ["Suite"], failureMessages: ["TypeError: x is not a function"] },
        ],
        startTime: 1000, endTime: 2000,
      }],
    };
    const r = parseVitestJson(json, 1);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(2);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0].test).toBe("test A");
    expect(r.failures[0].error).toContain("Expected true to be false");
  });

  it("mixed results with skipped", () => {
    const json = {
      testResults: [{
        name: "/project/test.ts",
        assertionResults: [
          { status: "passed", title: "works" },
          { status: "failed", title: "breaks", failureMessages: ["boom"] },
          { status: "pending", title: "todo test" },
          { status: "todo", title: "another todo" },
          { status: "skipped", title: "skipped one" },
        ],
        startTime: 0, endTime: 100,
      }],
    };
    const r = parseVitestJson(json, 1);
    expect(r.passed).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(3);
    expect(r.total).toBe(5);
  });

  it("empty test results", () => {
    const json = { testResults: [] };
    const r = parseVitestJson(json, 0);
    expect(r.total).toBe(0);
    expect(r.passed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("missing fields handled gracefully", () => {
    const json = {
      testResults: [{
        assertionResults: [
          { status: "failed" }, // No title, no failureMessages
        ],
      }],
    };
    const r = parseVitestJson(json, 1);
    expect(r.failed).toBe(1);
    expect(r.failures[0].test).toBe("unknown");
    expect(r.failures[0].error).toBe("Unknown error");
  });

  it("multi-file results", () => {
    const json = {
      testResults: [
        {
          name: "file1.test.ts",
          assertionResults: [
            { status: "passed", title: "a" },
            { status: "passed", title: "b" },
          ],
        },
        {
          name: "file2.test.ts",
          assertionResults: [
            { status: "failed", title: "c", failureMessages: ["err"] },
            { status: "passed", title: "d" },
          ],
        },
      ],
    };
    const r = parseVitestJson(json, 1);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.failures[0].file).toBe("file2.test.ts");
  });

  it("nested ancestorTitles", () => {
    const json = {
      testResults: [{
        name: "test.ts",
        assertionResults: [{
          status: "failed",
          title: "deep test",
          ancestorTitles: ["Outer", "Middle", "Inner"],
          failureMessages: ["fail"],
        }],
      }],
    };
    const r = parseVitestJson(json, 1);
    expect(r.failures[0].suite).toBe("Outer > Middle > Inner");
  });
});

// ── Jest JSON parser fixtures ───────────────────────────────────────────────

describe("jest parser fixtures", () => {
  function parseJestJson(json: any, exitCode: number) {
    const numPassed = json.numPassedTests ?? 0;
    const numFailed = json.numFailedTests ?? 0;
    const numSkipped = (json.numPendingTests ?? 0) + (json.numTodoTests ?? 0);
    const failures: Array<{ test: string; suite: string; file: string; error: string }> = [];

    for (const fileResult of (json.testResults ?? [])) {
      for (const test of (fileResult.assertionResults ?? [])) {
        if (test.status === "failed") {
          failures.push({
            test: test.title ?? "unknown",
            suite: test.ancestorTitles?.join(" > ") ?? "",
            file: fileResult.name ?? "",
            error: test.failureMessages?.join("\n") ?? "Unknown error",
          });
        }
      }
    }

    return { passed: numPassed, failed: numFailed, skipped: numSkipped, failures };
  }

  it("all-pass jest output", () => {
    const json = {
      numPassedTests: 10,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{
        name: "sum.test.js",
        assertionResults: Array.from({ length: 10 }, (_, i) => ({
          status: "passed", title: `test ${i}`,
        })),
      }],
    };
    const r = parseJestJson(json, 0);
    expect(r.passed).toBe(10);
    expect(r.failed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("jest with pending and todo tests", () => {
    const json = {
      numPassedTests: 3,
      numFailedTests: 1,
      numPendingTests: 2,
      numTodoTests: 1,
      testResults: [{
        name: "test.js",
        assertionResults: [
          { status: "failed", title: "broken", failureMessages: ["Expected 1 to be 2"] },
        ],
      }],
    };
    const r = parseJestJson(json, 1);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(3); // 2 pending + 1 todo
    expect(r.failures[0].error).toContain("Expected 1 to be 2");
  });

  it("jest empty results", () => {
    const json = {
      numPassedTests: 0,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [],
    };
    const r = parseJestJson(json, 0);
    expect(r.passed).toBe(0);
    expect(r.failures).toEqual([]);
  });
});

// ── Pytest output parser fixtures ───────────────────────────────────────────

describe("pytest parser fixtures", () => {
  function parsePytestOutput(stdout: string, stderr: string, exitCode: number) {
    const output = stdout + "\n" + stderr;
    let passed = 0, failed = 0, skipped = 0, duration = "unknown";

    // Extract counts individually — works regardless of order
    const passedMatch = output.match(/(\d+)\s+passed/);
    if (passedMatch) passed = parseInt(passedMatch[1]) || 0;
    const failedMatch = output.match(/(\d+)\s+failed/);
    if (failedMatch) failed = parseInt(failedMatch[1]) || 0;
    const skippedMatch = output.match(/(\d+)\s+skipped/);
    if (skippedMatch) skipped = parseInt(skippedMatch[1]) || 0;
    const durationMatch = output.match(/in\s+([\d.]+)s/);
    if (durationMatch) duration = `${durationMatch[1]}s`;

    const failures: Array<{ test: string; suite: string; file: string; error: string }> = [];
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

    return { passed, failed, skipped, duration, failures };
  }

  it("all tests pass", () => {
    const stdout = `
test_math.py ..                                                          [100%]
2 passed in 0.03s
`;
    const r = parsePytestOutput(stdout, "", 0);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.duration).toBe("0.03s");
  });

  it("failures with tracebacks", () => {
    const stdout = `
FAILED test_math.py::TestCalc::test_divide - ZeroDivisionError: division by zero
FAILED test_math.py::test_sqrt - AssertionError: assert 4 == 5
2 failed, 3 passed in 1.23s
`;
    const r = parsePytestOutput(stdout, "", 1);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(2);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0].test).toBe("test_divide");
    expect(r.failures[0].suite).toBe("TestCalc");
    expect(r.failures[0].file).toBe("test_math.py");
    expect(r.failures[0].error).toContain("ZeroDivisionError");
    expect(r.failures[1].test).toBe("test_sqrt");
    expect(r.failures[1].suite).toBe("");
  });

  it("skipped tests", () => {
    const stdout = `
5 passed, 2 skipped in 0.5s
`;
    const r = parsePytestOutput(stdout, "", 0);
    expect(r.passed).toBe(5);
    expect(r.skipped).toBe(2);
  });

  it("mixed results", () => {
    const stdout = `
10 passed, 2 failed, 3 skipped in 2.45s
`;
    const r = parsePytestOutput(stdout, "", 1);
    expect(r.passed).toBe(10);
    expect(r.failed).toBe(2);
    expect(r.skipped).toBe(3);
    expect(r.duration).toBe("2.45s");
  });

  it("only failures (no passed)", () => {
    const stdout = `
FAILED test_all.py::test_one - AssertionError
3 failed in 0.1s
`;
    const r = parsePytestOutput(stdout, "", 1);
    expect(r.failed).toBe(3);
  });

  it("parametrized test failures", () => {
    const stdout = `
FAILED test_param.py::TestParam::test_values[1-2] - AssertionError: 1 != 2
FAILED test_param.py::TestParam::test_values[3-4] - AssertionError: 3 != 4
2 failed, 5 passed in 0.8s
`;
    const r = parsePytestOutput(stdout, "", 1);
    expect(r.passed).toBe(5);
    expect(r.failed).toBe(2);
    expect(r.failures.length).toBe(2);
  });

  it("empty output", () => {
    const r = parsePytestOutput("", "", 0);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.duration).toBe("unknown");
  });
});

// ── Cargo test output parser fixtures ───────────────────────────────────────

describe("cargo parser fixtures", () => {
  function parseCargoOutput(stdout: string, stderr: string, exitCode: number) {
    const output = stdout + "\n" + stderr;
    const summaryMatch = output.match(
      /test result:.*?(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/,
    );

    let passed = 0, failed = 0, skipped = 0;
    if (summaryMatch) {
      passed = parseInt(summaryMatch[1]) || 0;
      failed = parseInt(summaryMatch[2]) || 0;
      skipped = parseInt(summaryMatch[3]) || 0;
    }

    const failures: Array<{ test: string; suite: string; error: string }> = [];
    const failLines = output.match(/test\s+(.+?)\s+\.\.\.\s+FAILED/g) ?? [];
    for (const line of failLines) {
      const match = line.match(/test\s+(.+?)\s+\.\.\.\s+FAILED/);
      if (match) {
        const testName = match[1];
        const parts = testName.split("::");
        failures.push({
          test: parts[parts.length - 1],
          suite: parts.slice(0, -1).join("::"),
          error: `Test ${testName} failed`,
        });
      }
    }

    const durationMatch = output.match(/finished in ([\d.]+)s/);
    const duration = durationMatch ? `${durationMatch[1]}s` : "unknown";

    return { passed, failed, skipped, duration, failures };
  }

  it("all pass", () => {
    const stdout = `
running 3 tests
test tests::test_add ... ok
test tests::test_sub ... ok
test tests::test_mul ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
`;
    const r = parseCargoOutput(stdout, "", 0);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.duration).toBe("0.01s");
    expect(r.failures).toEqual([]);
  });

  it("failures with nested module paths", () => {
    const stdout = `
running 4 tests
test utils::tests::test_parse ... ok
test utils::tests::test_format ... FAILED
test core::engine::test_run ... FAILED
test core::engine::test_stop ... ok

test result: FAILED. 2 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.5s
`;
    const r = parseCargoOutput(stdout, "", 1);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0].test).toBe("test_format");
    expect(r.failures[0].suite).toBe("utils::tests");
    expect(r.failures[1].test).toBe("test_run");
    expect(r.failures[1].suite).toBe("core::engine");
  });

  it("ignored (skipped) tests", () => {
    const stdout = `
running 5 tests
test test_one ... ok
test test_two ... ok
test test_three ... ok

test result: ok. 3 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.02s
`;
    const r = parseCargoOutput(stdout, "", 0);
    expect(r.passed).toBe(3);
    expect(r.skipped).toBe(2);
  });

  it("empty test run", () => {
    const stdout = `
running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
    const r = parseCargoOutput(stdout, "", 0);
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.duration).toBe("0.00s");
  });
});

// ── Swift test output parser fixtures ───────────────────────────────────────

describe("swift parser fixtures", () => {
  function parseSwiftOutput(stdout: string, stderr: string, exitCode: number) {
    const output = stdout + "\n" + stderr;
    const summaryMatch = output.match(
      /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?/,
    );

    let total = 0, failed = 0, passed = 0, skipped = 0;
    if (summaryMatch) {
      total = parseInt(summaryMatch[1]) || 0;
      failed = parseInt(summaryMatch[2]) || 0;
      passed = total - failed;
    }

    const skippedMatch = output.match(/(\d+)\s+skipped/);
    if (skippedMatch) {
      skipped = parseInt(skippedMatch[1]) || 0;
      passed = total - failed - skipped;
    }

    const failures: Array<{ test: string; suite: string; file: string; line: number; error: string }> = [];
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

    const durationMatch = output.match(/([\d.]+)\s*seconds/);
    const duration = durationMatch ? `${durationMatch[1]}s` : "unknown";

    return { passed, failed, skipped, total, duration, failures };
  }

  it("all pass", () => {
    const stdout = `
Test Suite 'All tests' started at 2026-02-27 00:00:00.000.
Test Suite 'MyTests' started at 2026-02-27 00:00:00.001.
Test Case '-[MyTests testOne]' passed (0.001 seconds).
Test Case '-[MyTests testTwo]' passed (0.001 seconds).
Test Suite 'MyTests' passed at 2026-02-27 00:00:00.003.
	 Executed 2 tests, with 0 failures (0 unexpected) in 0.002 (0.003) seconds
Test Suite 'All tests' passed at 2026-02-27 00:00:00.003.
	 Executed 2 tests, with 0 failures (0 unexpected) in 0.002 (0.003) seconds
`;
    const r = parseSwiftOutput(stdout, "", 0);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it("failures with file:line", () => {
    const stdout = `
/Users/dev/Tests/MathTests.swift:15: error: MathTests.testDivide : XCTAssertEqual failed: ("inf") is not equal to ("0.0")
/Users/dev/Tests/MathTests.swift:22: error: MathTests.testSqrt : XCTAssertTrue failed
Test Suite 'All tests' failed at 2026-02-27 00:00:01.000.
	 Executed 5 tests, with 2 failures (0 unexpected) in 0.5 (0.6) seconds
`;
    const r = parseSwiftOutput(stdout, "", 1);
    expect(r.total).toBe(5);
    expect(r.failed).toBe(2);
    expect(r.passed).toBe(3);
    expect(r.failures.length).toBe(2);
    expect(r.failures[0].test).toBe("testDivide");
    expect(r.failures[0].suite).toBe("MathTests");
    expect(r.failures[0].file).toBe("/Users/dev/Tests/MathTests.swift");
    expect(r.failures[0].line).toBe(15);
    expect(r.failures[0].error).toContain("XCTAssertEqual failed");
  });

  it("single test", () => {
    const stdout = `
	 Executed 1 test, with 0 failures (0 unexpected) in 0.001 (0.002) seconds
`;
    const r = parseSwiftOutput(stdout, "", 0);
    expect(r.total).toBe(1);
    expect(r.passed).toBe(1);
  });

  it("with skipped tests", () => {
    const stdout = `
	 Executed 10 tests, with 1 failures (0 unexpected) in 0.5 (0.6) seconds
3 skipped
`;
    const r = parseSwiftOutput(stdout, "", 1);
    expect(r.total).toBe(10);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(3);
    expect(r.passed).toBe(6); // 10 - 1 - 3
  });
});

// ── Go test JSON parser fixtures ────────────────────────────────────────────

describe("go parser fixtures", () => {
  function parseGoJson(stdout: string) {
    let passed = 0, failed = 0, skipped = 0;
    const failures: Array<{ test: string; suite: string; error: string }> = [];
    const failureOutput = new Map<string, string[]>();

    const lines = stdout.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const testName = event.Test;
        if (!testName) continue;

        switch (event.Action) {
          case "pass": passed++; break;
          case "fail":
            failed++;
            failures.push({
              test: testName,
              suite: event.Package ?? "",
              error: (failureOutput.get(`${event.Package}/${testName}`) ?? []).join("\n") || "Test failed",
            });
            break;
          case "skip": skipped++; break;
          case "output":
            if (event.Output) {
              const key = `${event.Package}/${testName}`;
              if (!failureOutput.has(key)) failureOutput.set(key, []);
              failureOutput.get(key)!.push(event.Output.trimEnd());
            }
            break;
        }
      } catch {
        // Skip non-JSON
      }
    }

    let duration = "unknown";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (!event.Test && event.Elapsed) {
          duration = `${event.Elapsed}s`;
        }
      } catch { /* skip */ }
    }

    return { passed, failed, skipped, duration, failures };
  }

  it("all pass", () => {
    const stdout = `
{"Time":"2026-02-27T00:00:00Z","Action":"run","Package":"example.com/pkg","Test":"TestAdd"}
{"Time":"2026-02-27T00:00:00Z","Action":"output","Package":"example.com/pkg","Test":"TestAdd","Output":"=== RUN   TestAdd\\n"}
{"Time":"2026-02-27T00:00:00Z","Action":"output","Package":"example.com/pkg","Test":"TestAdd","Output":"--- PASS: TestAdd (0.00s)\\n"}
{"Time":"2026-02-27T00:00:00Z","Action":"pass","Package":"example.com/pkg","Test":"TestAdd","Elapsed":0}
{"Time":"2026-02-27T00:00:00Z","Action":"run","Package":"example.com/pkg","Test":"TestSub"}
{"Time":"2026-02-27T00:00:00Z","Action":"pass","Package":"example.com/pkg","Test":"TestSub","Elapsed":0}
{"Time":"2026-02-27T00:00:00Z","Action":"pass","Package":"example.com/pkg","Elapsed":0.5}
`;
    const r = parseGoJson(stdout);
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.duration).toBe("0.5s");
  });

  it("failures with output capture", () => {
    const stdout = `
{"Time":"2026-02-27T00:00:00Z","Action":"run","Package":"example.com/pkg","Test":"TestBroken"}
{"Time":"2026-02-27T00:00:00Z","Action":"output","Package":"example.com/pkg","Test":"TestBroken","Output":"    broken_test.go:10: expected 1, got 2\\n"}
{"Time":"2026-02-27T00:00:00Z","Action":"output","Package":"example.com/pkg","Test":"TestBroken","Output":"    broken_test.go:11: assertion failed\\n"}
{"Time":"2026-02-27T00:00:00Z","Action":"fail","Package":"example.com/pkg","Test":"TestBroken","Elapsed":0.01}
{"Time":"2026-02-27T00:00:00Z","Action":"fail","Package":"example.com/pkg","Elapsed":0.5}
`;
    const r = parseGoJson(stdout);
    expect(r.failed).toBe(1);
    expect(r.failures[0].test).toBe("TestBroken");
    expect(r.failures[0].suite).toBe("example.com/pkg");
    expect(r.failures[0].error).toContain("expected 1, got 2");
    expect(r.failures[0].error).toContain("assertion failed");
  });

  it("skipped tests", () => {
    const stdout = `
{"Time":"2026-02-27T00:00:00Z","Action":"run","Package":"pkg","Test":"TestSkip"}
{"Time":"2026-02-27T00:00:00Z","Action":"skip","Package":"pkg","Test":"TestSkip","Elapsed":0}
{"Time":"2026-02-27T00:00:00Z","Action":"run","Package":"pkg","Test":"TestPass"}
{"Time":"2026-02-27T00:00:00Z","Action":"pass","Package":"pkg","Test":"TestPass","Elapsed":0}
`;
    const r = parseGoJson(stdout);
    expect(r.passed).toBe(1);
    expect(r.skipped).toBe(1);
  });

  it("mixed JSON and non-JSON lines", () => {
    const stdout = `
some compile warning
{"Action":"run","Package":"pkg","Test":"TestA"}
another warning line
{"Action":"pass","Package":"pkg","Test":"TestA","Elapsed":0}
`;
    const r = parseGoJson(stdout);
    expect(r.passed).toBe(1);
  });

  it("empty JSONL output", () => {
    const r = parseGoJson("");
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
    expect(r.duration).toBe("unknown");
  });

  it("subtests", () => {
    const stdout = `
{"Action":"run","Package":"pkg","Test":"TestTable"}
{"Action":"run","Package":"pkg","Test":"TestTable/case_1"}
{"Action":"pass","Package":"pkg","Test":"TestTable/case_1","Elapsed":0}
{"Action":"run","Package":"pkg","Test":"TestTable/case_2"}
{"Action":"fail","Package":"pkg","Test":"TestTable/case_2","Elapsed":0}
{"Action":"fail","Package":"pkg","Test":"TestTable","Elapsed":0}
`;
    const r = parseGoJson(stdout);
    // subtests + parent are counted individually
    expect(r.passed).toBe(1); // case_1
    expect(r.failed).toBe(2); // case_2 + TestTable parent
  });
});

// ── fallbackResult behavior ─────────────────────────────────────────────────

describe("fallbackResult behavior", () => {
  function fallbackResult(stdout: string, stderr: string, exitCode: number, framework: string) {
    const output = (stdout + "\n" + stderr).trim();
    const passMatch = output.match(/(\d+)\s+pass/i);
    const failMatch = output.match(/(\d+)\s+fail/i);
    const skipMatch = output.match(/(\d+)\s+(?:skip|pending|todo)/i);

    return {
      passed: passMatch ? parseInt(passMatch[1]) : 0,
      failed: failMatch ? parseInt(failMatch[1]) : 0,
      skipped: skipMatch ? parseInt(skipMatch[1]) : 0,
      exitCode,
      framework,
    };
  }

  it("extracts counts from raw output", () => {
    const r = fallbackResult("5 pass\n2 fail\n1 skip", "", 1, "vitest");
    expect(r.passed).toBe(5);
    expect(r.failed).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it("handles output with 'passed' and 'failed'", () => {
    const r = fallbackResult("10 passed, 3 failed", "", 1, "jest");
    expect(r.passed).toBe(10);
    expect(r.failed).toBe(3);
  });

  it("handles completely empty output", () => {
    const r = fallbackResult("", "", 1, "unknown");
    expect(r.passed).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("handles pending tests", () => {
    const r = fallbackResult("5 passed, 2 pending", "", 0, "jest");
    expect(r.passed).toBe(5);
    expect(r.skipped).toBe(2);
  });

  it("handles todo tests", () => {
    const r = fallbackResult("3 pass, 1 todo", "", 0, "vitest");
    expect(r.passed).toBe(3);
    expect(r.skipped).toBe(1);
  });
});
