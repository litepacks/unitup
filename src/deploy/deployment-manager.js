import { EventEmitter } from 'node:events';
import { DrainManager } from '../core/drain-manager.js';
import { GenerationManager } from '../core/generation-manager.js';
import { IPCClient } from '../core/ipc.js';
import { DeploymentLock } from '../core/lock.js';
import { ProcessManager } from '../core/process-manager.js';
import { ReadinessChecker } from '../core/readiness.js';
import { Router } from '../core/router.js';
import { readAppMetadata } from '../utils.js';

/**
 * Deployment State Machine states.
 */
export const DeploymentState = {
  IDLE: 'IDLE',
  CREATING_GENERATION: 'CREATING_GENERATION',
  STARTING: 'STARTING',
  WAITING_READY: 'WAITING_READY',
  SWITCHING: 'SWITCHING',
  STABILIZING: 'STABILIZING',
  SETTING_CANARY: 'SETTING_CANARY',
  PROMOTING: 'PROMOTING',
  DRAINING: 'DRAINING',
  STOPPING_PREVIOUS: 'STOPPING_PREVIOUS',
  COMPLETE: 'COMPLETE',
  FAILED: 'FAILED'
};

/**
 * DeploymentManager is orchestration only.
 * It strictly composes the Unitup core primitives to achieve zero-downtime deployment.
 */
export class DeploymentManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {import('../core/generation-manager.js').GenerationManager} [options.generationManager]
   * @param {import('../core/router.js').Router} [options.router]
   * @param {import('../core/readiness.js').ReadinessChecker} [options.readiness]
   * @param {import('../core/drain-manager.js').DrainManager} [options.drainManager]
   * @param {import('../core/process-manager.js').ProcessManager} [options.processManager]
   * @param {import('../core/lock.js').DeploymentLock} [options.lock]
   * @param {number} [options.defaultStabilizationMs=5000]
   */
  constructor(options = {}) {
    super();
    this.generationManager = options.generationManager;
    this.router = options.router;
    this.readiness = options.readiness;
    this.drainManager = options.drainManager;
    this.processManager = options.processManager;
    this.lock = options.lock;
    this.defaultStabilizationMs = options.defaultStabilizationMs !== undefined ? options.defaultStabilizationMs : 5000;
    this.state = DeploymentState.IDLE;
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
   * Emits state change event and optional progress notification.
   * @param {string} newState
   * @param {object} [details]
   * @param {function} [onProgress]
   */
  _setState(newState, details = {}, onProgress) {
    const oldState = this.state;
    this.state = newState;
    const payload = { from: oldState, to: newState, state: newState, ...details };
    this.emit('stateChange', payload);
    if (onProgress) {
      onProgress(payload);
    }
  }

  /**
   * Executes a zero-downtime deployment for a service.
   *
   * @param {string} serviceName
   * @param {object} [serviceConfig] - Config containing command, args, cwd, env, port, deploy opts
   * @param {object} [options]
   * @param {number} [options.publicPort]
   * @param {number} [options.stabilizationWindowMs]
   * @param {number} [options.readinessTimeout]
   * @param {string} [options.readyPath]
   * @param {number} [options.drainTimeout]
   * @param {function(object): void} [options.onProgress]
   * @returns {Promise<object>} Deployment summary
   */
  async deploy(serviceName, serviceConfig = {}, options = {}) {
    if (!serviceName) {
      throw new Error('Service name is required for deployment.');
    }

    // Check if a supervisor daemon is running for this service via IPC
    const ipcClient = new IPCClient(serviceName, options.ipcDir);
    const isRemote = await ipcClient.isAlive();
    if (isRemote) {
      return ipcClient.send(
        {
          action: 'deploy',
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

    // 1. Acquire per-service deployment lock
    await this.lock.acquire(serviceName);

    let next = null;
    let previous = null;

    try {
      this._setState(DeploymentState.IDLE, { service: serviceName }, options.onProgress);

      previous = this.generationManager.getActive(serviceName);

      // 2. CREATING_GENERATION
      this._setState(
        DeploymentState.CREATING_GENERATION,
        { service: serviceName, previousGeneration: previous?.id },
        options.onProgress
      );

      next = await this.generationManager.create(serviceName, config, options);

      // 3. STARTING
      this._setState(
        DeploymentState.STARTING,
        {
          service: serviceName,
          generation: next.id,
          pid: next.pid,
          internalPort: next.internalPort
        },
        options.onProgress
      );

      // 4. WAITING_READY
      this._setState(
        DeploymentState.WAITING_READY,
        { service: serviceName, generation: next.id },
        options.onProgress
      );

      try {
        const readyPath = options.readyPath || config.deploy?.ready;
        const readinessTimeout = options.readinessTimeout || 15000;
        await this.readiness.wait(next, {
          path: readyPath,
          timeout: readinessTimeout,
          configuredPort: options.publicPort || config.port,
          router: this.router
        });
      } catch (readinessErr) {
        // Readiness failed: clean up next generation, leave router pointing at previous
        await this.processManager.stop(next.pid, { timeout: 2000 });
        this.generationManager.remove(next, true);
        this._setState(
          DeploymentState.FAILED,
          { service: serviceName, error: readinessErr.message },
          options.onProgress
        );
        throw readinessErr;
      }

      const isCanary = Boolean(options.canary);
      const rawWeight =
        options.weight !== undefined ? options.weight : options.canaryWeight !== undefined ? options.canaryWeight : 0.1;
      const parsedWeight = typeof rawWeight === 'string' ? Number.parseFloat(rawWeight.replace('%', '')) : Number(rawWeight);
      const numWeight = Number.isNaN(parsedWeight) ? 0.1 : parsedWeight;
      const canaryWeight = Math.max(0, Math.min(1, numWeight > 1 ? numWeight / 100 : numWeight));

      if (isCanary) {
        const publicPort = options.publicPort || config.port;
        if (publicPort && (!this.router.server || this.router.listeningPort !== publicPort)) {
          await this.router.listen(publicPort);
        }

        if (!previous) {
          this.router.switchBackend(serviceName, next);
          this.generationManager.markActive(next);
        }

        this._setState(
          DeploymentState.SETTING_CANARY,
          { service: serviceName, generation: next.id, weight: canaryWeight },
          options.onProgress
        );

        this.router.setCanary(serviceName, next, canaryWeight);
        this.generationManager.markCanary(next, canaryWeight);

        const result = {
          service: serviceName,
          isCanary: true,
          activeGeneration: previous?.id ?? next.id,
          canaryGeneration: next.id,
          canaryWeight,
          downtimeMs: 0,
          status: 'canary'
        };

        this._setState(DeploymentState.COMPLETE, result, options.onProgress);
        return result;
      }

      // 5. SWITCHING
      this._setState(
        DeploymentState.SWITCHING,
        { service: serviceName, generation: next.id },
        options.onProgress
      );

      const publicPort = options.publicPort || config.port;
      if (publicPort && (!this.router.server || this.router.listeningPort !== publicPort)) {
        await this.router.listen(publicPort);
      }

      this.router.switchBackend(serviceName, next);
      this.generationManager.markActive(next);

      // 6. STABILIZING
      this._setState(
        DeploymentState.STABILIZING,
        { service: serviceName, generation: next.id },
        options.onProgress
      );

      const stabilizationMs =
        options.stabilizationWindowMs !== undefined ? options.stabilizationWindowMs : this.defaultStabilizationMs;

      if (stabilizationMs > 0) {
        const checkInterval = 50;
        const stabStart = Date.now();
        while (Date.now() - stabStart < stabilizationMs) {
          if (!this.processManager.isAlive(next.pid)) {
            // New generation crashed during stabilization window! Revert to previous!
            if (previous && this.processManager.isAlive(previous.pid)) {
              this.router.switchBackend(serviceName, previous);
              this.generationManager.markActive(previous);
            }
            this.generationManager.remove(next, true);
            this._setState(
              DeploymentState.FAILED,
              {
                service: serviceName,
                error: `Generation #${next.id} crashed during stabilization window.`
              },
              options.onProgress
            );
            throw new Error(
              `Generation #${next.id} crashed during stabilization window. Rolled back traffic to previous generation #${previous?.id || 'none'}.`
            );
          }
          await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }
      }

      // 7. DRAINING
      if (previous && previous.id !== next.id) {
        this._setState(
          DeploymentState.DRAINING,
          { service: serviceName, generation: previous.id },
          options.onProgress
        );

        this.generationManager.markDraining(previous);
        const drainTimeout = options.drainTimeout || config.deploy?.drainTimeout || 10000;
        await this.drainManager.drain(previous, { timeout: drainTimeout, stopProcess: false });
      }

      // 8. STOPPING_PREVIOUS
      if (previous && previous.id !== next.id) {
        this._setState(
          DeploymentState.STOPPING_PREVIOUS,
          { service: serviceName, generation: previous.id },
          options.onProgress
        );

        await this.processManager.stop(previous.pid, { timeout: 3000 });
        this.generationManager.remove(previous, false);
      }

      // 9. COMPLETE
      const result = {
        service: serviceName,
        previousGeneration: previous?.id ?? null,
        currentGeneration: next.id,
        downtimeMs: 0,
        status: 'complete'
      };

      this._setState(DeploymentState.COMPLETE, result, options.onProgress);
      return result;
    } finally {
      await this.lock.release(serviceName);
    }
  }

  /**
   * Promotes an existing canary generation to 100% active primary and drains previous.
   *
   * @param {string} serviceName
   * @param {object} [config]
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async promote(serviceName, config = {}, options = {}) {
    this._ensurePrimitives(serviceName, options);

    const ipcClient = new IPCClient(serviceName, options.ipcDir);
    if (await ipcClient.isAlive()) {
      return ipcClient.send({ action: 'promote', options }, options.onProgress);
    }

    await this.lock.acquire(serviceName, { timeout: options.lockTimeout || 10000 });

    try {
      const canaryGen = this.generationManager.getCanary(serviceName);
      if (!canaryGen) {
        throw new Error(`No canary generation found for service "${serviceName}" to promote.`);
      }

      const previous = this.generationManager.getActive(serviceName);

      this._setState(
        DeploymentState.PROMOTING,
        { service: serviceName, generation: canaryGen.id, previousGeneration: previous?.id },
        options.onProgress
      );

      // 1. Promote in Router (clears canary, makes it primary)
      this.router.promoteCanary(serviceName);
      this.generationManager.markActive(canaryGen);

      // 2. Drain previous generation
      if (previous && previous.id !== canaryGen.id) {
        this._setState(
          DeploymentState.DRAINING,
          { service: serviceName, generation: previous.id },
          options.onProgress
        );
        this.generationManager.markDraining(previous);
        const drainTimeout = options.drainTimeout || config.deploy?.drainTimeout || 10000;
        await this.drainManager.drain(previous, { timeout: drainTimeout, stopProcess: false });

        this._setState(
          DeploymentState.STOPPING_PREVIOUS,
          { service: serviceName, generation: previous.id },
          options.onProgress
        );
        await this.processManager.stop(previous.pid, { timeout: 3000 });
        this.generationManager.remove(previous, false);
      }

      const result = {
        service: serviceName,
        promotedGeneration: canaryGen.id,
        previousGeneration: previous?.id ?? null,
        downtimeMs: 0,
        status: 'promoted'
      };

      this._setState(DeploymentState.COMPLETE, result, options.onProgress);
      return result;
    } finally {
      await this.lock.release(serviceName);
    }
  }
}

export const defaultDeploymentManager = new DeploymentManager();
