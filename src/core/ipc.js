import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getUnitupDir, sanitizeServiceName } from '../utils.js';

/**
 * Returns the IPC endpoint path for a service (Unix domain socket or Windows Named Pipe).
 * @param {string} serviceName
 * @param {string} [ipcDir]
 * @returns {string}
 */
export function getIpcPath(serviceName, ipcDir) {
  const safeName = sanitizeServiceName(serviceName);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\unitup-${safeName}`;
  }
  const dir = ipcDir || path.join(getUnitupDir(), 'ipc');
  return path.join(dir, `${safeName}.sock`);
}

/**
 * Lightweight IPC Server hosted by the supervisor.
 */
export class IPCServer {
  /**
   * @param {object} options
   * @param {string} options.serviceName
   * @param {function(object, function(object): void): Promise<object>} options.handler
   * @param {string} [options.ipcDir]
   */
  constructor(options) {
    this.serviceName = options.serviceName;
    this.handler = options.handler;
    this.ipcPath = getIpcPath(this.serviceName, options.ipcDir);
    this.server = null;
  }

  async start() {
    if (process.platform !== 'win32') {
      const dir = path.dirname(this.ipcPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.ipcPath)) {
        try {
          fs.unlinkSync(this.ipcPath);
        } catch {
          // ignore
        }
      }
    }

    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        let buffer = '';

        socket.on('data', async (chunk) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop(); // preserve unfinished line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            let message;
            try {
              message = JSON.parse(trimmed);
            } catch (err) {
              socket.write(`${JSON.stringify({ type: 'error', error: 'Invalid JSON' })}\n`);
              continue;
            }

            const sendProgress = (progressData) => {
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify({ type: 'progress', ...progressData })}\n`);
              }
            };

            try {
              const result = await this.handler(message, sendProgress);
              if (!socket.destroyed) {
                socket.write(`${JSON.stringify({ type: 'result', data: result })}\n`);
              }
            } catch (err) {
              if (!socket.destroyed) {
                socket.write(
                  `${JSON.stringify({
                    type: 'error',
                    error: err.message,
                    name: err.name,
                    stack: err.stack
                  })}\n`
                );
              }
            }
          }
        });
      });

      server.on('error', reject);
      server.listen(this.ipcPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  async close() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        if (process.platform !== 'win32' && fs.existsSync(this.ipcPath)) {
          try {
            fs.unlinkSync(this.ipcPath);
          } catch {
            // ignore
          }
        }
        resolve();
      });
    });
  }

  async stop() {
    return this.close();
  }
}

/**
 * Lightweight IPC Client used by CLI to talk to the running supervisor.
 */
export class IPCClient {
  /**
   * @param {string} serviceName
   * @param {string} [ipcDir]
   */
  constructor(serviceName, ipcDir) {
    this.serviceName = serviceName;
    this.ipcPath = getIpcPath(serviceName, ipcDir);
  }

  /**
   * Checks if the supervisor IPC socket is reachable.
   * @param {number} [timeout=1000]
   * @returns {Promise<boolean>}
   */
  async isAlive(timeout = 1000) {
    return new Promise((resolve) => {
      const socket = net.connect(this.ipcPath);
      let connected = false;

      socket.once('connect', () => {
        connected = true;
        socket.destroy();
        resolve(true);
      });

      socket.setTimeout(timeout, () => {
        socket.destroy();
        resolve(false);
      });

      socket.once('error', () => {
        resolve(false);
      });
    });
  }

  /**
   * Sends a request to the supervisor and streams progress updates.
   *
   * @param {object} payload
   * @param {function(object): void} [onProgress]
   * @param {number} [timeout=120000]
   * @returns {Promise<any>}
   */
  async send(payload, onProgress, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.ipcPath);
      let buffer = '';
      let timer = null;

      if (timeout > 0) {
        timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`IPC request timed out after ${timeout}ms.`));
        }, timeout);
      }

      socket.once('connect', () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const msg = JSON.parse(trimmed);
            if (msg.type === 'progress') {
              if (onProgress) onProgress(msg);
            } else if (msg.type === 'result') {
              if (timer) clearTimeout(timer);
              socket.destroy();
              resolve(msg.data);
            } else if (msg.type === 'error') {
              if (timer) clearTimeout(timer);
              socket.destroy();
              const err = new Error(msg.error);
              err.name = msg.name || 'Error';
              reject(err);
            }
          } catch {
            // Ignore parse errors on individual chunks
          }
        }
      });

      socket.once('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      socket.once('close', () => {
        if (timer) clearTimeout(timer);
      });
    });
  }
}
