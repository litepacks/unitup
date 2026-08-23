import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../systemd.js';

export function findExecutableInPath(binaryName) {
  // 1. Check standard PATH env
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const isWin = process.platform === 'win32';
  const pathext = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];

  for (const dir of dirs) {
    const directFull = path.join(dir, binaryName);
    try {
      if (fs.existsSync(directFull)) {
        if (!isWin) fs.accessSync(directFull, fs.constants.X_OK);
        return directFull;
      }
    } catch {
      // ignore
    }

    if (isWin) {
      for (const ext of pathext) {
        const withExt = path.join(
          dir,
          binaryName.toLowerCase().endsWith(ext.toLowerCase()) ? binaryName : `${binaryName}${ext.toLowerCase()}`
        );
        try {
          if (fs.existsSync(withExt)) {
            return withExt;
          }
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

export async function findRuntimeExecutable(binaryNames) {
  const names = Array.isArray(binaryNames) ? binaryNames : [binaryNames];

  for (const name of names) {
    if (path.isAbsolute(name)) {
      if (fs.existsSync(name)) {
        try {
          fs.accessSync(name, fs.constants.X_OK);
          return name;
        } catch {
          // ignore
        }
      }
      continue;
    }

    // Try finding in system PATH directly
    const foundInPath = findExecutableInPath(name);
    if (foundInPath) return foundInPath;

    // Fallback to which/where system call
    try {
      const whichCmd = process.platform === 'win32' ? 'where' : 'which';
      const res = await runCommand(whichCmd, [name]);
      if (res.code === 0 && res.stdout.trim()) {
        const p = res.stdout.trim().split('\n')[0].trim();
        if (fs.existsSync(p)) {
          fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      }
    } catch {
      // ignore
    }
  }

  return null;
}

export async function getBinaryVersion(execPath, versionFlag = '-v') {
  try {
    const res = await runCommand(execPath, [versionFlag]);
    if (res.code === 0 && res.stdout.trim()) {
      return res.stdout.trim().split('\n')[0].trim();
    }
  } catch {
    // ignore
  }
  return 'unknown';
}
