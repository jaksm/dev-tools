/**
 * Test runner detection — detect test frameworks from config files.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { LanguageInfo, TestRunner } from "./types.js";

export async function detectTestRunners(
  _workspaceRoot: string,
  languages: LanguageInfo[],
): Promise<TestRunner[]> {
  const runners: TestRunner[] = [];

  // Check JS/TS projects for Jest/Vitest
  for (const lang of languages) {
    if (lang.language === "typescript" || lang.language === "javascript") {
      const runner = await detectJsTestRunner(lang.root);
      if (runner) runners.push(runner);
    }

    if (lang.language === "python") {
      const runner = await detectPythonTestRunner(lang.root);
      if (runner) runners.push(runner);
    }

    if (lang.language === "rust") {
      runners.push({
        name: "cargo test",
        framework: "cargo",
        root: lang.root,
        command: "cargo test",
      });
    }

    if (lang.language === "swift") {
      runners.push({
        name: "swift test",
        framework: "swift",
        root: lang.root,
        command: "swift test",
      });
    }

    if (lang.language === "go") {
      runners.push({
        name: "go test",
        framework: "go",
        root: lang.root,
        command: "go test ./...",
      });
    }
  }

  return runners;
}

async function detectJsTestRunner(root: string): Promise<TestRunner | null> {
  try {
    const pkgPath = path.join(root, "package.json");
    const content = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as Record<string, unknown>;
    const deps = {
      ...(pkg.dependencies as Record<string, string> | undefined),
      ...(pkg.devDependencies as Record<string, string> | undefined),
    };

    if (deps["vitest"]) {
      return {
        name: "vitest",
        framework: "vitest",
        root,
        command: "npx vitest run --reporter=json",
      };
    }

    if (deps["jest"]) {
      return {
        name: "jest",
        framework: "jest",
        root,
        command: "npx jest --json",
      };
    }
  } catch {
    // No package.json or invalid
  }
  return null;
}

async function detectPythonTestRunner(root: string): Promise<TestRunner | null> {
  // Check for pytest indicators
  const indicators = ["conftest.py", "pytest.ini"];
  for (const file of indicators) {
    try {
      await fs.access(path.join(root, file));
      return {
        name: "pytest",
        framework: "pytest",
        root,
        command: "python -m pytest --tb=short -q",
      };
    } catch {
      // Not found
    }
  }

  // Check pyproject.toml for pytest config
  try {
    const content = await fs.readFile(path.join(root, "pyproject.toml"), "utf-8");
    if (content.includes("[tool.pytest") || content.includes("pytest")) {
      return {
        name: "pytest",
        framework: "pytest",
        root,
        command: "python -m pytest --tb=short -q",
      };
    }
  } catch {
    // No pyproject.toml
  }

  return null;
}
