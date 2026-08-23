import {
  addService,
  getServiceFailures,
  getServiceShow,
  getServiceStatus,
  inspectService,
  listServices,
  removeService,
  restartService,
  runJournalctlLogs,
  startService,
  stopService
} from '../systemd.js';
import { generateUnitContent, getUnitPath, unitFileExists } from '../unit.js';
import { getUnitFilename, sanitizeServiceName } from '../utils.js';
import { ServiceAdapter } from './base.js';

/**
 * Linux platform service adapter using systemd and journald.
 */
export class LinuxAdapter extends ServiceAdapter {
  get name() {
    return 'linux';
  }

  get capabilities() {
    return {
      serviceManager: 'systemd',
      supports: {
        install: true,
        uninstall: true,
        start: true,
        stop: true,
        restart: true,
        enable: true,
        disable: true,
        status: true,
        logs: true,
        restartPolicy: true,
        userServices: true,
        systemServices: true,
        memoryLimits: true,
        schedule: true
      }
    };
  }

  generateService(config) {
    return generateUnitContent({
      name: config.name,
      command: config.command,
      args: config.args,
      script: config.script,
      cwd: config.cwd,
      env: config.env,
      envFile: config.envFile,
      restart: config.restart?.policy || 'on-failure',
      memoryHigh: config.resources?.memoryHigh,
      memoryMax: config.resources?.memoryMax,
      memorySwapMax: config.resources?.memorySwapMax
    });
  }

  async install(config, options = {}) {
    return addService({
      ...config,
      ...options,
      name: config.name,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      envFile: config.envFile,
      restart: config.restart?.policy || 'on-failure',
      memoryHigh: config.resources?.memoryHigh,
      memoryMax: config.resources?.memoryMax,
      memorySwapMax: config.resources?.memorySwapMax,
      force: options.force || config.raw?.force
    });
  }

  async uninstall(name, options = {}) {
    return removeService(name, options);
  }

  async start(name, options = {}) {
    return startService(name, options.enable || false);
  }

  async stop(name, options = {}) {
    return stopService(name);
  }

  async restart(name, options = {}) {
    return restartService(name);
  }

  async enable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const unitFilename = getUnitFilename(safeName);
    const res = await this.run('systemctl', ['--user', 'enable', unitFilename]);
    if (res.code !== 0) {
      throw new Error(`Failed to enable service "${safeName}": ${res.stderr || res.stdout}`);
    }
    return true;
  }

  async disable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const unitFilename = getUnitFilename(safeName);
    const res = await this.run('systemctl', ['--user', 'disable', unitFilename]);
    if (res.code !== 0) {
      throw new Error(`Failed to disable service "${safeName}": ${res.stderr || res.stdout}`);
    }
    return true;
  }

  async status(name, options = {}) {
    const statusObj = await getServiceStatus(name);
    return {
      ...statusObj,
      installed: true,
      state: statusObj.status,
      enabled: statusObj.enabled !== undefined ? statusObj.enabled : true,
      platform: 'linux',
      manager: 'systemd'
    };
  }

  async inspect(name, options = {}) {
    return inspectService(name);
  }

  async logs(name, options = {}) {
    return runJournalctlLogs(name, options);
  }

  async list(options = {}) {
    const list = await listServices(options);
    return list.map((item) => ({
      ...item,
      platform: 'linux',
      manager: 'systemd'
    }));
  }

  isInstalled(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    return unitFileExists(safeName);
  }

  async failures(options = {}) {
    return getServiceFailures();
  }
}
