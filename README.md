# CodeGraph MCP

Give GitHub Copilot **deep structural understanding** of your codebase — not just text search, but AST-level code intelligence via [CodeGraph](https://github.com/colbymchenry/codegraph) MCP.

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

- 🚀 **Zero-config** — registers the MCP server on startup. No CLI probing, no `mcp.json`, no readiness gate
- 🛠️ **Command palette** — `Initialize Project` and `Force Re-index` right from VS Code, with progress and cancellation
- 📜 **Output channel** — `init` and `sync` stream their output to the "CodeGraph" channel
- 👆 **Status bar** — shows ready / not initialized / CLI not found; click for the actions menu
- 🔒 **Safe by construction** — the CLI is spawned directly, never through a shell; disabled in untrusted workspaces
- 🌐 **Cross-platform** — macOS, Linux, Windows
- 📦 **Lightweight** — zero runtime dependencies, ~7KB bundled

## Commands

| Command | Description |
|---------|-------------|
| `CodeGraph: Restart MCP Server` | Re-publish the MCP definition so VS Code drops its cached connection |
| `CodeGraph: Initialize Project` | Run `codegraph init` for the current workspace |
| `CodeGraph: Force Re-index` | Run `codegraph sync` to re-index the project |

Access via `Cmd+Shift+P` / `Ctrl+Shift+P`, or by clicking the status bar item.

## How It Works

1. **Register MCP** — on startup, `vscode.lm.registerMcpServerDefinitionProvider` exposes `codegraph serve --mcp` to Copilot. VS Code inherits your shell's `PATH`, so spawning `codegraph` just works; `codegraph.path` overrides it
2. **Report status** — `codegraph status --json` decides between *ready* and *not initialized*, falling back to the presence of `.codegraph/` if the CLI is unusable. A spawn failure surfaces as *CLI not found*, with a shortcut to the setting
3. **Stay current** — status is re-checked after `init` / `sync` and when the workspace folder changes, and the MCP definition is re-published so stale connections are discarded

The daemon lifecycle belongs to `codegraph serve --mcp`, so the extension never prewarms, verifies, or respawns it.

## Installation

### Prerequisites

- VS Code ^1.106.0 with GitHub Copilot
- [CodeGraph CLI](https://github.com/colbymchenry/codegraph): `npm install -g @colbymchenry/codegraph`

### Install the Extension

**From [Releases](https://github.com/bsantos/codegraph-auto-mcp/releases):**
1. Download the latest `.vsix`
2. VS Code → **Extensions: Install from VSIX...** → select the file

**From source:**
```bash
git clone https://github.com/bsantos/codegraph-auto-mcp.git
cd codegraph-auto-mcp
npm install && npm run build
code --install-extension codegraph-mcp-*.vsix
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

CLI discovery is deliberately trivial: `codegraph.path` when set, otherwise the bare `codegraph` command resolved from the `PATH` VS Code inherits. Every invocation is a direct `child_process.spawn` with `shell: false`, so workspace paths and arguments are never re-interpreted by a shell.

### Building

```bash
npm run compile    # typecheck + esbuild bundle
npm run watch      # dev mode with file watcher
npm test           # integration tests in a real VS Code instance
npm run package    # build a .vsix
npm run release    # bump version + tag (standard-version)
npm run publish    # release + publish to Marketplace
```

## License

MIT
