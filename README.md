# CodeGraph Auto MCP

Give GitHub Copilot **deep structural understanding** of your codebase — not just text search, but AST-level code intelligence via [CodeGraph](https://github.com/svenzhao/codegraph) MCP.

This extension auto-registers the CodeGraph MCP server for Copilot. No manual `mcp.json` editing, no path headaches, no config files to maintain.

## ⚡ Quick Start

```bash
# 1. Install CodeGraph CLI
npm install -g @colbymchenry/codegraph
```

```
# 2. Install this extension (VSIX from Releases, or build from source)
# 3. Open any project → Ctrl+Shift+P → "CodeGraph: Initialize Project"
# 4. Done! Copilot now understands your codebase structurally.
```

Once initialized, Copilot gains tools like `codegraph_explore` that let it navigate call graphs, trace data flow, and understand cross-file dependencies — far beyond what text-based context can provide.

## Why Use This?

**Without CodeGraph MCP**, Copilot sees your code as text. It can grep for symbols, read files you point it to, and guess at relationships.

**With CodeGraph MCP**, Copilot gets a pre-built knowledge graph of your entire codebase:
- **Call graphs** — who calls this function, and what calls them?
- **Data flow** — where does this value come from, and where does it end up?
- **Cross-file understanding** — dependencies, re-exports, type propagation across modules
- **Blast radius analysis** — what breaks if I change this symbol?

The result: more accurate answers, fewer hallucinated APIs, and edits that actually respect your codebase's architecture.

## Features

- 🚀 **Zero-config** — installs and works. Automatically finds the CLI, detects workspace paths, registers MCP with Copilot
- 🔄 **Self-healing** — smart retry (2s/5s/10s) handles shell environment race conditions on startup
- 👁️ **Auto-detect init** — file watcher picks up when you run `codegraph init` or `codegraph sync`, no restart needed
- 🛠️ **Command palette** — `Initialize Project` and `Force Re-index` right from VS Code
- 👆 **Status bar** — always shows current state; click to retry or access commands
- 🌐 **Cross-platform** — macOS, Linux, Windows (auto-detects `codegraph.cmd`)
- 📦 **Lightweight** — zero runtime dependencies, ~20KB bundled

## Commands

| Command | Description |
|---------|-------------|
| `CodeGraph: Restart MCP Server` | Full re-check: find CLI, verify init, register MCP |
| `CodeGraph: Initialize Project` | Run `codegraph init` for the current workspace |
| `CodeGraph: Force Re-index` | Run `codegraph sync` to re-index the project |

Access via `Cmd+Shift+P` / `Ctrl+Shift+P`.

## How It Works

The extension runs a simple state machine on startup:

1. **Find CLI** — searches PATH, shell environment, nvm/fnm/volta/asdf dirs, and common install locations
2. **Check init** — runs `codegraph status` to see if `.codegraph/` exists and is valid
3. **Warm up daemon** — pre-spawns the codegraph daemon to avoid cold-start latency on first Copilot call
4. **Register MCP** — calls `vscode.lm.registerMcpServerDefinitionProvider` to expose tools to Copilot

If any step fails, the status bar shows the issue. A file watcher on `.codegraph/` auto-recovers when you run `codegraph init` or `codegraph sync` in a terminal.

## Installation

### Prerequisites

- VS Code ^1.106.0 with GitHub Copilot
- [CodeGraph CLI](https://github.com/svenzhao/codegraph): `npm install -g @sven/codegraph`

### Install the Extension

**From [Releases](https://github.com/svenzhao/codegraph-auto-mcp/releases):**
1. Download the latest `.vsix`
2. VS Code → **Extensions: Install from VSIX...** → select the file

**From source:**
```bash
git clone https://github.com/svenzhao/codegraph-auto-mcp.git
cd codegraph-auto-mcp
npm install && npm run build
code --install-extension codegraph-auto-mcp-*.vsix
```

## For Developers

### Architecture

Uses the official VS Code API `vscode.lm.registerMcpServerDefinitionProvider` — the same pattern as GitLens for its MCP server:

```typescript
vscode.lm.registerMcpServerDefinitionProvider("codegraph", {
  provideMcpServerDefinitions(_token) {
    return [
      new vscode.McpStdioServerDefinition(
        "CodeGraph",
        codegraphPath,
        ["serve", "--mcp", "--path", workspaceRoot],
      ),
    ];
  },
});
```

CLI discovery uses a 7-layer fallback: user config → cached path → `PATH` → npm prefix → node version managers (nvm/fnm/volta/asdf/n) → common dirs → shell `command -v`.

### Building

```bash
npm run build      # typecheck + esbuild bundle
npm run watch      # dev mode with file watcher
npm run release    # bump version + tag (standard-version)
npm run publish    # release + publish to Marketplace
```

## License

MIT
