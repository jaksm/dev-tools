/**
 * Mock LSP server for testing — speaks JSON-RPC over stdio.
 * Usage: node mock-lsp-server.mjs [--crash-after-init] [--slow-init N] [--hang-on-init] [--crash-on-hover] [--ignore-shutdown]
 */

import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-languageserver-protocol/node.js";

const args = process.argv.slice(2);
const crashAfterInit = args.includes("--crash-after-init");
const slowInitArg = args.indexOf("--slow-init");
const slowInitMs = slowInitArg >= 0 ? parseInt(args[slowInitArg + 1] || "0") : 0;
const ignoreShutdown = args.includes("--ignore-shutdown");
const crashOnHover = args.includes("--crash-on-hover");
const hangOnInit = args.includes("--hang-on-init");

const connection = createProtocolConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);

const openDocs = new Map();

// Initialize
connection.onRequest("initialize", async (params) => {
  if (hangOnInit) {
    return new Promise(() => {}); // Never resolves
  }
  if (slowInitMs > 0) {
    await new Promise(r => setTimeout(r, slowInitMs));
  }
  return {
    capabilities: {
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      codeActionProvider: {
        codeActionKinds: ["quickfix", "source.organizeImports"],
      },
      textDocumentSync: 1,
    },
  };
});

connection.onNotification("initialized", () => {
  if (crashAfterInit) {
    setTimeout(() => process.exit(1), 50);
  }
});

connection.onRequest("shutdown", () => {
  if (ignoreShutdown) {
    return new Promise(() => {}); // Never resolves — simulates hung shutdown
  }
  return null;
});

connection.onNotification("exit", () => {
  process.exit(0);
});

// Document sync
connection.onNotification("textDocument/didOpen", (params) => {
  openDocs.set(params.textDocument.uri, params.textDocument.text);
  // Push diagnostics after open (simulates real LSP behavior)
  setTimeout(() => {
    connection.sendNotification("textDocument/publishDiagnostics", {
      uri: params.textDocument.uri,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          message: "Mock diagnostic: unused variable",
          severity: 2, // warning
          source: "mock-lsp",
          code: "mock-001",
        },
      ],
    });
  }, 50);
});

connection.onNotification("textDocument/didChange", (params) => {
  if (params.contentChanges.length > 0) {
    const change = params.contentChanges[0];
    if ("text" in change) {
      openDocs.set(params.textDocument.uri, change.text);
      // Push fresh diagnostics after change
      setTimeout(() => {
        connection.sendNotification("textDocument/publishDiagnostics", {
          uri: params.textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
              message: "Mock diagnostic after edit: check types",
              severity: 1, // error
              source: "mock-lsp",
              code: "mock-002",
            },
          ],
        });
      }, 50);
    }
  }
});

connection.onNotification("textDocument/didClose", (params) => {
  openDocs.delete(params.textDocument.uri);
});

// Hover
connection.onRequest("textDocument/hover", (params) => {
  if (crashOnHover) {
    process.exit(1);
  }
  return {
    contents: {
      kind: "markdown",
      value: `**Hover** at ${params.position.line}:${params.position.character}`,
    },
  };
});

// Definition
connection.onRequest("textDocument/definition", (params) => {
  return {
    uri: params.textDocument.uri,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 10 },
    },
  };
});

// References
connection.onRequest("textDocument/references", (params) => {
  return [
    {
      uri: params.textDocument.uri,
      range: {
        start: { line: params.position.line, character: 0 },
        end: { line: params.position.line, character: 5 },
      },
    },
    {
      uri: params.textDocument.uri,
      range: {
        start: { line: params.position.line + 1, character: 0 },
        end: { line: params.position.line + 1, character: 5 },
      },
    },
  ];
});

// Rename
connection.onRequest("textDocument/rename", (params) => {
  return {
    changes: {
      [params.textDocument.uri]: [
        {
          range: {
            start: { line: params.position.line, character: 0 },
            end: { line: params.position.line, character: 5 },
          },
          newText: params.newName,
        },
      ],
    },
  };
});

// Code Action
connection.onRequest("textDocument/codeAction", (params) => {
  return [
    {
      title: "Fix import",
      kind: "quickfix",
      diagnostics: [],
      edit: {
        changes: {
          [params.textDocument.uri]: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
              },
              newText: "import { something } from 'somewhere';\n",
            },
          ],
        },
      },
    },
  ];
});

connection.listen();
