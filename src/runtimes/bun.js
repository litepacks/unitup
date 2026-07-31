import path from 'node:path';
import fs from 'node:fs';
import { findRuntimeExecutable, getBinaryVersion } from './common.js';

export async function createBunAdapter(opts = {}) {
  const baseDir = opts.cwd || process.cwd();
  const customPath = opts.command;
  let execPath = null;

  if (customPath) {
    const absPath = path.resolve(baseDir, customPath);
    if (fs.existsSync(absPath)) {
      try {
        fs.accessSync(absPath, fs.constants.X_OK);
        execPath = absPath;
      } catch {}
    }
  }

  if (!execPath) {
    execPath = await findRuntimeExecutable(['bun']);
  }

  if (!execPath) {
    throw new Error(
      'Bun runtime could not be found.\n\nInstall Bun or specify its path:\n  unitup add server.ts --command /usr/bin/bun'
    );
  }

  const version = await getBinaryVersion(execPath, '-v');
  const scriptPath = opts.script ? path.resolve(baseDir, opts.script) : null;
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
    runtime: 'bun',
    version
  };
}
