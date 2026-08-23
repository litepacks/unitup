import { getAdapter } from '../platform/index.js';
import { readAppMetadata, readScheduleMetadata, sanitizeServiceName } from '../utils.js';
import { mergeConfigWithOptions } from './config.js';
import { normalizeServiceConfig } from './normalize.js';

/**
 * ServiceManager orchestrates service operations across platforms.
 */
export class ServiceManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.platform]
   * @param {import('../platform/base.js').ServiceAdapter} [opts.adapter]
   */
  constructor(opts = {}) {
    this.platformName = opts.platform;
    this._adapter = opts.adapter;
  }

  get adapter() {
    return this._adapter || getAdapter(this.platformName);
  }

  /**
   * Gets the platform capabilities.
   */
  get capabilities() {
    return this.adapter.capabilities;
  }

  /**
   * Generates the native service file/config from options (dry-run mode).
   *
   * @param {object} rawOpts
   * @returns {Promise<string|object>}
   */
  async generate(rawOpts = {}) {
    const merged = mergeConfigWithOptions(rawOpts);
    const normalized = await normalizeServiceConfig(merged);
    return this.adapter.generateService(normalized);
  }

  /**
   * Installs/registers a service.
   *
   * @param {object} rawOpts
   * @returns {Promise<object>}
   */
  async install(rawOpts = {}) {
    const merged = mergeConfigWithOptions(rawOpts);
    const normalized = await normalizeServiceConfig(merged);
    return this.adapter.install(normalized, {
      force: !!rawOpts.force,
      start: !!rawOpts.start,
      system: !!rawOpts.system
    });
  }

  /**
   * Uninstalls/removes a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async uninstall(name, options = {}) {
    if (name && typeof name === 'string' && name.startsWith('@')) {
      const all = await this.list({ group: name });
      if (all.length === 0) {
        throw new Error(`No services found in group "${name}".`);
      }
      for (const item of all) {
        await this.uninstall(item.name, options);
      }
      return true;
    }
    return this.adapter.uninstall(name, options);
  }

  /**
   * Starts a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async start(name, options = {}) {
    if (name && typeof name === 'string' && name.startsWith('@')) {
      const all = await this.list({ group: name });
      if (all.length === 0) {
        throw new Error(`No services found in group "${name}".`);
      }
      for (const item of all) {
        await this.start(item.name, options);
      }
      return true;
    }
    return this.adapter.start(name, options);
  }

  /**
   * Stops a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async stop(name, options = {}) {
    if (name && typeof name === 'string' && name.startsWith('@')) {
      const all = await this.list({ group: name });
      if (all.length === 0) {
        throw new Error(`No services found in group "${name}".`);
      }
      for (const item of all) {
        await this.stop(item.name, options);
      }
      return true;
    }
    return this.adapter.stop(name, options);
  }

  /**
   * Restarts a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async restart(name, options = {}) {
    if (name && typeof name === 'string' && name.startsWith('@')) {
      const all = await this.list({ group: name });
      if (all.length === 0) {
        throw new Error(`No services found in group "${name}".`);
      }
      for (const item of all) {
        await this.restart(item.name, options);
      }
      return true;
    }
    return this.adapter.restart(name, options);
  }

  /**
   * Enables a service for automatic startup.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async enable(name, options = {}) {
    return this.adapter.enable(name, options);
  }

  /**
   * Disables automatic startup for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async disable(name, options = {}) {
    return this.adapter.disable(name, options);
  }

  /**
   * Gets normalized status for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async status(name, options = {}) {
    return this.adapter.status(name, options);
  }

  /**
   * Inspects detailed configuration and runtime info for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async inspect(name, options = {}) {
    return this.adapter.inspect(name, options);
  }

  /**
   * Retrieves or streams logs for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async logs(name, options = {}) {
    return this.adapter.logs(name, options);
  }

  /**
   * Lists all services.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async list(options = {}) {
    return this.adapter.list(options);
  }

  /**
   * Lists failed services.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async failures(options = {}) {
    return this.adapter.failures(options);
  }

  /**
   * Checks if a service is installed.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>|boolean}
   */
  isInstalled(name, options = {}) {
    return this.adapter.isInstalled(name, options);
  }
}

/**
 * Default global ServiceManager instance.
 */
export const defaultManager = new ServiceManager();
