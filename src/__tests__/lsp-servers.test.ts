import { describe, it, expect } from "vitest";
import {
  getLspServerConfig,
  getAllServerConfigs,
  hasLspSupport,
  getSupportedLanguages,
} from "../core/lsp/servers.js";

describe("LSP server configs", () => {
  it("returns config for typescript", () => {
    const config = getLspServerConfig("typescript");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("typescript-language-server");
    expect(config!.args).toContain("--stdio");
    expect(config!.enabled).toBe(true);
    expect(config!.installHint).toBeDefined();
  });

  it("returns config for javascript (shares with typescript)", () => {
    const config = getLspServerConfig("javascript");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("typescript-language-server");
  });

  it("returns config for python", () => {
    const config = getLspServerConfig("python");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("pyright-langserver");
  });

  it("returns config for rust", () => {
    const config = getLspServerConfig("rust");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("rust-analyzer");
  });

  it("returns config for go", () => {
    const config = getLspServerConfig("go");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("gopls");
  });

  it("returns config for swift", () => {
    const config = getLspServerConfig("swift");
    expect(config).not.toBeNull();
    expect(config!.command).toBe("sourcekit-lsp");
  });

  it("returns null for unknown language", () => {
    expect(getLspServerConfig("brainfuck")).toBeNull();
    expect(getLspServerConfig("")).toBeNull();
  });

  it("applies user config overrides", () => {
    const config = getLspServerConfig("typescript", {
      lsp: {
        servers: {
          typescript: {
            command: "tsserver",
            args: ["--node-ipc"],
          },
        },
      },
    });
    expect(config).not.toBeNull();
    expect(config!.command).toBe("tsserver");
    expect(config!.args).toEqual(["--node-ipc"]);
    // Other defaults preserved
    expect(config!.enabled).toBe(true);
    expect(config!.installHint).toBeDefined();
  });

  it("allows disabling a server via config", () => {
    const config = getLspServerConfig("python", {
      lsp: {
        servers: {
          python: { enabled: false },
        },
      },
    });
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(false);
  });

  it("getAllServerConfigs returns all servers", () => {
    const all = getAllServerConfigs();
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(6);
    expect(all.typescript).toBeDefined();
    expect(all.python).toBeDefined();
    expect(all.rust).toBeDefined();
    expect(all.go).toBeDefined();
    expect(all.swift).toBeDefined();
  });

  it("hasLspSupport returns true for supported languages", () => {
    expect(hasLspSupport("typescript")).toBe(true);
    expect(hasLspSupport("javascript")).toBe(true);
    expect(hasLspSupport("python")).toBe(true);
    expect(hasLspSupport("rust")).toBe(true);
    expect(hasLspSupport("go")).toBe(true);
    expect(hasLspSupport("swift")).toBe(true);
  });

  it("hasLspSupport returns false for unsupported languages", () => {
    expect(hasLspSupport("brainfuck")).toBe(false);
    expect(hasLspSupport("")).toBe(false);
  });

  it("getSupportedLanguages returns all languages", () => {
    const langs = getSupportedLanguages();
    expect(langs).toContain("typescript");
    expect(langs).toContain("javascript");
    expect(langs).toContain("python");
    expect(langs).toContain("rust");
    expect(langs).toContain("go");
    expect(langs).toContain("swift");
  });
});
