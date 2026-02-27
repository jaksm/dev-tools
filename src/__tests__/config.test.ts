import { describe, it, expect, afterEach } from "vitest";
import { resolveConfig, validateConfig } from "../core/config.js";

describe("resolveConfig", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("DEV_TOOLS_")) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, origEnv);
  });

  it("returns defaults when no config provided", () => {
    const config = resolveConfig();
    expect(config.search?.provider).toBe("local");
    expect(config.search?.model).toBe("Xenova/all-MiniLM-L6-v2");
    expect(config.shell?.defaultTimeout).toBe(120000);
    expect(config.tokenBudget?.maxResponseTokens).toBe(4000);
    expect(config.lsp?.maxRestartAttempts).toBe(3);
    expect(config.lsp?.debug).toBe(false);
  });

  it("merges plugin config over defaults", () => {
    const config = resolveConfig({
      shell: { defaultTimeout: 60000 },
      tokenBudget: { maxResponseTokens: 8000 },
    });
    expect(config.shell?.defaultTimeout).toBe(60000);
    expect(config.tokenBudget?.maxResponseTokens).toBe(8000);
    // Defaults preserved for unset values
    expect(config.search?.provider).toBe("local");
  });

  it("env vars override plugin config", () => {
    process.env.DEV_TOOLS_SHELL_TIMEOUT = "30000";
    process.env.DEV_TOOLS_LSP_DEBUG = "true";
    process.env.DEV_TOOLS_TOKEN_BUDGET = "2000";
    process.env.DEV_TOOLS_SEARCH_PROVIDER = "api";

    const config = resolveConfig({
      shell: { defaultTimeout: 60000 },
    });

    expect(config.shell?.defaultTimeout).toBe(30000); // env wins over plugin config
    expect(config.lsp?.debug).toBe(true);
    expect(config.tokenBudget?.maxResponseTokens).toBe(2000);
    expect(config.search?.provider).toBe("api");
  });

  it("handles DEV_TOOLS_SHELL_TIMEOUT env override", () => {
    process.env.DEV_TOOLS_SHELL_TIMEOUT = "60000";
    const config = resolveConfig();
    expect(config.shell?.defaultTimeout).toBe(60000);
    delete process.env.DEV_TOOLS_SHELL_TIMEOUT;
  });

  it("preserves roots from plugin config", () => {
    const config = resolveConfig({
      roots: [{ path: "packages/frontend", language: "typescript" }],
    });
    expect(config.roots).toHaveLength(1);
    expect(config.roots![0].language).toBe("typescript");
  });
});

describe("validateConfig", () => {
  it("warns on very low shell timeout", () => {
    const warnings = validateConfig({ shell: { defaultTimeout: 1000 } });
    expect(warnings.some(w => w.includes("very low"))).toBe(true);
  });

  it("warns on very high shell timeout", () => {
    const warnings = validateConfig({ shell: { defaultTimeout: 900000 } });
    expect(warnings.some(w => w.includes("very high"))).toBe(true);
  });

  it("warns on very low token budget", () => {
    const warnings = validateConfig({ tokenBudget: { maxResponseTokens: 100 } });
    expect(warnings.some(w => w.includes("very low"))).toBe(true);
  });

  it("warns on zero restart attempts", () => {
    const warnings = validateConfig({ lsp: { maxRestartAttempts: 0 } });
    expect(warnings.some(w => w.includes("< 1"))).toBe(true);
  });

  it("returns empty array for valid config", () => {
    const warnings = validateConfig({
      shell: { defaultTimeout: 120000 },
      tokenBudget: { maxResponseTokens: 4000 },
      lsp: { maxRestartAttempts: 3 },
    });
    expect(warnings).toHaveLength(0);
  });
});
