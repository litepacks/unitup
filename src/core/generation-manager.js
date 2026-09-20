import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getUnitupDir, sanitizeServiceName } from '../utils.js';

/**
 * Finds an available TCP port on 127.0.0.1.
 * @returns {Promise<number>}
 */
export function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * GenerationManager manages the runtime instances (generations) and persistent state
 * of Unitup-managed services.
 */
export class GenerationManager {
  /**
   * @param {object} options
   * @param {import('./process-manager.js').ProcessManager} options.processManager
   * @param {string} [options.stateDir]
   */
  constructor(options = {}) {
    this.processManager = options.processManager;
    this.stateDir = options.stateDir || path.join(getUnitupDir(), 'state');
    this.cache = new Map(); // serviceName -> state object
  }

  /**
   * Returns the path to the state file for a service.
   * @param {string} serviceName
   * @returns {string}
   */
  getStateFilePath(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    return path.join(this.stateDir, `${safeName}.json`);
  }

  /**
   * Loads state from disk or returns default structure.
   *
   * @param {string} serviceName
   * @returns {object}
   */
  loadState(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    if (this.cache.has(safeName)) {
      return this.cache.get(safeName);
    }

    const filePath = this.getStateFilePath(safeName);
    let state = {
      service: safeName,
      activeGeneration: null,
      generations: {}
    };

    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          state = {
            service: safeName,
            activeGeneration: parsed.activeGeneration ?? null,
            generations: parsed.generations && typeof parsed.generations === 'object' ? parsed.generations : {}
          };
        }
      } catch {
        // Fallback to empty state on read error
      }
    }

    this.cache.set(safeName, state);
    return state;
  }

  /**
   * Persists state atomically to disk.
   *
   * @param {string} serviceName
   * @param {object} [stateToSave]
   */
  saveState(serviceName, stateToSave) {
    const safeName = sanitizeServiceName(serviceName);
    const state = stateToSave || this.loadState(safeName);
    this.cache.set(safeName, state);

    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }

    const filePath = this.getStateFilePath(safeName);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  /**
   * Creates and starts a new generation for a service.
   *
   * @param {string} serviceName
   * @param {object} config - Service configuration or launch options
   * @param {string} config.command
   * @param {string[]} [config.args]
   * @param {string} [config.cwd]
   * @param {object} [config.env]
   * @param {object} [options]
   * @param {number} [options.port] - Optional specific internal port
   * @returns {Promise<object>} The new Generation object
   */
  async create(serviceName, config = {}, options = {}) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);

    // Compute next generation ID
    const existingIds = Object.keys(state.generations)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

    // Allocate internal port
    const internalPort = options.port || (await findFreePort());

    // Prepare child environment with PORT and standard port aliases set to internalPort
    const env = {
      ...(config.env || {}),
      PORT: String(internalPort),
      NODE_PORT: String(internalPort),
      HTTP_PORT: String(internalPort),
      APP_PORT: String(internalPort),
      SERVER_PORT: String(internalPort),
      UNITUP_INTERNAL_PORT: String(internalPort),
      UNITUP_PUBLIC_PORT: String(config.port || options.publicPort || ''),
      UNITUP_GENERATION_ID: String(nextId),
      UNITUP_SERVICE_NAME: safeName
    };

    let stdoutPath = config.logs?.stdout;
    let stderrPath = config.logs?.stderr;
    if (stdoutPath && stdoutPath.includes('[generation]')) {
      stdoutPath = stdoutPath.replace('[generation]', String(nextId));
    }
    if (stderrPath && stderrPath.includes('[generation]')) {
      stderrPath = stderrPath.replace('[generation]', String(nextId));
    }

    const proc = this.processManager.start(config.command, config.args || [], {
      cwd: config.cwd,
      env,
      stdoutPath,
      stderrPath
    });

    const generation = {
      id: nextId,
      service: safeName,
      pid: proc.pid,
      internalPort,
      status: 'starting',
      createdAt: new Date().toISOString()
    };

    state.generations[String(nextId)] = generation;
    this.saveState(safeName, state);

    return generation;
  }

  /**
   * Gets the currently active generation for a service.
   *
   * @param {string} serviceName
   * @returns {object|null}
   */
  getActive(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);
    if (!state.activeGeneration) return null;

    const gen = state.generations[String(state.activeGeneration)];
    if (!gen || gen.status !== 'active') return null;
    return gen;
  }

  /**
   * Gets the previous generation (e.g. for rollback).
   *
   * @param {string} serviceName
   * @returns {object|null}
   */
  getPrevious(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);

    // Look for generation with status 'previous'
    for (const gen of Object.values(state.generations)) {
      if (gen.status === 'previous') {
        return gen;
      }
    }

    // Fallback: highest ID that is not current activeGeneration
    const candidates = Object.values(state.generations)
      .filter((g) => g.id !== state.activeGeneration && g.status !== 'stopped')
      .sort((a, b) => b.id - a.id);

    return candidates[0] || null;
  }

  /**
   * Gets a specific generation by ID.
   *
   * @param {string} serviceName
   * @param {number|string} id
   * @returns {object|null}
   */
  getGeneration(serviceName, id) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);
    return state.generations[String(id)] || null;
  }

  /**
   * Marks a generation as active and demotes existing active generation to 'previous'.
   *
   * @param {object} generation
   */
  markActive(generation) {
    if (!generation || !generation.service) return;
    const safeName = sanitizeServiceName(generation.service);
    const state = this.loadState(safeName);

    if (state.activeGeneration && state.activeGeneration !== generation.id) {
      const prev = state.generations[String(state.activeGeneration)];
      if (prev && prev.status === 'active') {
        prev.status = 'previous';
        prev.deactivatedAt = new Date().toISOString();
      }
    }

    if (state.canaryGeneration === generation.id) {
      state.canaryGeneration = null;
    }

    let current = state.generations[String(generation.id)];
    if (!current) {
      current = { ...generation };
      state.generations[String(generation.id)] = current;
    }
    current.status = 'active';
    current.activatedAt = new Date().toISOString();
    state.activeGeneration = generation.id;
    this.saveState(safeName, state);
  }

  /**
   * Marks a generation as canary with a traffic weight.
   *
   * @param {object} generation
   * @param {number|string} [weight=0.1]
   */
  markCanary(generation, weight = 0.1) {
    if (!generation || !generation.service) return;
    const safeName = sanitizeServiceName(generation.service);
    const state = this.loadState(safeName);

    let current = state.generations[String(generation.id)];
    if (!current) {
      current = { ...generation };
      state.generations[String(generation.id)] = current;
    }

    const parsed = typeof weight === 'string' ? Number.parseFloat(weight.replace('%', '')) : Number(weight);
    const num = Number.isNaN(parsed) ? 0.1 : parsed;
    const normalizedWeight = num > 1 ? num / 100 : num;

    current.status = 'canary';
    current.canaryWeight = Math.max(0, Math.min(1, normalizedWeight));
    current.canaryAt = new Date().toISOString();
    state.canaryGeneration = generation.id;
    this.saveState(safeName, state);
  }

  /**
   * Gets the active canary generation for a service, if any.
   *
   * @param {string} serviceName
   * @returns {object|null}
   */
  getCanary(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);
    if (!state.canaryGeneration) {
      for (const g of Object.values(state.generations)) {
        if (g.status === 'canary') return g;
      }
      return null;
    }
    const gen = state.generations[String(state.canaryGeneration)];
    return gen && gen.status === 'canary' ? gen : null;
  }

  /**
   * Marks a generation as draining.
   *
   * @param {object} generation
   */
  markDraining(generation) {
    if (!generation || !generation.service) return;
    const safeName = sanitizeServiceName(generation.service);
    const state = this.loadState(safeName);

    const current = state.generations[String(generation.id)];
    if (current) {
      current.status = 'draining';
      current.drainingAt = new Date().toISOString();
      if (!current.deactivatedAt && current.activatedAt) {
        current.deactivatedAt = current.drainingAt;
      }
      this.saveState(safeName, state);
    }
  }

  /**
   * Removes or marks stopped an old generation.
   *
   * @param {object} generation
   * @param {boolean} [purge=false]
   */
  remove(generation, purge = false) {
    if (!generation || !generation.service) return;
    const safeName = sanitizeServiceName(generation.service);
    const state = this.loadState(safeName);

    if (state.canaryGeneration === generation.id) {
      state.canaryGeneration = null;
    }

    if (purge) {
      delete state.generations[String(generation.id)];
      if (state.activeGeneration === generation.id) {
        state.activeGeneration = null;
      }
    } else {
      const current = state.generations[String(generation.id)];
      if (current) {
        current.status = 'stopped';
        current.stoppedAt = new Date().toISOString();
        if (!current.deactivatedAt && current.activatedAt) {
          current.deactivatedAt = current.stoppedAt;
        }
      }
    }

    this.saveState(safeName, state);
  }

  /**
   * Scans state for dead processes and cleans up stale records.
   *
   * @param {string} serviceName
   * @returns {number} Count of cleaned up generations
   */
  cleanupStale(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);
    let cleaned = 0;

    for (const [id, gen] of Object.entries(state.generations)) {
      if (gen.status !== 'stopped' && gen.pid) {
        if (!this.processManager.isAlive(gen.pid)) {
          gen.status = 'stopped';
          gen.stoppedAt = new Date().toISOString();
          if (!gen.deactivatedAt && gen.activatedAt) {
            gen.deactivatedAt = gen.stoppedAt;
          }
          if (state.activeGeneration === gen.id) {
            state.activeGeneration = null;
          }
          cleaned++;
        }
      }
    }

    if (cleaned > 0) {
      this.saveState(safeName, state);
    }

    return cleaned;
  }

  /**
   * Lists all generations for a service.
   *
   * @param {string} serviceName
   * @returns {object[]}
   */
  listGenerations(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const state = this.loadState(safeName);
    return Object.values(state.generations).sort((a, b) => a.id - b.id);
  }
}
