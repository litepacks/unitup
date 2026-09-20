/**
 * DrainManager is responsible for gracefully retiring a generation.
 * It tracks in-flight requests, waits for them to complete up to a timeout,
 * and terminates the process gracefully.
 *
 * It works independently from DeploymentManager.
 */
export class DrainManager {
  /**
   * @param {object} options
   * @param {import('./router.js').Router} options.router
   * @param {import('./process-manager.js').ProcessManager} options.processManager
   * @param {number} [options.defaultDrainTimeout=10000]
   */
  constructor(options = {}) {
    this.router = options.router;
    this.processManager = options.processManager;
    this.defaultDrainTimeout = options.defaultDrainTimeout || 10000;
  }

  /**
   * Drains an existing generation: waits for active in-flight requests to finish,
   * then stops the process gracefully.
   *
   * @param {object} generation - { id, pid, internalPort }
   * @param {object} [options]
   * @param {number} [options.timeout] - Max wait time in ms before termination
   * @param {number} [options.pollInterval=50]
   * @param {boolean} [options.stopProcess=true] - Whether to stop the process after draining
   * @returns {Promise<{ drained: boolean, inFlightRemaining: number, timedOut: boolean }>}
   */
  async drain(generation, options = {}) {
    if (!generation) {
      return { drained: true, inFlightRemaining: 0, timedOut: false };
    }

    const timeout = options.timeout !== undefined ? options.timeout : this.defaultDrainTimeout;
    const pollInterval = options.pollInterval !== undefined ? options.pollInterval : 50;
    const shouldStop = options.stopProcess !== false;

    const startTime = Date.now();
    let timedOut = false;

    // 1. Wait for in-flight requests on this generation to complete
    if (this.router) {
      while (this.router.getInFlightCount(generation.id) > 0) {
        if (Date.now() - startTime >= timeout) {
          timedOut = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    const inFlightRemaining = this.router ? this.router.getInFlightCount(generation.id) : 0;

    // 2. Stop process if requested and process is still alive
    if (shouldStop && generation.pid && this.processManager && this.processManager.isAlive(generation.pid)) {
      const elapsed = Date.now() - startTime;
      const remainingTimeout = Math.max(1000, timeout - elapsed);
      await this.processManager.stop(generation.pid, { timeout: remainingTimeout });
    }

    return {
      drained: inFlightRemaining === 0,
      inFlightRemaining,
      timedOut
    };
  }
}
