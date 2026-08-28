import * as vscode from "vscode";
import * as path from "path";
import * as cp from "child_process";
import * as fs from "fs";

const CLI_PACKAGE = "@colbymchenry/codegraph";
/** The CLI version this extension is built and tested against — the recommended local install. */
const RECOMMENDED_CLI_VERSION = "1.5.0";

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
let _context: vscode.ExtensionContext | undefined;
let _localCli: LocalCli | undefined;
let _installInProgress = false;

/** Returned from activate() outside production only, so integration tests can drive internals. */
export interface TestApi {
  codegraphCmd(): string;
  resolveCli(): CliInvocation;
  runCli(args: string[], options?: RunOptions): Promise<RunResult>;
  isCliMissing(err: unknown): boolean;
  refreshStatus(): Promise<void>;
  getStatus(): Status;
  findNpmEntry(): string | undefined;
}

interface LocalCli {
  /** Entry script of the installed package (npm-shim.js / dist/bin/codegraph.js). */
  binPath: string;
  version: string;
}

/** Where a CLI launch comes from — for spawning and for user-facing messages. */
export interface CliInvocation {
  /** The executable to spawn. */
  cmd: string;
  /** Args prepended before every command-specific arg. */
  prefixArgs: string[];
  /** Short human-readable source, e.g. "local v1.5.0". */
  label: string;
}

/** Directory holding the locally installed CLI: <global storage>/cli. */
function localCliRoot(): string | undefined {
  return _context ? path.join(_context.globalStorageUri.fsPath, "cli") : undefined;
}

/** Resolve a previously installed local CLI under <localCliRoot>/node_modules. */
function findLocalCli(): LocalCli | undefined {
  if (_localCli) { return _localCli; }
  const root = localCliRoot();
  if (!root) { return undefined; }
  const pkgDir = path.join(root, "node_modules", "@colbymchenry", "codegraph");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      version?: string;
      bin?: string | Record<string, string>;
    };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codegraph;
    if (!bin || !pkg.version) { return undefined; }
    const binPath = path.join(pkgDir, bin);
    if (!fs.existsSync(binPath)) { return undefined; }
    _localCli = { binPath, version: pkg.version };
    return _localCli;
  } catch {
    return undefined;
  }
}

/**
 * CLI resolution order:
 * 1. `codegraph.path` — explicit user override;
 * 2. the locally installed, version-pinned CLI;
 * 3. the bare `codegraph` binary from PATH.
 */
function resolveCli(): CliInvocation {
  const cfg = vscode.workspace.getConfiguration("codegraph").get<string>("path");
  if (cfg?.trim()) {
    return { cmd: cfg.trim(), prefixArgs: [], label: cfg.trim() };
  }
  const local = findLocalCli();
  if (local) {
    return { cmd: process.execPath, prefixArgs: [local.binPath], label: `local v${local.version}` };
  }
  return { cmd: "codegraph", prefixArgs: [], label: "codegraph" };
}

/** The command to launch codegraph — the resolved executable above. */
function codegraphCmd(): string {
  return resolveCli().cmd;
}

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  _context = context;
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
    vscode.commands.registerCommand("codegraph.installCli", () => doInstallCli()),
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
  return {
    codegraphCmd,
    resolveCli,
    runCli,
    isCliMissing,
    refreshStatus,
    getStatus: () => _status,
    findNpmEntry,
  };
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
      bar.tooltip = `'${resolveCli().label}' was not found — install it or set "codegraph.path"`;
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
        const cli = resolveCli();
        return [
          new vscode.McpStdioServerDefinition(
            "CodeGraph",
            cli.cmd,
            [...cli.prefixArgs, "serve", "--mcp", "--path", _root],
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
  /** Working directory — defaults to the workspace root. */
  cwd?: string;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  canceled: boolean;
  timedOut: boolean;
}

/** Spawn a command directly — never through a shell, so paths are not re-interpreted. */
function runCommand(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const { log = true, capture = false, timeoutMs, token, cwd } = options;
  return new Promise<RunResult>((resolve, reject) => {
    const child = cp.spawn(cmd, args, { cwd: cwd ?? _root, shell: false });
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

/** Spawn the resolved CLI — custom path, local install, or bare `codegraph`. */
function runCli(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const cli = resolveCli();
  return runCommand(cli.cmd, [...cli.prefixArgs, ...args], options);
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
      `CodeGraph: '${resolveCli().label}' could not be run. Install the CLI locally or set "codegraph.path".`,
      `Install CLI v${RECOMMENDED_CLI_VERSION} (Recommended)`,
      "Open Settings"
    );
    if (pick?.startsWith("Install CLI")) {
      await doInstallCli();
    } else if (pick === "Open Settings") {
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

interface VersionOption extends vscode.QuickPickItem {
  /** npm version spec to install. */
  version: string;
}

/** All existing files named `name` found on PATH, honoring PATHEXT on Windows. */
function findOnPath(name: string): string[] {
  const env = process.env;
  const pathValue = env.PATH ?? env.Path ?? "";
  const exts = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  const hits: string[] = [];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) { continue; }
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext.toLowerCase()}`);
      try {
        if (fs.statSync(candidate).isFile()) { hits.push(candidate); }
      } catch { /* not present in this directory */ }
    }
  }
  return hits;
}

/**
 * npm's Windows shim is `npm.cmd` — a batch file that cannot be spawned without a
 * shell. Follow the shim back to the package and return `npm-cli.js`, which node
 * can run directly (args reach npm verbatim, never through a shell).
 */
function findNpmEntry(): string | undefined {
  for (const shim of findOnPath("npm")) {
    const npmCli = path.join(path.dirname(shim), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(npmCli)) { return npmCli; }
  }
  return undefined;
}

/** How to launch npm — node on the entry script on Windows, the bare name elsewhere. */
function npmInvocation(): { cmd: string; prefixArgs: string[] } {
  if (process.platform !== "win32") { return { cmd: "npm", prefixArgs: [] }; }
  const entry = findNpmEntry();
  if (entry) { return { cmd: process.execPath, prefixArgs: [entry] }; }
  // Non-standard npm layout: prefer a real shim found on PATH (e.g. Volta's
  // npm.exe proxy); a bare npm.cmd stays the last-resort best effort.
  const shims = findOnPath("npm");
  return shims.length > 0 ? { cmd: shims[0], prefixArgs: [] } : { cmd: "npm.cmd", prefixArgs: [] };
}

/** Install the CLI package into extension storage: <global storage>/cli/node_modules. */
function installCli(version: string, token: vscode.CancellationToken): Promise<RunResult> {
  const root = localCliRoot();
  if (!root) { return Promise.reject(new Error("extension storage is unavailable")); }
  fs.mkdirSync(root, { recursive: true });
  const npm = npmInvocation();
  return runCommand(
    npm.cmd,
    [
      ...npm.prefixArgs,
      "install", `${CLI_PACKAGE}@${version}`,
      "--prefix", root,
      "--no-save", "--no-audit", "--no-fund", "--no-package-lock",
      "--loglevel=error",
    ],
    { cwd: root, token, timeoutMs: 10 * 60 * 1000 }
  );
}

/** Locally install the CodeGraph CLI — v1.5.0 pinned and presented as the recommended version. */
async function doInstallCli() {
  if (_installInProgress) { _output?.show(true); return; }
  _installInProgress = true;
  setBusy("$(loading~spin) CodeGraph: Installing CLI…", "Installing the CodeGraph CLI locally");
  _output?.show(true);
  try {
    const versions: VersionOption[] = [
      {
        version: RECOMMENDED_CLI_VERSION,
        label: `$(star-full) ${RECOMMENDED_CLI_VERSION} (Recommended)`,
        description: "Pinned, tested version — matches what this extension expects",
      },
      {
        version: "latest",
        label: "$(arrow-up) Latest",
        description: "Not recommended — untested with this extension",
      },
    ];
    const picked = await vscode.window.showQuickPick(versions, {
      placeHolder: "Install the CodeGraph CLI locally — v1.5.0 is recommended",
    });
    if (!picked) {
      flashStatus("$(circle-slash) CodeGraph: Install canceled");
      return;
    }
    const display = picked.version === "latest" ? "latest" : `v${picked.version}`;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `CodeGraph: installing CLI ${display}…`,
        cancellable: true,
      },
      (_progress, token) => installCli(picked.version, token)
    );
    if (result.canceled) {
      flashStatus("$(circle-slash) CodeGraph: Install canceled");
    } else if (result.code !== 0) {
      throw new Error(
        result.timedOut
          ? "CLI install timed out — check your network and try again"
          : result.stderr.trim() || `npm install exited with code ${result.code}`
      );
    } else {
      _localCli = undefined; // re-detect the freshly installed package
      const installed = findLocalCli()?.version ?? picked.version;
      flashStatus("$(check) CodeGraph: CLI installed");
      void vscode.window.showInformationMessage(
        `CodeGraph: CLI v${installed} installed locally — it is now used for MCP and all commands.`
      );
      refreshMcpDefinitions();
      await refreshStatus();
    }
  } catch (err: unknown) {
    flashStatus("$(error) CodeGraph: Install failed");
    void vscode.window.showErrorMessage(`CodeGraph: install failed — ${errorText(err)}`);
  } finally {
    _installInProgress = false;
    _busy = false;
  }
}

interface MenuItem extends vscode.QuickPickItem {
  action: "restart" | "init" | "sync" | "install";
}

async function doShowMenu() {
  if (!_root) {
    void vscode.window.showWarningMessage("CodeGraph: open a folder first");
    return;
  }
  const local = findLocalCli();
  const items: MenuItem[] = [
    { action: "restart", label: "$(sync) Restart MCP Server", description: "Re-register MCP" },
    { action: "init", label: "$(repo) Initialize Project", description: "Run codegraph init" },
    { action: "sync", label: "$(refresh) Force Re-index", description: "Force a full re-index" },
    {
      action: "install",
      label: "$(cloud-download) Install CLI Locally",
      description: local
        ? `Installed: v${local.version}`
        : `Install v${RECOMMENDED_CLI_VERSION} (recommended)`,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "CodeGraph actions",
  });
  switch (picked?.action) {
    case "restart": doRestart(); break;
    case "init": await doInit(); break;
    case "sync": await doSync(); break;
    case "install": await doInstallCli(); break;
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
  _installInProgress = false;
  _localCli = undefined;
  _context = undefined;
  _status = "unknown";
}
