import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../extension";
import { getApi, makeTempDir, setCliPath, writeFakeCli } from "./helpers";

describe("runCli", function () {
  let api: TestApi;
  let tmp: string;

  before(async function () {
    if (process.platform === "win32") { this.skip(); }
    tmp = makeTempDir();
    api = await getApi();
  });

  after(async () => {
    await setCliPath(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("captures stdout and the exit code of a successful run", async () => {
    await setCliPath(writeFakeCli(tmp, "ok", `process.stdout.write('{"initialized":true}');`));
    const result = await api.runCli(["status"], { log: false, capture: true });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout, '{"initialized":true}');
    assert.strictEqual(result.canceled, false);
    assert.strictEqual(result.timedOut, false);
  });

  it("drops stdout unless capture is requested", async () => {
    await setCliPath(writeFakeCli(tmp, "chatty", `process.stdout.write("noise");`));
    const result = await api.runCli(["sync"], { log: false });
    assert.strictEqual(result.stdout, "");
  });

  it("reports a non-zero exit code with stderr", async () => {
    await setCliPath(writeFakeCli(tmp, "fail", `process.stderr.write("boom"); process.exit(3);`));
    const result = await api.runCli(["sync"], { log: false });
    assert.strictEqual(result.code, 3);
    assert.strictEqual(result.stderr, "boom");
  });

  it("keeps only the tail of very large stderr", async () => {
    await setCliPath(
      writeFakeCli(tmp, "loud", `process.stderr.write("x".repeat(10000) + "END"); process.exit(1);`)
    );
    const result = await api.runCli(["sync"], { log: false });
    assert.strictEqual(result.stderr.length, 4000);
    assert.ok(result.stderr.endsWith("END"));
  });

  it("kills the child and flags timedOut when the timeout elapses", async () => {
    await setCliPath(writeFakeCli(tmp, "slow", `setTimeout(() => process.exit(0), 30000);`));
    const result = await api.runCli(["sync"], { log: false, timeoutMs: 250 });
    assert.strictEqual(result.timedOut, true);
    assert.notStrictEqual(result.code, 0);
  });

  it("kills the child and flags canceled when the token is cancelled", async () => {
    await setCliPath(writeFakeCli(tmp, "slow2", `setTimeout(() => process.exit(0), 30000);`));
    const source = new vscode.CancellationTokenSource();
    setTimeout(() => source.cancel(), 250);
    const result = await api.runCli(["sync"], { log: false, token: source.token });
    source.dispose();
    assert.strictEqual(result.canceled, true);
  });

  it("rejects with a missing-CLI error when the binary does not exist", async () => {
    await setCliPath(path.join(tmp, "definitely-not-here"));
    await assert.rejects(
      () => api.runCli(["status"], { log: false }),
      (err: unknown) => {
        assert.ok(api.isCliMissing(err), "expected a missing-CLI error");
        return true;
      }
    );
  });

  it("does not let arguments reach a shell", async () => {
    await setCliPath(
      writeFakeCli(tmp, "argecho", `process.stdout.write(process.argv.slice(2).join("|"));`)
    );
    const result = await api.runCli(["status", "$(echo pwned)", "a b"], { log: false, capture: true });
    assert.strictEqual(result.stdout, "status|$(echo pwned)|a b");
  });
});

describe("refreshStatus", function () {
  let api: TestApi;
  let tmp: string;

  before(async function () {
    if (process.platform === "win32") { this.skip(); }
    tmp = makeTempDir();
    api = await getApi();
  });

  after(async () => {
    await setCliPath(undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("is ready when the CLI reports an initialized project", async () => {
    await setCliPath(writeFakeCli(tmp, "init-true", `process.stdout.write('{"initialized":true}');`));
    await api.refreshStatus();
    assert.strictEqual(api.getStatus(), "ready");
  });

  it("is uninitialized when the CLI says so", async () => {
    await setCliPath(writeFakeCli(tmp, "init-false", `process.stdout.write('{"initialized":false}');`));
    await api.refreshStatus();
    assert.strictEqual(api.getStatus(), "uninitialized");
  });

  it("falls back to the on-disk marker when the CLI fails", async () => {
    await setCliPath(writeFakeCli(tmp, "status-fail", `process.exit(2);`));
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root, "test workspace folder required");
    assert.ok(!fs.existsSync(path.join(root, ".codegraph")), "fixture must not be initialized");
    await api.refreshStatus();
    assert.strictEqual(api.getStatus(), "uninitialized");
  });

  it("reports cli-missing when the binary cannot be spawned", async () => {
    await setCliPath(path.join(tmp, "definitely-not-here"));
    await api.refreshStatus();
    assert.strictEqual(api.getStatus(), "cli-missing");
  });
});
