import { DrainManager } from '../core/drain-manager.js';
import { GenerationManager } from '../core/generation-manager.js';
import { IPCClient } from '../core/ipc.js';
import { DeploymentLock } from '../core/lock.js';
import { ProcessManager } from '../core/process-manager.js';
import { ReadinessChecker } from '../core/readiness.js';
import { Router } from '../core/router.js';
import { readAppMetadata } from '../utils.js';

/**
 * RollbackManager provides orchestration for reverting traffic to a previous generation.
 * It strictly composes the Unitup core primitives.
 */
export class RollbackManager {
  /**
   * @param {object} [options]
   * @param {import('../core/generation-manager.js').GenerationManager} [options.generationManager]
   * @param {import('../core/router.js').Router} [options.router]
   * @param {import('../core/readiness.js').ReadinessChecker} [options.readiness]
   * @param {import('../core/drain-manager.js').DrainManager} [options.drainManager]
   * @param {import('../core/process-manager.js').ProcessManager} [options.processManager]
   * @param {import('../core/lock.js').DeploymentLock} [options.lock]
   */
  constructor(options = {}) {
    this.generationManager = options.generationManager;
    this.router = options.router;
    this.readiness = options.readiness;
    this.drainManager = options.drainManager;
    this.processManager = options.processManager;
    this.lock = options.lock;
  }

  _ensurePrimitives(serviceName, options = {}) {
    if (!this.processManager) {
      this.processManager = new ProcessManager();
    }
    if (!this.generationManager) {
      this.generationManager = new GenerationManager({
        processManager: this.processManager,
        stateDir: options.stateDir
      });
    }
    if (!this.router) {
      this.router = new Router();
    }
    if (!this.readiness) {
      this.readiness = new ReadinessChecker({ processManager: this.processManager });
    }
    if (!this.drainManager) {
      this.drainManager = new DrainManager({
        router: this.router,
        processManager: this.processManager
      });
    }
    if (!this.lock) {
      this.lock = new DeploymentLock({
        lockDir: options.lockDir,
        processManager: this.processManager
      });
    }
  }

  /**
   * Rolls back a service to its previous generation.
   *
   * @param {string} serviceName
   * @param {object} [serviceConfig]
   * @param {object} [options]
   * @param {string} [options.readyPath]
   * @param {number} [options.drainTimeout]
   * @param {function(object): void} [options.onProgress]
   * @returns {Promise<object>} Rollback summary
   */
  async rollback(serviceName, serviceConfig = {}, options = {}) {
    if (!serviceName) {
      throw new Error('Service name is required for rollback.');
    }

    // Check if a supervisor daemon is running for this service via IPC
    const ipcClient = new IPCClient(serviceName, options.ipcDir);
    const isRemote = await ipcClient.isAlive();
    if (isRemote) {
      return ipcClient.send(
        {
          action: 'rollback',
          options: { ...options, ...serviceConfig }
        },
        options.onProgress
      );
    }

    this._ensurePrimitives(serviceName, options);

    const config =
      serviceConfig && (serviceConfig.command || serviceConfig.script)
        ? serviceConfig
        : readAppMetadata(serviceName) || serviceConfig || {};

    await this.lock.acquire(serviceName);

    try {
      // Check if a canary generation is running: if so, abort canary and preserve active
      const canary = this.generationManager.getCanary(serviceName);
      if (canary) {
        if (options.onProgress) {
          options.onProgress({ state: 'ABORTING_CANARY', canaryGeneration: canary.id });
        }
        this.router.clearCanary(serviceName);
        const drainTimeout = options.drainTimeout || config.deploy?.drainTimeout || 5000;
        await this.drainManager.drain(canary, { timeout: drainTimeout, stopProcess: true });
        this.generationManager.remove(canary, false);

        const active = this.generationManager.getActive(serviceName);
        return {
          service: serviceName,
          abortedCanary: canary.id,
          activeGeneration: active ? active.id : null,
          status: 'canary_aborted'
        };
      }

      const current = this.generationManager.getActive(serviceName);
      const previous = this.generationManager.getPrevious(serviceName);

      if (!previous) {
        throw new Error(`No previous generation available to roll back to for service "${serviceName}".`);
      }

      if (options.onProgress) {
        options.onProgress({ state: 'CHECKING_PREVIOUS', previous: previous.id });
      }

      // Check if previous is alive
      if (!this.processManager.isAlive(previous.pid)) {
        throw new Error(
          `Previous generation #${previous.id} (PID ${previous.pid}) is no longer running and cannot be rolled back to.`
        );
      }

      // Ensure previous generation is still ready
      const isReady = await this.readiness.ensure(previous, {
        path: options.readyPath || config.deploy?.ready
      });

      if (!isReady) {
        throw new Error(`Previous generation #${previous.id} failed readiness verification.`);
      }

      if (options.onProgress) {
        options.onProgress({ state: 'SWITCHING', targetGeneration: previous.id });
      }

      // Switch router to previous generation
      this.router.switchBackend(serviceName, previous);
      this.generationManager.markActive(previous);

      // Drain and stop the rolled-back current generation
      if (current && current.id !== previous.id) {
        if (options.onProgress) {
          options.onProgress({ state: 'DRAINING_CURRENT', generation: current.id });
        }
        this.generationManager.markDraining(current);
        const drainTimeout = options.drainTimeout || config.deploy?.drainTimeout || 10000;
        await this.drainManager.drain(current, { timeout: drainTimeout, stopProcess: true });
        this.generationManager.remove(current, false);
      }

      const result = {
        service: serviceName,
        rolledBackFrom: current?.id ?? null,
        activeGeneration: previous.id,
        status: 'rolled_back'
      };

      if (options.onProgress) {
        options.onProgress({ state: 'COMPLETE', ...result });
      }

      return result;
    } finally {
      await this.lock.release(serviceName);
    }
  }
}

export const defaultRollbackManager = new RollbackManager();
