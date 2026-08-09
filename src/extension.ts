import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";

let _mcpDisposable: vscode.Disposable | undefined;
let _statusBar: vscode.StatusBarItem;
let _root: string | undefined;
let _context: vscode.ExtensionContext | undefined;
let _mcpChangeEmitter: vscode.EventEmitter<void> | undefined;
let _extensionVersion = "0.0.0";
let _mcpVersion = "1.0.0";
let _initTerminal: vscode.Terminal | undefined;
let _activated = false;

/** The command to launch codegraph — either the user's custom path or just "codegraph". */
function codegraphCmd(): string {
  const cfg = vscode.workspace.getConfiguration("codegraph").get<string>("path");
  return cfg || "codegraph";
}

export function activate(context: vscode.ExtensionContext) {
  _context = context;
  _extensionVersion = context.extension?.packageJSON?.version ?? "0.0.0";
  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  // Register commands EARLY — always available
  context.subscriptions.push(
    vscode.commands.registerCommand("codegraph.restart", () => doRestart()),
    vscode.commands.registerCommand("codegraph.initProject", () => doInit()),
    vscode.commands.registerCommand("codegraph.sync", () => doSync()),
    vscode.commands.registerCommand("codegraph.showMenu", () => doShowMenu()),
  );

  _root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!_root) {
    _statusBar.text = "$(warning) CodeGraph: No workspace";
    _statusBar.tooltip = "No workspace opened";
    _statusBar.show();
    return;
  }

  // Start immediately — VS Code inherits the shell's PATH (zsh -i -l -c),
  // so spawning "codegraph" just works. No file lookup, no process validation,
  // no Copilot dependency.
  doActivate();
}

function doActivate() {
  if (_activated) { return; }
  _activated = true;
  doRegisterMcp();
  void refreshInitStatus();
}

/** Register the MCP provider. That's it — codegraph serve --mcp handles the rest. */
function doRegisterMcp() {
  if (!_root) { return; }

  // Bump version every time so VS Code discards stale cached connections
  _mcpVersion = `${_extensionVersion}+${Date.now()}`;

  _mcpDisposable?.dispose();
  _mcpChangeEmitter?.dispose();
  _mcpChangeEmitter = new vscode.EventEmitter<void>();

  _mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      onDidChangeMcpServerDefinitions: _mcpChangeEmitter.event,
      provideMcpServerDefinitions() {
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            codegraphCmd(),
            ["serve", "--mcp", "--path", _root!],
            undefined,
            _mcpVersion
          ),
        ];
      },
      // codegraph serve --mcp manages its own daemon lifecycle.
      // No need for us to prewarm, verify hello, or respawn.
      async resolveMcpServerDefinition(server: vscode.McpStdioServerDefinition) {
        return server;
      },
    }
  );

  const isInitialized = fs.existsSync(path.join(_root, ".codegraph"));
  if (isInitialized) {
    _statusBar.text = "$(check) CodeGraph: Ready";
    _statusBar.tooltip = "CodeGraph MCP registered";
    _statusBar.command = "codegraph.showMenu";
    _statusBar.backgroundColor = undefined;
    _statusBar.show();
  }
  // If not initialized, leave status bar for refreshInitStatus to update
}

/** Check if project is initialized — status bar display only. */
async function refreshInitStatus() {
  if (!_root) { return; }
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      cp.execFile(codegraphCmd(), ["status", _root!, "--json"], {
        encoding: "utf-8",
        timeout: 5000,
      }, (err, out) => {
        if (err) { reject(err); } else { resolve(out); }
      });
    });
    const result = JSON.parse(stdout);
    if (!result.initialized) {
      _statusBar.text = "$(info) CodeGraph: Not initialized";
      _statusBar.tooltip = "Project not initialized — click to open the actions menu";
      _statusBar.command = "codegraph.showMenu";
      _statusBar.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      _statusBar.show();
    }
  } catch {
    // Status check failed — leave whatever doRegisterMcp set
  }
}

async function doRestart() {
  _mcpDisposable?.dispose();
  _mcpChangeEmitter?.dispose();
  doRegisterMcp();
  vscode.window.showInformationMessage("CodeGraph: MCP server restarted");
}

async function doInit() {
  if (!_root) { return; }
  try { _initTerminal?.dispose(); } catch { /* ignore */ }
  _initTerminal = vscode.window.createTerminal("CodeGraph Init");
  _initTerminal.sendText(`cd "${_root}" && ${codegraphCmd()} init`);
  _initTerminal.show();

  // Watch for .codegraph directory creation (init completion)
  const codegraphDir = path.join(_root, ".codegraph");
  let initHandled = false;
  const watcher = fs.watch(_root, async (_eventType, filename) => {
    if (initHandled) { return; }
    if (filename && filename !== ".codegraph" && !filename.startsWith(".codegraph")) {
      return;
    }
    if (fs.existsSync(codegraphDir)) {
      initHandled = true;
      watcher.close();
      try { _initTerminal?.dispose(); } catch { /* ignore */ }
      _initTerminal = undefined;
      await new Promise(r => setTimeout(r, 1000));
      _statusBar.text = "$(check) CodeGraph: Initialized";
      _statusBar.tooltip = "Registering MCP...";
      _statusBar.show();
      const action = await vscode.window.showInformationMessage(
        "CodeGraph: Project initialized. Register MCP?",
        "Register"
      );
      if (action === "Register") {
        doRegisterMcp();
      }
    }
  });
  setTimeout(() => {
    try { watcher.close(); } catch { /* ignore */ }
    try { _initTerminal?.dispose(); } catch { /* ignore */ }
    _initTerminal = undefined;
  }, 300_000);
}

async function doSync() {
  if (!_root) { return; }
  _statusBar.text = "$(loading~spin) CodeGraph: Syncing...";
  _statusBar.command = "codegraph.showMenu";
  _statusBar.show();
  try {
    await new Promise<void>((resolve, reject) => {
      cp.execFile(codegraphCmd(), ["sync", _root!], {
        encoding: "utf-8",
        timeout: 30000,
      }, (err) => {
        if (err) { reject(err); } else { resolve(); }
      });
    });
    _statusBar.text = "$(check) CodeGraph: Synced";
    vscode.window.showInformationMessage("CodeGraph: Index updated");
  } catch (err: any) {
    _statusBar.text = "$(error) CodeGraph: Sync failed";
    vscode.window.showErrorMessage(`CodeGraph: sync failed - ${err.message}`);
  }
  setTimeout(() => {
    const cur = _statusBar.text;
    if (cur === "$(check) CodeGraph: Synced" || cur === "$(error) CodeGraph: Sync failed") {
      _statusBar.text = "$(check) CodeGraph: Ready";
    }
  }, 3000);
}

async function doShowMenu() {
  const items: vscode.QuickPickItem[] = [
    { label: "$(sync) Restart MCP Server", description: "Re-register MCP" },
    { label: "$(repo) Initialize Project", description: "Run codegraph init" },
    { label: "$(refresh) Force Re-index", description: "Force a full re-index" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "CodeGraph actions",
  });
  if (!picked) { return; }
  if (picked.label.includes("Restart")) {
    await doRestart();
  } else if (picked.label.includes("Initialize")) {
    await doInit();
  } else if (picked.label.includes("Re-index")) {
    await doSync();
  }
}

export function deactivate() {
  _mcpDisposable?.dispose();
  _mcpDisposable = undefined;
  _mcpChangeEmitter?.dispose();
  _mcpChangeEmitter = undefined;
  _root = undefined;
  _activated = false;
}
