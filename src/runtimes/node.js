import path from 'node:path';
import fs from 'node:fs';
import { findRuntimeExecutable, getBinaryVersion } from './common.js';

export async function createNodeAdapter(opts = {}) {
  const baseDir = opts.cwd || process.cwd();
  const customPath = opts.command || opts.nodePath;
  let execPath = null;

  if (customPath) {
    const absPath = path.resolve(baseDir, customPath);
    if (fs.existsSync(absPath)) {
      try {
        fs.accessSync(absPath, fs.constants.X_OK);
        execPath = absPath;
      } catch {
        execPath = null;
      }
    }
  }

  if (!execPath) {
    if (process.execPath && fs.existsSync(process.execPath)) {
      try {
        fs.accessSync(process.execPath, fs.constants.X_OK);
        execPath = process.execPath;
      } catch {}
    }
  }

  if (!execPath) {
    execPath = await findRuntimeExecutable(['node']);
  }

  if (!execPath) {
    throw new Error(
      'Node.js runtime could not be found.\n\nInstall Node.js or specify its path:\n  unitup add script.js --command /usr/bin/node'
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
    runtime: 'node',
    version
  };
}
