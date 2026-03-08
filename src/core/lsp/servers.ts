/**
 * LSP Server Definitions — per-language server configurations.
 *
 * Defines command, args, init options, and install hints for each supported
 * language server. Configurable via plugin config overrides.
 */

import type { DevToolsConfig } from "../types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LspServerDefinition {
  /** Server binary command */
  command: string;
  /** Command arguments */
  args: string[];
  /** Whether this server is enabled */
  enabled: boolean;
  /** Environment variables for the server process */
  env?: Record<string, string>;
  /** Init timeout in ms */
  initTimeoutMs?: number;
  /** Request timeout in ms */
  requestTimeoutMs?: number;
  /** Human-readable install hint */
  installHint?: string;
  /** Languages this server handles */
  languages: string[];
}

// ── Default Server Configs ──────────────────────────────────────────────────

const DEFAULT_SERVERS: Record<string, LspServerDefinition> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    installHint: "npm install -g typescript-language-server typescript",
    languages: ["typescript", "javascript"],
  },

  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    installHint: "npm install -g pyright",
    languages: ["python"],
  },

  rust: {
    command: "rust-analyzer",
    args: [],
    enabled: true,
    initTimeoutMs: 60_000, // Rust projects can be slow to initialize
    requestTimeoutMs: 30_000,
    installHint: "rustup component add rust-analyzer",
    languages: ["rust"],
  },

  go: {
    command: "gopls",
    args: ["serve"],
    enabled: true,
    initTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    installHint: "go install golang.org/x/tools/gopls@latest",
    languages: ["go"],
  },

  swift: {
    command: "sourcekit-lsp",
    args: [],
    enabled: true,
    initTimeoutMs: 30_000,
    requestTimeoutMs: 15_000,
    installHint: "Included with Xcode. Ensure Xcode command line tools are installed: xcode-select --install",
    languages: ["swift"],
  },

  java: {
    command: "jdtls",
    args: [],
    enabled: true,
    initTimeoutMs: 60_000, // Java language server is slow to start
    requestTimeoutMs: 30_000,
    installHint: "brew install jdtls (macOS) or see https://github.com/eclipse-jdtls/eclipse.jdt.ls",
    languages: ["java"],
  },

  kotlin: {
    command: "kotlin-language-server",
    args: [],
    enabled: true,
    initTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
    installHint: "See https://github.com/fwcd/kotlin-language-server",
    languages: ["kotlin"],
  },

  csharp: {
    command: "OmniSharp",
    args: ["-lsp", "--stdio"],
    enabled: true,
    initTimeoutMs: 60_000,
    requestTimeoutMs: 30_000,
    installHint: "See https://github.com/OmniSharp/omnisharp-roslyn",
    languages: ["csharp"],
  },

  html: {
    command: "vscode-html-language-server",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 15_000,
    requestTimeoutMs: 10_000,
    installHint: "npm install -g vscode-langservers-extracted",
    languages: ["html"],
  },

  css: {
    command: "vscode-css-language-server",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 15_000,
    requestTimeoutMs: 10_000,
    installHint: "npm install -g vscode-langservers-extracted",
    languages: ["css", "scss", "less"],
  },

  json: {
    command: "vscode-json-language-server",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 15_000,
    requestTimeoutMs: 10_000,
    installHint: "npm install -g vscode-langservers-extracted",
    languages: ["json", "jsonc"],
  },

  tailwindcss: {
    command: "@tailwindcss/language-server",
    args: ["--stdio"],
    enabled: true,
    initTimeoutMs: 20_000,
    requestTimeoutMs: 10_000,
    installHint: "npm install -g @tailwindcss/language-server",
    languages: ["tailwindcss"],
  },
};

// ── Language → Server mapping ───────────────────────────────────────────────

/** Maps language identifiers to server config keys */
const LANGUAGE_TO_SERVER: Record<string, string> = {};

// Build from defaults
for (const [serverKey, def] of Object.entries(DEFAULT_SERVERS)) {
  for (const lang of def.languages) {
    LANGUAGE_TO_SERVER[lang] = serverKey;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the LSP server definition for a language, applying user config overrides.
 */
export function getLspServerConfig(
  language: string,
  config?: DevToolsConfig,
): LspServerDefinition | null {
  const serverKey = LANGUAGE_TO_SERVER[language];
  if (!serverKey) return null;

  const defaults = DEFAULT_SERVERS[serverKey];
  if (!defaults) return null;

  // Apply user overrides from config
  const userOverrides = config?.lsp?.servers?.[serverKey];
  if (!userOverrides) return { ...defaults };

  return {
    ...defaults,
    ...userOverrides.command !== undefined ? { command: userOverrides.command } : {},
    ...userOverrides.args !== undefined ? { args: userOverrides.args } : {},
    ...userOverrides.enabled !== undefined ? { enabled: userOverrides.enabled } : {},
  };
}

/**
 * Get all supported language server configs (for status display).
 */
export function getAllServerConfigs(config?: DevToolsConfig): Record<string, LspServerDefinition> {
  const result: Record<string, LspServerDefinition> = {};

  for (const [key, defaults] of Object.entries(DEFAULT_SERVERS)) {
    const userOverrides = config?.lsp?.servers?.[key];
    if (!userOverrides) {
      result[key] = { ...defaults };
    } else {
      result[key] = {
        ...defaults,
        ...userOverrides.command !== undefined ? { command: userOverrides.command } : {},
        ...userOverrides.args !== undefined ? { args: userOverrides.args } : {},
        ...userOverrides.enabled !== undefined ? { enabled: userOverrides.enabled } : {},
      };
    }
  }

  return result;
}

/**
 * Check if a language has an LSP server definition available.
 */
export function hasLspSupport(language: string): boolean {
  return LANGUAGE_TO_SERVER[language] !== undefined;
}

/**
 * Get all languages supported by LSP.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_TO_SERVER);
}
