import fs from 'node:fs';
import path from 'node:path';
import { findRuntimeExecutable, getBinaryVersion } from './common.js';

export async function createGoAdapter(opts = {}) {
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
    execPath = await findRuntimeExecutable(['go']);
  }

  if (!execPath) {
    throw new Error(
      'Go runtime could not be found.\n\nInstall Go or specify its path:\n  unitup add main.go --command /usr/local/go/bin/go'
    );
  }

  const version = await getBinaryVersion(execPath, 'version');
  const scriptPath = opts.script ? path.resolve(baseDir, opts.script) : null;
  const runtimeArgs = Array.isArray(opts.runtimeArgs) ? opts.runtimeArgs : [];
  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];

  const args = ['run', ...runtimeArgs];
  if (scriptPath) {
    args.push(scriptPath);
  }
  args.push(...scriptArgs);

  return {
    command: execPath,
    args,
    runtime: 'go',
    version
  };
}
