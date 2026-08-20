import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";

type Status = "unknown" | "ready" | "uninitialized" | "cli-missing" | "no-workspace";

let _mcpDisposable: vscode.Disposable | undefined;
let _mcpChangeEmitter: vscode.EventEmitter<void> | undefined;
let _statusBar: vscode.StatusBarItem | undefined;
let _output: vscode.OutputChannel | undefined;
let _root: string | undefined;
let _extensionVersion = "0.0.0";
let _mcpVersion = "";
let _status: Status = "unknown";
let _busy = false;
let _transientTimer: ReturnType<typeof setTimeout> | undefined;
let _initInProgress = false;
let _syncInProgress = false;

/** Returned from activate() outside production only, so integration tests can drive internals. */
export interface TestApi {
  codegraphCmd(): string;
  runCli(args: string[], options?: RunOptions): Promise<RunResult>;
  isCliMissing(err: unknown): boolean;
  refreshStatus(): Promise<void>;
  getStatus(): Status;
}

/** The command to launch codegraph — either the user's custom path or just "codegraph". */
function codegraphCmd(): string {
  const cfg = vscode.workspace.getConfiguration("codegraph").get<string>("path");
  return cfg?.trim() || "codegraph";
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  _extensionVersion = context.extension.packageJSON.version ?? "0.0.0";
  _root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  _statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  _output = vscode.window.createOutputChannel("CodeGraph");

  // Register commands EARLY — always available
  context.subscriptions.push(
    _statusBar,
    _output,
    vscode.commands.registerCommand("codegraph.restart", () => doRestart()),
    vscode.commands.registerCommand("codegraph.initProject", () => doInit()),
    vscode.commands.registerCommand("codegraph.sync", () => doSync()),
    vscode.commands.registerCommand("codegraph.showMenu", () => doShowMenu()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const next = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (next === _root) { return; }
      _root = next;
      refreshMcpDefinitions();
      void refreshStatus();
    }),
  );

  // VS Code inherits the shell's PATH, so spawning "codegraph" just works.
  // No file lookup, no process validation, no Copilot dependency.
  registerMcpProvider(context);

  setStatus(_root ? "unknown" : "no-workspace");
  if (_root) { void refreshStatus(); }

  if (context.extensionMode === vscode.ExtensionMode.Production) { return undefined; }
  return { codegraphCmd, runCli, isCliMissing, refreshStatus, getStatus: () => _status };
}

function setStatus(status: Status) {
  _status = status;
  renderStatus();
}

function renderStatus() {
  const bar = _statusBar;
  if (!bar || _busy || _transientTimer) { return; }
  bar.backgroundColor = undefined;
  bar.command = "codegraph.showMenu";
  switch (_status) {
    case "no-workspace":
      bar.text = "$(warning) CodeGraph: No workspace";
      bar.tooltip = "Open a folder to use CodeGraph";
      bar.command = "workbench.action.files.openFolder";
      break;
    case "cli-missing":
      bar.text = "$(error) CodeGraph: CLI not found";
      bar.tooltip = `'${codegraphCmd()}' was not found — set "codegraph.path"`;
      bar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      break;
    case "uninitialized":
      bar.text = "$(info) CodeGraph: Not initialized";
      bar.tooltip = "Project not initialized — click to open the actions menu";
      bar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      break;
    case "ready":
      bar.text = "$(check) CodeGraph: Ready";
      bar.tooltip = "CodeGraph MCP registered — click to open the actions menu";
      break;
    case "unknown":
      bar.text = "$(loading~spin) CodeGraph";
      bar.tooltip = "Checking project status…";
      break;
  }
  bar.show();
}

function setBusy(text: string, tooltip: string) {
  clearTransient();
  _busy = true;
  if (!_statusBar) { return; }
  _statusBar.text = text;
  _statusBar.tooltip = tooltip;
  _statusBar.command = "codegraph.showMenu";
  _statusBar.backgroundColor = undefined;
  _statusBar.show();
}

/** Show a short-lived message, then fall back to whatever `_status` says. */
function flashStatus(text: string) {
  clearTransient();
  _busy = false;
  if (!_statusBar) { return; }
  _statusBar.text = text;
  _statusBar.show();
  _transientTimer = setTimeout(() => {
    _transientTimer = undefined;
    renderStatus();
  }, 3000);
}

function clearTransient() {
  if (_transientTimer) {
    clearTimeout(_transientTimer);
    _transientTimer = undefined;
  }
}

/** Register the MCP provider. That's it — codegraph serve --mcp handles the rest. */
function registerMcpProvider(context: vscode.ExtensionContext) {
  _mcpChangeEmitter = new vscode.EventEmitter<void>();
  _mcpVersion = nextMcpVersion();

  _mcpDisposable = vscode.lm.registerMcpServerDefinitionProvider(
    "codegraph",
    {
      onDidChangeMcpServerDefinitions: _mcpChangeEmitter.event,
      // codegraph serve --mcp manages its own daemon lifecycle, so there is
      // nothing to prewarm, verify or respawn in resolveMcpServerDefinition.
      provideMcpServerDefinitions() {
        if (!_root) { return []; }
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            codegraphCmd(),
            ["serve", "--mcp", "--path", _root],
            { CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
            _mcpVersion
          ),
        ];
      },
    }
  );

  context.subscriptions.push(_mcpDisposable, _mcpChangeEmitter);
}

/** Bumped on every refresh so VS Code discards stale cached connections. */
function nextMcpVersion(): string {
  return `${_extensionVersion}+${Date.now()}`;
}

function refreshMcpDefinitions() {
  _mcpVersion = nextMcpVersion();
  _mcpChangeEmitter?.fire();
}

export interface RunOptions {
  /** Mirror the child's output into the CodeGraph output channel. */
  log?: boolean;
  /** Keep stdout in memory (only needed when the caller parses it). */
  capture?: boolean;
  timeoutMs?: number;
  token?: vscode.CancellationToken;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  canceled: boolean;
  timedOut: boolean;
}

/** Spawn the CLI directly — never through a shell, so paths are not re-interpreted. */
function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { log = true, capture = false, timeoutMs, token } = options;
  return new Promise<RunResult>((resolve, reject) => {
    const child = cp.spawn(codegraphCmd(), args, { cwd: _root, shell: false });
    let stdout = "";
    let stderr = "";
    let canceled = false;
    let timedOut = false;

    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs)
      : undefined;
    const cancelSub = token?.onCancellationRequested(() => {
      canceled = true;
      child.kill();
    });
    const cleanup = () => {
      if (timer) { clearTimeout(timer); }
      cancelSub?.dispose();
    };

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      if (capture) { stdout += chunk; }
      if (log) { _output?.append(chunk); }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
      if (log) { _output?.append(chunk); }
    });
    child.once("error", (err) => { cleanup(); reject(err); });
    child.once("close", (code) => {
      cleanup();
      resolve({ code, stdout, stderr, canceled, timedOut });
    });
  });
}

function isCliMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function reportCliError(action: string, err: unknown) {
  if (isCliMissing(err)) {
    setStatus("cli-missing");
    const pick = await vscode.window.showErrorMessage(
      `CodeGraph: '${codegraphCmd()}' could not be run. Install the CLI or set "codegraph.path".`,
      "Open Settings"
    );
    if (pick === "Open Settings") {
      void vscode.commands.executeCommand("workbench.action.openSettings", "codegraph.path");
    }
    return;
  }
  void vscode.window.showErrorMessage(`CodeGraph: ${action} failed — ${errorText(err)}`);
}

/** Single source of truth for "is this project initialized". */
async function refreshStatus() {
  if (!_root) { setStatus("no-workspace"); return; }
  try {
    const result = await runCli(["status", _root, "--json"], {
      log: false,
      capture: true,
      timeoutMs: 5000,
    });
    if (result.code === 0) {
      const parsed = JSON.parse(result.stdout) as { initialized?: boolean };
      setStatus(parsed.initialized ? "ready" : "uninitialized");
      return;
    }
  } catch (err) {
    if (isCliMissing(err)) { setStatus("cli-missing"); return; }
  }
  // CLI unusable or output unparsable — fall back to the on-disk marker.
  setStatus(fs.existsSync(path.join(_root, ".codegraph")) ? "ready" : "uninitialized");
}

function doRestart() {
  refreshMcpDefinitions();
  flashStatus("$(sync) CodeGraph: MCP refreshed");
  void vscode.window.showInformationMessage("CodeGraph: MCP server restarted");
}

async function doInit() {
  if (!_root) { return; }
  if (_initInProgress) { _output?.show(true); return; }
  _initInProgress = true;
  setBusy("$(loading~spin) CodeGraph: Initializing…", "Running codegraph init");
  _output?.show(true);
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CodeGraph: initializing project…",
        cancellable: true,
      },
      (_progress, token) => runCli(["init"], { token })
    );
    if (result.canceled) {
      flashStatus("$(circle-slash) CodeGraph: Init canceled");
    } else if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `codegraph init exited with code ${result.code}`);
    } else {
      flashStatus("$(check) CodeGraph: Initialized");
      refreshMcpDefinitions();
      void vscode.window.showInformationMessage("CodeGraph: project initialized");
    }
  } catch (err: unknown) {
    flashStatus("$(error) CodeGraph: Init failed");
    await reportCliError("init", err);
  } finally {
    _initInProgress = false;
    _busy = false;
    await refreshStatus();
  }
}

async function doSync() {
  if (!_root) { return; }
  if (_syncInProgress) { _output?.show(true); return; }
  _syncInProgress = true;
  setBusy("$(loading~spin) CodeGraph: Syncing…", "Re-indexing the workspace");
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "CodeGraph: re-indexing…",
        cancellable: true,
      },
      (_progress, token) => runCli(["sync", _root!], { token })
    );
    if (result.canceled) {
      flashStatus("$(circle-slash) CodeGraph: Sync canceled");
    } else if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `codegraph sync exited with code ${result.code}`);
    } else {
      flashStatus("$(check) CodeGraph: Synced");
      void vscode.window.showInformationMessage("CodeGraph: index updated");
    }
  } catch (err: unknown) {
    flashStatus("$(error) CodeGraph: Sync failed");
    await reportCliError("sync", err);
  } finally {
    _syncInProgress = false;
    _busy = false;
    await refreshStatus();
  }
}

interface MenuItem extends vscode.QuickPickItem {
  action: "restart" | "init" | "sync";
}

async function doShowMenu() {
  if (!_root) {
    void vscode.window.showWarningMessage("CodeGraph: open a folder first");
    return;
  }
  const items: MenuItem[] = [
    { action: "restart", label: "$(sync) Restart MCP Server", description: "Re-register MCP" },
    { action: "init", label: "$(repo) Initialize Project", description: "Run codegraph init" },
    { action: "sync", label: "$(refresh) Force Re-index", description: "Force a full re-index" },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "CodeGraph actions",
  });
  switch (picked?.action) {
    case "restart": doRestart(); break;
    case "init": await doInit(); break;
    case "sync": await doSync(); break;
  }
}

export function deactivate() {
  clearTransient();
  // Everything else is disposed through context.subscriptions.
  _mcpDisposable = undefined;
  _mcpChangeEmitter = undefined;
  _statusBar = undefined;
  _output = undefined;
  _root = undefined;
  _busy = false;
  _initInProgress = false;
  _syncInProgress = false;
  _status = "unknown";
}
