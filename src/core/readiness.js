import http from 'node:http';
import net from 'node:net';

/**
 * Custom error thrown when a generation fails readiness within the timeout.
 */
export class ReadinessTimeoutError extends Error {
  constructor(message, generation) {
    super(message);
    this.name = 'ReadinessTimeoutError';
    this.generation = generation;
  }
}

/**
 * Custom error thrown when a generation's process exits unexpectedly during startup.
 */
export class ProcessStartupError extends Error {
  constructor(message, generation) {
    super(message);
    this.name = 'ProcessStartupError';
    this.generation = generation;
  }
}

/**
 * Custom error thrown when an application listens on a hardcoded port instead of process.env.PORT.
 */
export class PortMismatchError extends Error {
  constructor(message, generation, detectedPort) {
    super(message);
    this.name = 'PortMismatchError';
    this.generation = generation;
    this.detectedPort = detectedPort;
  }
}

/**
 * ReadinessChecker provides reusable TCP and HTTP readiness verification.
 */
export class ReadinessChecker {
  /**
   * @param {object} options
   * @param {import('./process-manager.js').ProcessManager} options.processManager
   */
  constructor(options = {}) {
    this.processManager = options.processManager;
  }

  /**
   * Checks if an internal TCP port is accepting connections.
   *
   * @param {number} port
   * @param {string} [host='127.0.0.1']
   * @param {number} [timeout=1000]
   * @returns {Promise<boolean>}
   */
  checkTcp(port, host = '127.0.0.1', timeout = 1000) {
    return new Promise((resolve) => {
      const socket = net.connect({ port, host, timeout });
      let connected = false;

      socket.once('connect', () => {
        connected = true;
        socket.end();
        resolve(true);
      });

      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Checks if an HTTP readiness endpoint returns a healthy status (2xx).
   *
   * @param {number} port
   * @param {string} [path='/']
   * @param {number} [timeout=1500]
   * @returns {Promise<boolean>}
   */
  checkHttp(port, path = '/', timeout = 1500) {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: 'GET',
          timeout
        },
        (res) => {
          // Read response data to avoid socket leak
          res.resume();
          const is2xx = res.statusCode >= 200 && res.statusCode < 300;
          resolve(is2xx);
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.on('error', () => {
        resolve(false);
      });

      req.end();
    });
  }

  /**
   * Performs an immediate one-shot readiness check on a generation.
   *
   * @param {object} generation - { id, pid, internalPort }
   * @param {object} [options]
   * @param {string} [options.path]
   * @returns {Promise<boolean>}
   */
  async ensure(generation, options = {}) {
    if (!generation) return false;

    // 1. Process liveness
    if (generation.pid && this.processManager && !this.processManager.isAlive(generation.pid)) {
      return false;
    }

    // 2. TCP connectivity
    const tcpOk = await this.checkTcp(generation.internalPort);
    if (!tcpOk) return false;

    // 3. Optional HTTP endpoint
    if (options.path) {
      const httpOk = await this.checkHttp(generation.internalPort, options.path);
      if (!httpOk) return false;
    }

    return true;
  }

  /**
   * Polls readiness until the generation is ready, process crashes, or timeout is reached.
   *
   * @param {object} generation - { id, pid, internalPort }
   * @param {object} [options]
   * @param {number} [options.timeout=15000] - Timeout in milliseconds
   * @param {number} [options.interval=50] - Polling interval in milliseconds
   * @param {string} [options.path] - Optional HTTP health check path (e.g. '/health')
   * @returns {Promise<boolean>} Resolves true when ready
   */
  async wait(generation, options = {}) {
    if (!generation || !generation.internalPort) {
      throw new Error('Valid generation with internalPort is required for readiness check.');
    }

    const timeout = options.timeout !== undefined ? options.timeout : 15000;
    const interval = options.interval !== undefined ? options.interval : 50;
    const healthPath = options.path;

    const startTime = Date.now();

    while (true) {
      // 1. Fail fast if process has crashed during startup
      if (generation.pid && this.processManager && !this.processManager.isAlive(generation.pid)) {
        const procInfo = typeof this.processManager.getProcess === 'function' ? this.processManager.getProcess(generation.pid) : null;
        const stderr = procInfo?.recentStderr || '';

        if (stderr.includes('EADDRINUSE') || stderr.includes('address already in use')) {
          const portHint = options.configuredPort ? ` (such as configured port :${options.configuredPort})` : '';
          throw new ProcessStartupError(
            `Generation #${generation.id} (PID ${generation.pid}) crashed with EADDRINUSE during startup. ` +
              `The application likely attempted to bind to a hardcoded port${portHint} instead of reading process.env.PORT (${generation.internalPort}).` +
              `\nDetails:\n${stderr.trim()}`,
            generation
          );
        }

        throw new ProcessStartupError(
          `Generation #${generation.id} (PID ${generation.pid}) process exited unexpectedly during startup.` +
            (stderr ? `\nDetails:\n${stderr.trim()}` : ''),
          generation
        );
      }

      // 2. Check TCP port
      const tcpReady = await this.checkTcp(generation.internalPort);
      if (tcpReady) {
        // 3. If HTTP health check path is configured, verify HTTP 2xx
        if (healthPath) {
          const httpReady = await this.checkHttp(generation.internalPort, healthPath);
          if (httpReady) {
            return true;
          }
        } else {
          return true;
        }
      } else {
        // Port mismatch fast-detection: If application is listening on configured public port instead of internalPort
        const isRouterOnConfiguredPort =
          options.router && options.router.server && options.router.listeningPort === options.configuredPort;

        if (!isRouterOnConfiguredPort && options.configuredPort && options.configuredPort !== generation.internalPort) {
          const isConfiguredPortOpen = await this.checkTcp(options.configuredPort);
          if (isConfiguredPortOpen) {
            throw new PortMismatchError(
              `Port mismatch detected: Generation #${generation.id} (PID ${generation.pid}) is listening on configured public port ${options.configuredPort} ` +
                `instead of the dynamically allocated process.env.PORT (${generation.internalPort}). ` +
                `Please ensure your application code reads process.env.PORT (e.g. app.listen(process.env.PORT || ${options.configuredPort})).`,
              generation,
              options.configuredPort
            );
          }
        }
      }

      // 4. Check timeout
      if (Date.now() - startTime >= timeout) {
        if (generation.pid && this.processManager && this.processManager.isAlive(generation.pid)) {
          throw new ReadinessTimeoutError(
            `Generation #${generation.id} (PID ${generation.pid}) is still running, but did not accept connections on process.env.PORT (${generation.internalPort}) within ${timeout}ms. ` +
              `Ensure your application listens on process.env.PORT (e.g. app.listen(process.env.PORT)).`,
            generation
          );
        }

        throw new ReadinessTimeoutError(
          `Generation #${generation.id} on port ${generation.internalPort} failed readiness check within ${timeout}ms.`,
          generation
        );
      }

      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
