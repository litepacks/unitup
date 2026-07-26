import path from 'node:path';
import fs from 'node:fs';
import { findRuntimeExecutable, getBinaryVersion } from './common.js';

export async function createElixirAdapter(opts = {}) {
  const customPath = opts.command;
  let execPath = null;

  if (customPath) {
    const absPath = path.resolve(process.cwd(), customPath);
    if (fs.existsSync(absPath)) {
      try {
        fs.accessSync(absPath, fs.constants.X_OK);
        execPath = absPath;
      } catch {}
    }
  }

  if (!execPath) {
    execPath = await findRuntimeExecutable(['elixir']);
  }

  if (!execPath) {
    throw new Error(
      'Elixir runtime could not be found.\n\nInstall Elixir or specify its path:\n  unitup add app.exs --command /usr/bin/elixir'
    );
  }

  const version = await getBinaryVersion(execPath, '-v');
  const scriptPath = opts.script ? path.resolve(process.cwd(), opts.script) : null;
  const runtimeArgs = Array.isArray(opts.runtimeArgs) ? opts.runtimeArgs : [];
  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];

  const args = [...runtimeArgs];
  if (scriptPath) {
    args.push(scriptPath);
  }
  args.push(...scriptArgs);

  return {
    command: execPath,
    args,
    runtime: 'elixir',
    version
  };
}
