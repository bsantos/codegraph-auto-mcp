import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import type { TestApi } from "../extension";

export const EXTENSION_ID = "bsantos.codegraph-mcp";

export async function getApi(): Promise<TestApi> {
  const ext = vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID);
  if (!ext) { throw new Error(`extension ${EXTENSION_ID} not found`); }
  const api = await ext.activate();
  if (!api) { throw new Error("test API unavailable — extension activated in production mode"); }
  return api;
}

/** Writes an executable stub the extension can spawn in place of the real CLI. */
export function writeFakeCli(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`, { mode: 0o755 });
  return file;
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-test-"));
}

export async function setCliPath(value: string | undefined): Promise<void> {
  await vscode.workspace
    .getConfiguration("codegraph")
    .update("path", value, vscode.ConfigurationTarget.Global);
}
