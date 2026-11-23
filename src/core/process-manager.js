import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Parses a valid positive integer PID from a number or numeric string.
 *
 * @param {number|string|null|undefined} value
 * @returns {number|null}
 */
export function parsePid(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const num = Number.parseInt(value.trim(), 10);
    return num > 0 ? num : null;
  }
  return null;
}

/**
 * Best-effort check that a PID still belongs to the expected executable/command
 * to guard against killing an unrelated process after OS PID reuse.
 *
 * @param {number} pid
 * @param {string} expectedCommand
 * @returns {Promise<boolean>} true if command matches or cannot be determined safely
 */
async function verifyPidCommand(pid, expectedCommand) {
  if (!expectedCommand || typeof expectedCommand !== 'string') {
    return true;
  }
  const expectedBase = path.basename(expectedCommand).toLowerCase();
  const expectedStem = expectedBase.replace(/\.(exe|cmd|bat)$/i, '');
  if (!expectedBase) return true;

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile(
        'tasklist',
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', timeout: 2000 },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(true);
            return;
          }
          const line = stdout.trim().toLowerCase();
          if (!line || line.includes('no tasks are running')) {
            resolve(true);
            return;
          }
          resolve(line.includes(expectedBase) || (expectedStem.length > 0 && line.includes(expectedStem)));
        }
      );
    });
  }

  return new Promise((resolve) => {
    execFile('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 1000 }, (err, stdout) => {
      if (err || !stdout) {
        // Process already exited or ps unavailable — allow normal liveness check to handle it
        resolve(true);
        return;
      }
      const cmdline = stdout.trim().toLowerCase();
      if (!cmdline) {
        resolve(true);
        return;
      }
      resolve(cmdline.includes(expectedBase) || cmdline.includes(expectedCommand.toLowerCase()));
    });
  });
}

/**
 * Waits for a process (by PID) to exit within the grace period; sends SIGKILL if still alive and verifies exit.
 *
 * @param {number|string|null|undefined} rawPid
 * @param {object} [options]
 * @param {number} [options.shutdownTimeout=5000]
 * @param {number} [options.killTimeout=2000]
 * @param {boolean} [options.sendTerm=false]
 * @param {string} [options.signal='SIGTERM']
 * @param {string} [options.expectedCommand]
 * @param {ProcessManager} [options.processManager]
 * @returns {Promise<boolean>}
 */
export async function ensureProcessStopped(rawPid, options = {}) {
  const pid = parsePid(rawPid);
  if (!pid) return true;

  // Verify process exists and we have permission to signal it
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'EPERM') {
      return false;
    }
    return true;
  }

  // Guard against OS PID reuse when falling back to persisted metadata PID
  if (options.expectedCommand) {
    const matches = await verifyPidCommand(pid, options.expectedCommand);
    if (!matches) {
      return true;
    }
  }

  const timeout =
    typeof options.shutdownTimeout === 'number' && options.shutdownTimeout >= 0 ? options.shutdownTimeout : 5000;
  const killTimeout = typeof options.killTimeout === 'number' && options.killTimeout >= 0 ? options.killTimeout : 2000;
  const pm = options.processManager || new ProcessManager({ defaultShutdownTimeout: timeout });

  if (options.sendTerm) {
    pm.signal(pid, options.signal || 'SIGTERM');
  }

  if (timeout > 0) {
    const exitResult = await pm.waitForExit(pid, timeout);
    if (exitResult.exited) {
      return true;
    }
  }

  if (pm.isAlive(pid)) {
    return pm.forceKill(pid, killTimeout);
  }

  return true;
}

/**
 * ProcessManager is responsible ONLY for low-level process lifecycle management.
 * It contains NO deployment sequencing, routing, or drain logic.
 */
export class ProcessManager {
  constructor(options = {}) {
    this.processes = new Map(); // pid -> processEntry
    this.recentExits = new Map(); // pid -> exit info { pid, exitCode, exitSignal, recentStderr }
    this.defaultShutdownTimeout = options.defaultShutdownTimeout || 5000;
  }

  /**
   * Spawns a new process.
   *
   * @param {string} command - Executable path or command name
   * @param {string[]} [args] - Command line arguments
   * @param {object} [options] - Spawn options
   * @param {string} [options.cwd]
   * @param {object} [options.env]
   * @param {string} [options.stdoutPath]
   * @param {string} [options.stderrPath]
   * @returns {object} Process record { pid, child, exitPromise }
   */
  start(command, args = [], options = {}) {
    const cwd = options.cwd || process.cwd();
    const env = { ...process.env, ...(options.env || {}) };

    let cmd = command;
    let cmdArgs = Array.isArray(args) ? [...args] : [];

    // On Windows, if executing a batch script, wrap safely with cmd.exe without string concatenation
    if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(cmd)) {
      if (/[&|<>^%!\r\n"]/.test(cmd)) {
        throw new Error(`Unsafe characters in batch script path: ${cmd}`);
      }
      cmdArgs = ['/d', '/s', '/c', cmd, ...cmdArgs];
      cmd = process.env.COMSPEC || 'cmd.exe';
    }

    const logStreams = [];
    let stdoutStream = null;
    let stderrStream = null;

    if (options.stdoutPath) {
      const stdoutDir = path.dirname(options.stdoutPath);
      if (!fs.existsSync(stdoutDir)) {
        fs.mkdirSync(stdoutDir, { recursive: true });
      }
      stdoutStream = fs.createWriteStream(options.stdoutPath, { flags: 'a' });
      logStreams.push(stdoutStream);
    }

    if (options.stderrPath) {
      const stderrDir = path.dirname(options.stderrPath);
      if (!fs.existsSync(stderrDir)) {
        fs.mkdirSync(stderrDir, { recursive: true });
      }
      stderrStream = fs.createWriteStream(options.stderrPath, { flags: 'a' });
      logStreams.push(stderrStream);
    }

    const child = spawn(cmd, cmdArgs, {
      cwd,
      env,
      stdio: ['ignore', stdoutStream ? 'pipe' : 'inherit', 'pipe'],
      shell: false,
      windowsHide: true
    });

    if (stdoutStream && child.stdout) {
      child.stdout.pipe(stdoutStream, { end: false });
    }

    let recentStderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        recentStderr += chunk.toString();
        if (recentStderr.length > 8192) {
          recentStderr = recentStderr.slice(-8192);
        }
      });
      if (stderrStream) {
        child.stderr.pipe(stderrStream, { end: false });
      }
    }

    const pid = child.pid;
    let exitResolver;
    const exitPromise = new Promise((resolve) => {
      exitResolver = resolve;
    });

    const entry = {
      pid,
      command: cmd,
      args: cmdArgs,
      child,
      exitPromise,
      exitCode: null,
      exitSignal: null,
      exited: false,
      logStreams,
      get recentStderr() {
        return recentStderr;
      }
    };

    child.on('exit', (code, signal) => {
      entry.exitCode = code;
      entry.exitSignal = signal;
      entry.exited = true;

      // Close log streams
      for (const stream of entry.logStreams) {
        try {
          if (stream && !stream.destroyed) stream.end();
        } catch {
          // ignore
        }
      }

      this.processes.delete(pid);
      this.recentExits.set(pid, {
        pid,
        command: cmd,
        exitCode: code,
        exitSignal: signal,
        recentStderr
      });
      if (this.recentExits.size > 50) {
        const first = this.recentExits.keys().next().value;
        this.recentExits.delete(first);
      }

      exitResolver({ code, signal });
    });

    child.on('error', (err) => {
      entry.error = err;
      if (!entry.exited) {
        entry.exited = true;
        this.processes.delete(pid);
        this.recentExits.set(pid, {
          pid,
          command: cmd,
          exitCode: 1,
          exitSignal: null,
          recentStderr: err.message || recentStderr
        });
        exitResolver({ code: 1, signal: null, error: err });
      }
    });

    if (pid) {
      this.processes.set(pid, entry);
    }

    return {
      pid,
      child,
      exitPromise
    };
  }

  /**
   * Retrieves process info for an active or recently exited process.
   *
   * @param {number|object} processOrPid
   * @returns {object|null}
   */
  getProcess(processOrPid) {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    return this.processes.get(pid) || this.recentExits.get(pid) || null;
  }

  /**
   * Checks if a process is alive.
   *
   * @param {number|object} processOrPid
   * @returns {boolean}
   */
  isAlive(processOrPid) {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    if (!pid || typeof pid !== 'number' || pid <= 0) return false;

    // Check internal tracked state
    const entry = this.processes.get(pid);
    if (entry && entry.exited) return false;

    try {
      // kill(0) tests whether the process exists without sending a signal
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // ESRCH means process doesn't exist. EPERM means process exists but we lack permission to signal.
      return err.code === 'EPERM';
    }
  }

  /**
   * Sends a signal to a process.
   *
   * @param {number|object} processOrPid
   * @param {string|number} [signal='SIGTERM']
   * @returns {boolean}
   */
  signal(processOrPid, signal = 'SIGTERM') {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    if (!pid || !this.isAlive(pid)) return false;

    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for a process to exit up to an optional timeout.
   *
   * @param {number|object} processOrPid
   * @param {number} [timeout]
   * @returns {Promise<{ exited: boolean, code?: number, signal?: string }>}
   */
  async waitForExit(processOrPid, timeout) {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    if (!pid) return { exited: true };

    const entry = this.processes.get(pid);
    if (!this.isAlive(pid)) {
      return { exited: true, code: entry?.exitCode ?? null, signal: entry?.exitSignal ?? null };
    }

    if (entry && entry.exitPromise) {
      if (!timeout || timeout <= 0) {
        const res = await entry.exitPromise;
        return { exited: true, code: res.code, signal: res.signal };
      }

      let timer;
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ exited: false }), timeout);
      });

      const res = await Promise.race([
        entry.exitPromise.then((r) => ({ exited: true, code: r.code, signal: r.signal })),
        timeoutPromise
      ]);
      clearTimeout(timer);
      return res;
    }

    // Process is external or untracked PID: poll liveness
    const hasTimeout = typeof timeout === 'number' && timeout >= 0;
    if (hasTimeout && timeout === 0) {
      return { exited: !this.isAlive(pid) };
    }
    const pollInterval = 50;
    const start = Date.now();
    while (this.isAlive(pid)) {
      if (hasTimeout && Date.now() - start >= timeout) {
        return { exited: false };
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    return { exited: true };
  }

  /**
   * Force kills a process with SIGKILL (and taskkill /T /F on Windows) and waits for exit.
   *
   * @param {number|object} processOrPid
   * @param {number} [waitTimeout=2000]
   * @returns {Promise<boolean>}
   */
  async forceKill(processOrPid, waitTimeout = 2000) {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    if (!pid || !this.isAlive(pid)) return true;

    if (process.platform === 'win32') {
      try {
        await new Promise((resolve) => {
          execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
        });
      } catch {
        // ignore
      }
    }

    this.signal(pid, 'SIGKILL');

    const finalWait = await this.waitForExit(pid, waitTimeout);
    return finalWait.exited;
  }

  /**
   * Stops a process gracefully, then force kills if it does not exit within timeout.
   *
   * @param {number|object} processOrPid
   * @param {object} [options]
   * @param {number} [options.timeout]
   * @param {string} [options.signal='SIGTERM']
   * @returns {Promise<boolean>}
   */
  async stop(processOrPid, options = {}) {
    const pid = typeof processOrPid === 'number' ? processOrPid : processOrPid?.pid;
    if (!pid || !this.isAlive(pid)) return true;

    const timeout = options.timeout !== undefined ? options.timeout : this.defaultShutdownTimeout;
    const termSignal = options.signal || 'SIGTERM';

    // 1. Send graceful termination signal
    this.signal(pid, termSignal);

    // 2. Wait up to timeout
    const exitResult = await this.waitForExit(pid, timeout);
    if (exitResult.exited) {
      return true;
    }

    // 3. Force kill if still alive
    if (this.isAlive(pid)) {
      return this.forceKill(pid, 2000);
    }

    return true;
  }
}
