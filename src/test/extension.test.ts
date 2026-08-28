import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EXTENSION_ID, getApi, makeTempDir, withPath } from "./helpers";

describe("activation", () => {
  it("activates and exposes the test API", async () => {
    const api = await getApi();
    assert.strictEqual(typeof api.codegraphCmd, "function");
  });

  it("registers every contributed command", async () => {
    await getApi();
    const registered = await vscode.commands.getCommands(true);
    const contributed: { command: string }[] =
      vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes.commands;
    for (const { command } of contributed) {
      assert.ok(registered.includes(command), `${command} is not registered`);
    }
  });

  it("defaults codegraphCmd to the bare binary name", async () => {
    const api = await getApi();
    await vscode.workspace
      .getConfiguration("codegraph")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    assert.strictEqual(api.codegraphCmd(), "codegraph");
  });

  it("keeps codegraph.path out of workspace settings", () => {
    const properties = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes
      .configuration.properties;
    assert.strictEqual(properties["codegraph.path"].scope, "machine");
  });

  it("contributes a local install command that names the recommended v1.5.0", () => {
    const commands = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.contributes
      .commands as { command: string; title: string }[];
    const install = commands.find((c) => c.command === "codegraph.installCli");
    assert.ok(install, "codegraph.installCli must be contributed");
    assert.ok(install.title.includes("1.5.0"), "title should name the recommended version");
    assert.ok(install.title.toLowerCase().includes("recommended"), "title should mark it recommended");
  });

  it("resolves the bare binary when nothing is installed", async () => {
    const api = await getApi();
    await vscode.workspace
      .getConfiguration("codegraph")
      .update("path", undefined, vscode.ConfigurationTarget.Global);
    const cli = api.resolveCli();
    assert.strictEqual(cli.cmd, "codegraph");
    assert.deepStrictEqual(cli.prefixArgs, []);
  });

  it("prefers codegraph.path over auto-detection", async () => {
    const api = await getApi();
    try {
      await vscode.workspace
        .getConfiguration("codegraph")
        .update("path", "/tmp/custom-codegraph", vscode.ConfigurationTarget.Global);
      const cli = api.resolveCli();
      assert.strictEqual(cli.cmd, "/tmp/custom-codegraph");
      assert.deepStrictEqual(cli.prefixArgs, []);
    } finally {
      await vscode.workspace
        .getConfiguration("codegraph")
        .update("path", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it("declares that it does not support untrusted workspaces", () => {
    const capabilities = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.capabilities;
    assert.strictEqual(capabilities.untrustedWorkspaces.supported, false);
  });
});

describe("npm resolution", () => {
  it("follows the npm shim on PATH back to npm-cli.js", async () => {
    const api = await getApi();
    const tmp = makeTempDir();
    const prefix = path.join(tmp, "npm-prefix");
    fs.mkdirSync(path.join(prefix, "node_modules", "npm", "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
      "// fake npm\n",
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(prefix, "npm"), "#!/bin/sh\n", { mode: 0o755 });
    try {
      await withPath(prefix, () => {
        assert.strictEqual(
          api.findNpmEntry(),
          path.join(prefix, "node_modules", "npm", "bin", "npm-cli.js")
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns undefined when npm is not on PATH", async () => {
    const api = await getApi();
    const tmp = makeTempDir();
    try {
      await withPath(tmp, () => {
        assert.strictEqual(api.findNpmEntry(), undefined);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
