/**
 * Configuration resolution with environment variable overrides.
 * 
 * Config hierarchy (highest wins):
 * 1. Environment variables (DEV_TOOLS_*)
 * 2. Plugin config from openclaw.json
 * 3. Defaults
 */

import type { DevToolsConfig } from "./types.js";

const DEFAULTS: Required<Pick<DevToolsConfig, "shell" | "tokenBudget">> & {
  search: { provider: string; model: string; reindexDebounceMs: number };
  lsp: { healthCheckIntervalMs: number; maxRestartAttempts: number; debug: boolean };
  index: { maxFileSize: string };
} = {
  search: {
    provider: "local",
    model: "Xenova/all-MiniLM-L6-v2",
    reindexDebounceMs: 2000,
  },
  lsp: {
    healthCheckIntervalMs: 30000,
    maxRestartAttempts: 3,
    debug: false,
  },
  index: {
    maxFileSize: "256KB",
  },
  shell: {
    defaultTimeout: 120000,
    blocklist: [],
  },
  tokenBudget: {
    maxResponseTokens: 4000,
  },
};

/**
 * Environment variable mapping.
 * DEV_TOOLS_SEARCH_PROVIDER → search.provider
 * DEV_TOOLS_SEARCH_MODEL → search.model
 * DEV_TOOLS_LSP_MAX_RESTARTS → lsp.maxRestartAttempts
 * DEV_TOOLS_LSP_DEBUG → lsp.debug
 * DEV_TOOLS_SHELL_TIMEOUT → shell.defaultTimeout
 * (jail removed)
 * DEV_TOOLS_TOKEN_BUDGET → tokenBudget.maxResponseTokens
 */
function applyEnvOverrides(config: DevToolsConfig): DevToolsConfig {
  const env = process.env;

  if (env.DEV_TOOLS_SEARCH_PROVIDER) {
    config.search = config.search ?? {};
    config.search.provider = env.DEV_TOOLS_SEARCH_PROVIDER as "local" | "api";
  }
  if (env.DEV_TOOLS_SEARCH_MODEL) {
    config.search = config.search ?? {};
    config.search.model = env.DEV_TOOLS_SEARCH_MODEL;
  }
  if (env.DEV_TOOLS_LSP_MAX_RESTARTS) {
    config.lsp = config.lsp ?? {};
    config.lsp.maxRestartAttempts = parseInt(env.DEV_TOOLS_LSP_MAX_RESTARTS, 10);
  }
  if (env.DEV_TOOLS_LSP_DEBUG) {
    config.lsp = config.lsp ?? {};
    config.lsp.debug = env.DEV_TOOLS_LSP_DEBUG === "true" || env.DEV_TOOLS_LSP_DEBUG === "1";
  }
  if (env.DEV_TOOLS_SHELL_TIMEOUT) {
    config.shell = config.shell ?? {};
    config.shell.defaultTimeout = parseInt(env.DEV_TOOLS_SHELL_TIMEOUT, 10);
  }
  // jail env removed — no longer supported
  if (env.DEV_TOOLS_TOKEN_BUDGET) {
    config.tokenBudget = config.tokenBudget ?? {};
    config.tokenBudget.maxResponseTokens = parseInt(env.DEV_TOOLS_TOKEN_BUDGET, 10);
  }

  return config;
}

/**
 * Resolve final config: defaults → plugin config → env overrides.
 */
export function resolveConfig(pluginConfig?: Record<string, unknown>): DevToolsConfig {
  const config: DevToolsConfig = {
    search: {
      ...DEFAULTS.search,
      ...((pluginConfig?.search as Record<string, unknown>) ?? {}),
    } as DevToolsConfig["search"],
    lsp: {
      ...DEFAULTS.lsp,
      ...((pluginConfig?.lsp as object) ?? {}),
    },
    index: {
      ...DEFAULTS.index,
      ...((pluginConfig?.index as object) ?? {}),
    },
    shell: {
      ...DEFAULTS.shell,
      ...((pluginConfig?.shell as object) ?? {}),
    },
    tokenBudget: {
      ...DEFAULTS.tokenBudget,
      ...((pluginConfig?.tokenBudget as object) ?? {}),
    },
    roots: (pluginConfig?.roots as DevToolsConfig["roots"]) ?? undefined,
  };

  return applyEnvOverrides(config);
}

/**
 * Validate configuration and return warnings for questionable values.
 */
export function validateConfig(config: DevToolsConfig): string[] {
  const warnings: string[] = [];

  if (config.shell?.defaultTimeout && config.shell.defaultTimeout < 5000) {
    warnings.push("shell.defaultTimeout is very low (<5s) — most commands will timeout");
  }
  if (config.shell?.defaultTimeout && config.shell.defaultTimeout > 600000) {
    warnings.push("shell.defaultTimeout is very high (>10min) — hung commands will block for a long time");
  }
  if (config.tokenBudget?.maxResponseTokens && config.tokenBudget.maxResponseTokens < 500) {
    warnings.push("tokenBudget.maxResponseTokens is very low (<500) — most tool responses will be truncated");
  }
  if (config.lsp?.maxRestartAttempts != null && config.lsp.maxRestartAttempts < 1) {
    warnings.push("lsp.maxRestartAttempts < 1 — LSP servers won't attempt recovery after crashes");
  }

  return warnings;
}
