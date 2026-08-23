import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUnitupDir, readAppMetadata, saveAppMetadata } from '../utils.js';

/**
 * Windows Service Host / Supervisor that manages a child process on Windows.
 */
export class WindowsServiceHost {
  /**
   * @param {object} config - Service configuration or metadata
   */
  constructor(config = {}) {
    this.config = config;
    this.name = config.name;
    this.child = null;
    this.stopping = false;
    this.restartCount = 0;
    this.lastStartTime = null;
    this.resetTimer = null;
    this.logStreams = [];
  }

  /**
   * Initializes logging streams.
   */
  initLogging() {
    const stdoutPath = this.config.logs?.stdout || path.join(getUnitupDir(), 'logs', `${this.name}.log`);
    const stderrPath = this.config.logs?.stderr || path.join(getUnitupDir(), 'logs', `${this.name}-error.log`);

    const logDir = path.dirname(stdoutPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.stdoutStream = fs.createWriteStream(stdoutPath, { flags: 'a' });
    this.stderrStream = fs.createWriteStream(stderrPath, { flags: 'a' });
    this.logStreams.push(this.stdoutStream, this.stderrStream);
  }

  /**
   * Starts the supervised child process.
   */
  start() {
    if (this.stopping) return;
    this.initLogging();

    let command = this.config.command || process.execPath;
    let args = Array.isArray(this.config.args) ? [...this.config.args] : [];
    const cwd = this.config.cwd || process.cwd();
    const env = { ...process.env, ...(this.config.env || {}) };

    // On Windows, if executing a batch script, wrap with cmd.exe
    if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
      args = ['/d', '/s', '/c', `"${command}"`, ...args];
      command = process.env.COMSPEC || 'cmd.exe';
    }

    this.lastStartTime = new Date().toISOString();

    try {
      this.child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (err) {
      this.writeLog(`[unitup host] Failed to spawn process "${command}": ${err.message}\n`, true);
      return;
    }

    const pid = this.child.pid;
    this.writeLog(`[unitup host] Service "${this.name}" started with PID ${pid} at ${this.lastStartTime}\n`);

    // Reset restart count if process stays alive stably
    const resetAfter = typeof this.config.restart?.resetAfter === 'number' ? this.config.restart.resetAfter : 60000;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => {
      this.restartCount = 0;
    }, resetAfter);

    // Update metadata with current PID
    saveAppMetadata({
      ...this.config,
      pid: String(pid),
      started: this.lastStartTime,
      restarts: String(this.restartCount)
    });

    if (this.child.stdout) {
      this.child.stdout.pipe(this.stdoutStream, { end: false });
    }
    if (this.child.stderr) {
      this.child.stderr.pipe(this.stderrStream, { end: false });
    }

    this.child.on('error', (err) => {
      this.writeLog(`[unitup host] Process error: ${err.message}\n`, true);
    });

    this.child.on('exit', (code, signal) => {
      if (this.resetTimer) clearTimeout(this.resetTimer);
      const exitMsg = `[unitup host] Process exited with code ${code}, signal ${signal}\n`;
      this.writeLog(exitMsg);

      this.child = null;

      if (this.stopping) {
        this.cleanup();
        return;
      }

      // Check restart policy
      const restart = this.config.restart || {};
      const shouldRestart = restart.enabled !== false && restart.policy !== 'no';

      if (shouldRestart) {
        const maxRetries = typeof restart.maxRetries === 'number' ? restart.maxRetries : Number.POSITIVE_INFINITY;
        if (this.restartCount < maxRetries) {
          this.restartCount++;
          const delay = typeof restart.delay === 'number' ? restart.delay : 3000;
          this.writeLog(`[unitup host] Restarting service in ${delay}ms (attempt ${this.restartCount})...\n`);
          setTimeout(() => {
            if (!this.stopping) {
              this.start();
            }
          }, delay);
        } else {
          this.writeLog(`[unitup host] Maximum restart attempts (${maxRetries}) reached.\n`, true);
        }
      }
    });
  }

  /**
   * Writes message to stdout or stderr log.
   */
  writeLog(msg, isError = false) {
    const stream = isError ? this.stderrStream : this.stdoutStream;
    if (stream && !stream.destroyed) {
      stream.write(msg);
    }
  }

  /**
   * Stops the supervised child process gracefully.
   *
   * @param {number} [timeout]
   * @returns {Promise<void>}
   */
  async stop(timeout) {
    this.stopping = true;
    if (this.resetTimer) clearTimeout(this.resetTimer);
    const shutdownTimeout = timeout || this.config.shutdownTimeout || 10000;

    if (!this.child || !this.child.pid) {
      this.cleanup();
      return;
    }

    const pid = this.child.pid;
    this.writeLog(`[unitup host] Stopping service "${this.name}" (PID ${pid})...\n`);

    return new Promise((resolve) => {
      let forceKillTimer = null;

      const onExit = () => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this.cleanup();
        resolve();
      };

      if (this.child) {
        this.child.once('exit', onExit);
        try {
          this.child.kill('SIGTERM');
        } catch {
          // ignore
        }

        forceKillTimer = setTimeout(() => {
          this.writeLog('[unitup host] Graceful shutdown timed out. Force killing process...\n', true);
          if (process.platform === 'win32') {
            try {
              execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
            } catch {
              // ignore
            }
          }
          if (this.child) {
            try {
              this.child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
          this.cleanup();
          resolve();
        }, shutdownTimeout);
      } else {
        resolve();
      }
    });
  }

  /**
   * Closes open log streams and resources.
   */
  cleanup() {
    for (const s of this.logStreams) {
      try {
        if (s && !s.destroyed) s.end();
      } catch {
        // ignore
      }
    }
  }
}

// Standalone runner execution entry point when run directly:
// node windows-host.js <serviceName>
if (process.argv[1]?.endsWith('windows-host.js') && process.argv[2]) {
  const serviceName = process.argv[2];
  const meta = readAppMetadata(serviceName);
  if (!meta) {
    process.stderr.write(`[unitup host] Could not read metadata for service "${serviceName}"\n`);
    process.exit(1);
  }

  const host = new WindowsServiceHost(meta);

  process.on('SIGINT', async () => {
    await host.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await host.stop();
    process.exit(0);
  });

  host.start();
}
