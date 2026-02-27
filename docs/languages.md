# Supported Languages

## Language Matrix

| Language | Extensions | Tree-sitter | Symbols | Imports | Semantic Search | LSP Server | LSP Features |
|---|---|---|---|---|---|---|---|
| TypeScript | `.ts`, `.tsx` | ✅ | ✅ | ✅ | ✅ | `typescript-language-server` | hover, definition, references, rename, diagnostics, code actions |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | ✅ | ✅ | ✅ | ✅ | `typescript-language-server` | hover, definition, references, rename, diagnostics, code actions |
| Python | `.py` | ✅ | ✅ | ✅ | ✅ | `pyright-langserver` | hover, definition, references, rename, diagnostics, code actions |
| Rust | `.rs` | ✅ | ✅ | ✅ | ✅ | `rust-analyzer` | hover, definition, references, rename, diagnostics, code actions |
| Go | `.go` | ✅ | ✅ | ✅ | ✅ | `gopls` | hover, definition, references, rename, diagnostics, code actions |
| Swift | `.swift` | ✅ | ✅ | ✅ | ✅ | `sourcekit-lsp` | hover, definition, references, rename, diagnostics, code actions |
| Java | `.java` | ✅ | ✅ | ✅ | ✅ | — | — |
| Kotlin | `.kt`, `.kts` | ✅ | ✅ | ✅ | ✅ | — | — |
| C# | `.cs` | ✅ | ✅ | ✅ | ✅ | — | — |
| JSON | `.json` | ✅ | — | — | — | — | — |
| HTML | `.html`, `.htm` | ✅ | — | — | — | — | — |
| CSS | `.css`, `.scss` | ✅ | — | — | — | — | — |
| Bash | `.sh`, `.bash` | ✅ | — | — | — | — | — |

**Tree-sitter:** Parse trees for syntax analysis  
**Symbols:** Function, class, method, interface, type extraction  
**Imports:** Import/export parsing with path resolution  
**Semantic Search:** Embedding vectors for meaning-based search  
**LSP:** Compiler-accurate type info, references, refactoring  

## Language Detection

Languages are auto-detected from project configuration files:

| Config File | Language | Root |
|---|---|---|
| `tsconfig.json` | TypeScript | Directory containing tsconfig |
| `package.json` (with JS/TS files) | JavaScript/TypeScript | Directory containing package.json |
| `Cargo.toml` | Rust | Directory containing Cargo.toml |
| `go.mod` | Go | Directory containing go.mod |
| `Package.swift` | Swift | Directory containing Package.swift |
| `pyproject.toml`, `setup.py`, `requirements.txt` | Python | Directory containing config |
| `pom.xml`, `build.gradle` | Java/Kotlin | Directory containing build file |
| `*.csproj`, `*.sln` | C# | Directory containing project file |

For monorepos, multiple language roots can be detected. Override with the `roots` config:

```json
"roots": [
  { "path": "packages/api", "language": "typescript" },
  { "path": "packages/ml", "language": "python" }
]
```

## Test Runner Detection

| Config/File | Framework | Command |
|---|---|---|
| `vitest` in package.json deps | Vitest | `npx vitest run` |
| `jest` in package.json deps | Jest | `npx jest` |
| `pytest.ini`, `pyproject.toml` (with pytest) | pytest | `pytest` |
| `Cargo.toml` | cargo test | `cargo test` |
| `Package.swift` | swift test | `swift test` |
| `go.mod` | go test | `go test` |

## Installing LSP Servers

```bash
# TypeScript/JavaScript
npm i -g typescript-language-server typescript

# Python
npm i -g pyright

# Rust
rustup component add rust-analyzer

# Go
go install golang.org/x/tools/gopls@latest

# Swift (ships with Xcode)
xcode-select --install
```

LSP servers are detected at runtime. Install via `shell` tool and use immediately — no restart needed. The LSP manager invalidates its binary cache after every shell command.

## Without LSP

If no LSP server is installed for a language, the following tools still work via tree-sitter + symbol index:

- `code_outline` — full symbol hierarchy
- `code_read` — symbol source code with imports and context
- `code_search` — semantic and text search
- `code_inspect` — symbol info from index (no type info or references)

These tools are unavailable without LSP:
- `code_diagnose` (diagnostics action) — no error/warning data
- `code_refactor` — requires LSP for rename, organize imports, apply fix
- `code_inspect` references — no cross-file reference tracking

`code_diagnose { action: "health" }` always works and shows which engines are available.

## Path Alias Support (TypeScript)

TypeScript path aliases from `tsconfig.json` are resolved during import extraction:

```json
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["src/*"],
      "@utils": ["src/utils/index"]
    }
  }
}
```

Supports:
- Wildcard aliases (`@/*` → `src/*`)
- Exact aliases (`@utils` → `src/utils/index`)
- `baseUrl` resolution
- `extends` inheritance (child paths override parent)
- JSON comments in tsconfig

This enables accurate import graph building for projects using path aliases.
