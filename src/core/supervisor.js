import { readAppMetadata, sanitizeServiceName } from '../utils.js';
import { DrainManager } from './drain-manager.js';
import { GenerationManager } from './generation-manager.js';
import { IPCServer } from './ipc.js';
import { DeploymentLock } from './lock.js';
import { ProcessManager } from './process-manager.js';
import { ReadinessChecker } from './readiness.js';
import { Router } from './router.js';
import { DeploymentManager } from '../deploy/deployment-manager.js';
import { RollbackManager } from '../deploy/rollback-manager.js';

/**
 * Supervisor is the long-running host managed by the OS service manager (unitupd).
 * It owns Router, child application generation processes, and IPC for control.
 */
export class Supervisor {
  /**
   * @param {string} serviceName
   * @param {object} [serviceConfig]
   * @param {object} [options]
   */
  constructor(serviceName, serviceConfig = null, options = {}) {
    this.serviceName = sanitizeServiceName(serviceName);
    this.config = serviceConfig || readAppMetadata(this.serviceName) || {};
    this.options = options;

    this.processManager = new ProcessManager({
      defaultShutdownTimeout: this.config.shutdownTimeout || 5000
    });

    this.generationManager = new GenerationManager({
      processManager: this.processManager,
      stateDir: options.stateDir
    });

    this.router = new Router();
    this.readiness = new ReadinessChecker({ processManager: this.processManager });
    this.drainManager = new DrainManager({
      router: this.router,
      processManager: this.processManager
    });

    this.lock = new DeploymentLock({
      lockDir: options.lockDir,
      processManager: this.processManager
    });

    this.deploymentManager = new DeploymentManager({
      generationManager: this.generationManager,
      router: this.router,
      readiness: this.readiness,
      drainManager: this.drainManager,
      processManager: this.processManager,
      lock: this.lock,
      defaultStabilizationMs: options.stabilizationWindowMs !== undefined ? options.stabilizationWindowMs : 5000
    });

    this.rollbackManager = new RollbackManager({
      generationManager: this.generationManager,
      router: this.router,
      readiness: this.readiness,
      drainManager: this.drainManager,
      processManager: this.processManager,
      lock: this.lock
    });

    this.ipcServer = new IPCServer({
      serviceName: this.serviceName,
      ipcDir: options.ipcDir,
      handler: this._handleIpcMessage.bind(this)
    });

    this.running = false;
  }

  async _handleIpcMessage(message, sendProgress) {
    if (!message || typeof message !== 'object') {
      throw new Error('Invalid IPC request format');
    }

    const action = message.action;

    if (action === 'deploy') {
      // Reload config in case it changed on disk
      const freshConfig = readAppMetadata(this.serviceName) || this.config;
      return this.deploymentManager.deploy(this.serviceName, freshConfig, {
        ...message.options,
        onProgress: sendProgress
      });
    }

    if (action === 'rollback') {
      const freshConfig = readAppMetadata(this.serviceName) || this.config;
      return this.rollbackManager.rollback(this.serviceName, freshConfig, {
        ...message.options,
        onProgress: sendProgress
      });
    }

    if (action === 'promote') {
      const freshConfig = readAppMetadata(this.serviceName) || this.config;
      return this.deploymentManager.promote(this.serviceName, freshConfig, {
        ...message.options,
        onProgress: sendProgress
      });
    }

    if (action === 'status') {
      const active = this.generationManager.getActive(this.serviceName);
      const canaryGen = this.generationManager.getCanary(this.serviceName);
      const canaryRouter = this.router.getCanary(this.serviceName);
      return {
        service: this.serviceName,
        activeGeneration: active,
        previousGeneration: this.generationManager.getPrevious(this.serviceName),
        canaryGeneration: canaryGen,
        canaryWeight: canaryRouter?.weight ?? canaryGen?.canaryWeight ?? null,
        generations: this.generationManager.listGenerations(this.serviceName),
        routerPort: this.router.listeningPort,
        inFlightRequests: active ? this.router.getInFlightCount(active.id) : 0
      };
    }

    if (action === 'stop') {
      setTimeout(() => this.stop(), 50);
      return { stopped: true };
    }

    throw new Error(`Unknown supervisor action: "${action}"`);
  }

  /**
   * Starts the supervisor, IPC server, and initial generation.
   */
  async start() {
    this.running = true;

    // 1. Start IPC server for remote CLI commands
    await this.ipcServer.start();

    // 2. Load state and cleanup stale dead PIDs from previous runs
    this.generationManager.loadState(this.serviceName);
    this.generationManager.cleanupStale(this.serviceName);

    const publicPort = this.options.publicPort || this.config.port;

    // 3. Check if there is an active running generation from persisted state
    const active = this.generationManager.getActive(this.serviceName);
    if (active && this.processManager.isAlive(active.pid)) {
      if (publicPort) {
        await this.router.listen(publicPort);
      }
      this.router.switchBackend(this.serviceName, active);
    } else {
      // Start initial generation
      await this.deploymentManager.deploy(this.serviceName, this.config, {
        publicPort,
        stabilizationWindowMs: this.options.stabilizationWindowMs
      });
    }

    return this;
  }

  /**
   * Stops the supervisor, closes router, and drains all active generations.
   */
  async stop() {
    if (!this.running) return;
    this.running = false;

    // 1. Close IPC server
    await this.ipcServer.close();

    // 2. Close router
    await this.router.close();

    // 3. Drain and stop active generations
    const active = this.generationManager.getActive(this.serviceName);
    if (active) {
      await this.drainManager.drain(active, { timeout: 5000, stopProcess: true });
      this.generationManager.remove(active, false);
    }

    // Stop any other untracked or running child processes
    for (const [pid] of this.processManager.processes.entries()) {
      await this.processManager.stop(pid, { timeout: 2000 });
    }
  }

  /**
   * Standalone entry point when running `unitup supervisor <serviceName>`.
   *
   * @param {string} serviceName
   */
  static async run(serviceName) {
    if (!serviceName) {
      process.stderr.write('Error: Service name is required to run supervisor.\n');
      process.exit(1);
    }

    const supervisor = new Supervisor(serviceName);

    const onSignal = async (sig) => {
      try {
        await supervisor.stop();
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    try {
      await supervisor.start();
    } catch (err) {
      process.stderr.write(`[unitup supervisor] Failed to start: ${err.message}\n`);
      process.exit(1);
    }
  }
}
