import path from 'node:path';
import fs from 'node:fs';

export async function createNativeAdapter(opts = {}) {
  const targetPath = opts.script || opts.command;

  if (!targetPath) {
    throw new Error('Native executable path is required.');
  }

  const absPath = path.resolve(process.cwd(), targetPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`Executable file does not exist: ${absPath}`);
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`Executable path is not a file: ${absPath}`);
  }

  try {
    fs.accessSync(absPath, fs.constants.X_OK);
  } catch {
    throw new Error(
      `The executable is not runnable.\n\nRun:\n  chmod +x ${absPath}`
    );
  }

  const scriptArgs = Array.isArray(opts.args) ? opts.args : [];

  return {
    command: absPath,
    args: scriptArgs,
    runtime: 'native',
    version: 'native'
  };
}
