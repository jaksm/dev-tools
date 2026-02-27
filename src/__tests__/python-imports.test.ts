import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Parser from "web-tree-sitter";
import { extractImports } from "../core/tree-sitter/imports.js";
import { TreeSitterEngine } from "../core/tree-sitter/engine.js";

describe("Python import resolution", () => {
  let tmpDir: string;
  let engine: TreeSitterEngine;
  let parser: Parser;

  beforeAll(async () => {
    engine = new TreeSitterEngine();
    await engine.init();
    const p = await engine.createParser("python");
    parser = p!;
  });

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "dt-pyimport-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFiles(files: Record<string, string>) {
    for (const [filePath, content] of Object.entries(files)) {
      const full = path.join(tmpDir, filePath);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, content, "utf-8");
    }
  }

  function parse(source: string, filePath: string) {
    const tree = parser.parse(source);
    return extractImports(tree, "python", filePath, { workspaceDir: tmpDir });
  }

  it("resolves relative import from same package", async () => {
    await writeFiles({
      "pkg/__init__.py": "",
      "pkg/utils.py": "X = 1",
      "pkg/main.py": "",
    });

    const imports = parse(
      'from .utils import X',
      path.join(tmpDir, "pkg/main.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].source).toBe(".utils");
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/utils.py"));
    expect(imports[0].isRelative).toBe(true);
    expect(imports[0].names).toContain("X");
  });

  it("resolves parent-relative import (..)", async () => {
    await writeFiles({
      "pkg/__init__.py": "",
      "pkg/models.py": "class User: pass",
      "pkg/sub/__init__.py": "",
      "pkg/sub/handler.py": "",
    });

    const imports = parse(
      'from ..models import User',
      path.join(tmpDir, "pkg/sub/handler.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/models.py"));
    expect(imports[0].isRelative).toBe(true);
  });

  it("resolves double-parent relative import (... )", async () => {
    await writeFiles({
      "pkg/__init__.py": "",
      "pkg/core.py": "Z = 1",
      "pkg/a/__init__.py": "",
      "pkg/a/b/__init__.py": "",
      "pkg/a/b/deep.py": "",
    });

    const imports = parse(
      'from ...core import Z',
      path.join(tmpDir, "pkg/a/b/deep.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/core.py"));
  });

  it("resolves 'from . import X' to __init__.py", async () => {
    await writeFiles({
      "pkg/__init__.py": "VERSION = '1.0'",
      "pkg/main.py": "",
    });

    const imports = parse(
      'from . import VERSION',
      path.join(tmpDir, "pkg/main.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/__init__.py"));
  });

  it("resolves absolute import from workspace root", async () => {
    await writeFiles({
      "myapp/__init__.py": "",
      "myapp/cli/__init__.py": "",
      "myapp/cli/dicts.py": "class HTTPHeadersDict: pass",
      "myapp/output/writer.py": "",
    });

    const imports = parse(
      'from myapp.cli.dicts import HTTPHeadersDict',
      path.join(tmpDir, "myapp/output/writer.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "myapp/cli/dicts.py"));
    expect(imports[0].isRelative).toBe(true); // resolved = treated as internal
  });

  it("resolves absolute import to __init__.py package", async () => {
    await writeFiles({
      "myapp/__init__.py": "",
      "myapp/plugins/__init__.py": "class BasePlugin: pass",
      "myapp/core.py": "",
    });

    const imports = parse(
      'from myapp.plugins import BasePlugin',
      path.join(tmpDir, "myapp/core.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "myapp/plugins/__init__.py"));
  });

  it("leaves unresolvable external imports as-is", async () => {
    const imports = parse(
      'import requests\nfrom typing import Dict\nfrom os.path import join',
      path.join(tmpDir, "main.py"),
    );

    expect(imports).toHaveLength(3);
    for (const imp of imports) {
      expect(imp.resolved).toBeNull();
      expect(imp.isRelative).toBe(false);
    }
  });

  it("resolves 'import pkg.module' absolute style", async () => {
    await writeFiles({
      "myapp/__init__.py": "",
      "myapp/config.py": "DEBUG = True",
      "main.py": "",
    });

    const imports = parse(
      'import myapp.config',
      path.join(tmpDir, "main.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "myapp/config.py"));
  });

  it("handles multi-name from import", async () => {
    await writeFiles({
      "pkg/__init__.py": "",
      "pkg/models.py": "",
      "pkg/main.py": "",
    });

    const imports = parse(
      'from .models import User, Post, Comment',
      path.join(tmpDir, "pkg/main.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].names).toEqual(["User", "Post", "Comment"]);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/models.py"));
  });

  it("handles relative import to subpackage", async () => {
    await writeFiles({
      "pkg/__init__.py": "",
      "pkg/sub/__init__.py": "",
      "pkg/sub/tools.py": "helper = 1",
      "pkg/main.py": "",
    });

    const imports = parse(
      'from .sub.tools import helper',
      path.join(tmpDir, "pkg/main.py"),
    );

    expect(imports).toHaveLength(1);
    expect(imports[0].resolved).toBe(path.join(tmpDir, "pkg/sub/tools.py"));
  });
});
