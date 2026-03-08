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

  // ── Web Language LSP Servers ────────────────────────────────────────────

  describe("web language servers", () => {
    it("returns config for html", () => {
      const config = getLspServerConfig("html");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-html-language-server");
      expect(config!.args).toContain("--stdio");
      expect(config!.enabled).toBe(true);
      expect(config!.installHint).toContain("vscode-langservers-extracted");
    });

    it("returns config for css", () => {
      const config = getLspServerConfig("css");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-css-language-server");
      expect(config!.args).toContain("--stdio");
      expect(config!.enabled).toBe(true);
    });

    it("returns css config for scss (shared server)", () => {
      const config = getLspServerConfig("scss");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-css-language-server");
    });

    it("returns css config for less (shared server)", () => {
      const config = getLspServerConfig("less");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-css-language-server");
    });

    it("returns config for json", () => {
      const config = getLspServerConfig("json");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-json-language-server");
      expect(config!.args).toContain("--stdio");
      expect(config!.enabled).toBe(true);
    });

    it("returns json config for jsonc (shared server)", () => {
      const config = getLspServerConfig("jsonc");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("vscode-json-language-server");
    });

    it("returns config for tailwindcss", () => {
      const config = getLspServerConfig("tailwindcss");
      expect(config).not.toBeNull();
      expect(config!.command).toBe("@tailwindcss/language-server");
      expect(config!.args).toContain("--stdio");
      expect(config!.enabled).toBe(true);
      expect(config!.initTimeoutMs).toBe(20_000);
    });

    it("hasLspSupport returns true for web languages", () => {
      expect(hasLspSupport("html")).toBe(true);
      expect(hasLspSupport("css")).toBe(true);
      expect(hasLspSupport("scss")).toBe(true);
      expect(hasLspSupport("less")).toBe(true);
      expect(hasLspSupport("json")).toBe(true);
      expect(hasLspSupport("jsonc")).toBe(true);
      expect(hasLspSupport("tailwindcss")).toBe(true);
    });

    it("getSupportedLanguages includes web languages", () => {
      const langs = getSupportedLanguages();
      expect(langs).toContain("html");
      expect(langs).toContain("css");
      expect(langs).toContain("scss");
      expect(langs).toContain("less");
      expect(langs).toContain("json");
      expect(langs).toContain("jsonc");
      expect(langs).toContain("tailwindcss");
    });

    it("getAllServerConfigs includes web servers", () => {
      const all = getAllServerConfigs();
      expect(all.html).toBeDefined();
      expect(all.css).toBeDefined();
      expect(all.json).toBeDefined();
      expect(all.tailwindcss).toBeDefined();
    });

    it("user override works for web servers", () => {
      const config = getLspServerConfig("html", {
        lsp: {
          servers: {
            html: {
              command: "custom-html-server",
              enabled: false,
            },
          },
        },
      });
      expect(config).not.toBeNull();
      expect(config!.command).toBe("custom-html-server");
      expect(config!.enabled).toBe(false);
      // Defaults preserved
      expect(config!.args).toContain("--stdio");
      expect(config!.installHint).toContain("vscode-langservers-extracted");
    });

    it("user override works for css server affecting scss", () => {
      const config = getLspServerConfig("scss", {
        lsp: {
          servers: {
            css: { enabled: false },
          },
        },
      });
      expect(config).not.toBeNull();
      expect(config!.enabled).toBe(false);
      expect(config!.command).toBe("vscode-css-language-server");
    });
  });
});
