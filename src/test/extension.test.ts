import * as assert from "assert";
import * as vscode from "vscode";
import { EXTENSION_ID, getApi } from "./helpers";

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

  it("declares that it does not support untrusted workspaces", () => {
    const capabilities = vscode.extensions.getExtension(EXTENSION_ID)!.packageJSON.capabilities;
    assert.strictEqual(capabilities.untrustedWorkspaces.supported, false);
  });
});
