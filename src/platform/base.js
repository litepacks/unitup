import { UnsupportedPlatformError } from '../errors.js';
import { runCommand } from '../systemd.js';

/**
 * Base ServiceAdapter class defining the cross-platform contract for service management.
 */
export class ServiceAdapter {
  /**
   * @param {object} [options]
   */
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Platform identifier name.
   * @type {string}
   */
  get name() {
    return 'base';
  }

  /**
   * Platform capabilities metadata.
   * @type {object}
   */
  get capabilities() {
    return {
      serviceManager: 'none',
      supports: {
        install: false,
        uninstall: false,
        start: false,
        stop: false,
        restart: false,
        enable: false,
        disable: false,
        status: false,
        logs: false,
        restartPolicy: false,
        userServices: false,
        systemServices: false,
        memoryLimits: false,
        schedule: false
      }
    };
  }

  /**
   * Executes a command using the configured command runner.
   *
   * @param {string} cmd
   * @param {string[]} args
   * @param {object} [opts]
   * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
   */
  async run(cmd, args, opts) {
    return runCommand(cmd, args, opts);
  }

  /**
   * Generates the service definition (unit file, plist, etc.) from normalized config.
   *
   * @param {object} config - NormalizedServiceConfig
   * @returns {string|object}
   */
  generateService(config) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Installs a service from normalized config.
   *
   * @param {object} config - NormalizedServiceConfig
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async install(config, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Uninstalls a service by name.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async uninstall(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Starts a service by name.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async start(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Stops a service by name.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async stop(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Restarts a service by name.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async restart(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Enables automatic startup for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async enable(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Disables automatic startup for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async disable(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Gets normalized status for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async status(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Inspects detailed configuration and runtime info for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async inspect(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Retrieves or streams logs for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async logs(name, options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Lists all services.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async list(options = {}) {
    throw new UnsupportedPlatformError(this.name);
  }

  /**
   * Checks if a service is installed.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>|boolean}
   */
  isInstalled(name, options = {}) {
    return false;
  }

  /**
   * Lists failed services.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async failures(options = {}) {
    return [];
  }
}
