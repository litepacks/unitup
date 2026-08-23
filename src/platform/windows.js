import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PermissionRequiredError,
  ServiceAlreadyExistsError,
  ServiceNotFoundError,
  ServiceStartError,
  ServiceStopError
} from '../errors.js';
import { readServiceLogs } from '../logs.js';
import {
  deleteAppMetadata,
  formatRelativeTime,
  getAppsDir,
  getUnitupDir,
  readAppMetadata,
  sanitizeServiceName,
  saveAppMetadata
} from '../utils.js';
import { ServiceAdapter } from './base.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WINDOWS_HOST_PATH = path.resolve(__dirname, 'windows-host.js');

/**
 * Windows Service Adapter using Windows SCM (sc.exe) and Unitup Windows Service Host.
 */
export class WindowsAdapter extends ServiceAdapter {
  get name() {
    return 'windows';
  }

  get capabilities() {
    return {
      serviceManager: 'windows',
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
        userServices: false,
        systemServices: true,
        memoryLimits: false,
        schedule: false
      }
    };
  }

  /**
   * Returns the Windows service name.
   * @param {string} name
   * @returns {string}
   */
  getServiceName(name) {
    const safeName = sanitizeServiceName(name);
    return `unitup-${safeName}`;
  }

  /**
   * Generates Windows service creation command parameters.
   *
   * @param {object} config - NormalizedServiceConfig
   * @returns {object}
   */
  generateService(config) {
    const safeName = sanitizeServiceName(config.name);
    const serviceName = this.getServiceName(safeName);
    const nodeExec = process.execPath;
    const binPath = `"${nodeExec}" "${WINDOWS_HOST_PATH}" "${safeName}"`;
    const startType = config.autostart !== false ? 'auto' : 'demand';

    return {
      serviceName,
      displayName: config.displayName && config.displayName !== safeName ? config.displayName : `Unitup - ${safeName}`,
      description: config.description || `unitup service: ${safeName}`,
      binPath,
      startType,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env
    };
  }

  /**
   * Installs a Windows Service.
   *
   * @param {object} config - NormalizedServiceConfig
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async install(config, options = {}) {
    const safeName = sanitizeServiceName(config.name);
    const serviceName = this.getServiceName(safeName);
    const generated = this.generateService(config);

    const isExisting = await this.isInstalled(safeName);
    let wasRunning = false;

    if (isExisting) {
      const currentStatus = await this.status(safeName);
      if (currentStatus.state === 'running') {
        wasRunning = true;
        if (!options.force && !config.raw?.force) {
          throw new ServiceAlreadyExistsError(safeName);
        }
        await this.stop(safeName);
      }
      await this.uninstall(safeName, { force: true });
    }

    // Save app metadata before creating service
    saveAppMetadata({
      ...config,
      name: safeName,
      serviceName,
      hostPath: WINDOWS_HOST_PATH,
      installedAt: new Date().toISOString()
    });

    const scArgs = [
      'create',
      serviceName,
      `binPath= ${generated.binPath}`,
      `displayName= ${generated.displayName}`,
      `start= ${generated.startType}`
    ];

    const res = await this.run('sc.exe', scArgs);
    if (res.code !== 0) {
      if (res.stderr.includes('Access is denied') || res.stdout.includes('Access is denied') || res.code === 5) {
        throw new PermissionRequiredError(
          `Installing a Windows service requires Administrator privileges.\n\nPlease open PowerShell or Command Prompt as Administrator and run:\n  unitup install ${config.name}`,
          'install'
        );
      }
      throw new Error(`Failed to create Windows service "${serviceName}": ${res.stderr || res.stdout}`);
    }

    // Set description if supported
    try {
      await this.run('sc.exe', ['description', serviceName, generated.description]);
    } catch {
      // ignore
    }

    if (options.start || config.raw?.start || wasRunning) {
      await this.start(safeName);
    }

    return {
      name: safeName,
      serviceName,
      displayName: generated.displayName,
      unitPath: generated.binPath
    };
  }

  /**
   * Uninstalls a Windows Service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async uninstall(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);

    const isExisting = await this.isInstalled(safeName);
    if (!isExisting) {
      throw new ServiceNotFoundError(safeName);
    }

    const currentStatus = await this.status(safeName);
    if (currentStatus.state === 'running' && !options.force) {
      throw new Error(
        `Service "${safeName}" is currently running.\n` +
          `Use --force (-f) to remove running services, or stop it first:\n` +
          `  unitup stop ${safeName}`
      );
    }

    if (currentStatus.state === 'running') {
      try {
        await this.stop(safeName);
      } catch {
        // ignore
      }
    }

    const res = await this.run('sc.exe', ['delete', serviceName]);
    if (res.code !== 0) {
      if (res.stderr.includes('Access is denied') || res.stdout.includes('Access is denied') || res.code === 5) {
        throw new PermissionRequiredError(
          `Uninstalling a Windows service requires Administrator privileges.`,
          'uninstall'
        );
      }
      throw new Error(`Failed to delete Windows service "${serviceName}": ${res.stderr || res.stdout}`);
    }

    deleteAppMetadata(safeName);
    return true;
  }

  /**
   * Starts a Windows Service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async start(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);

    const res = await this.run('sc.exe', ['start', serviceName]);
    if (res.code !== 0) {
      if (res.stdout.includes('already running') || res.stdout.includes('1056')) {
        return true;
      }
      if (res.stderr.includes('Access is denied') || res.stdout.includes('Access is denied')) {
        throw new PermissionRequiredError('Starting a Windows service requires Administrator privileges.', 'start');
      }
      throw new ServiceStartError(safeName, res.stderr || res.stdout);
    }
    return true;
  }

  /**
   * Stops a Windows Service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async stop(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);

    const res = await this.run('sc.exe', ['stop', serviceName]);
    if (res.code !== 0) {
      if (res.stdout.includes('not started') || res.stdout.includes('1062')) {
        return true;
      }
      if (res.stderr.includes('Access is denied') || res.stdout.includes('Access is denied')) {
        throw new PermissionRequiredError('Stopping a Windows service requires Administrator privileges.', 'stop');
      }
      throw new ServiceStopError(safeName, res.stderr || res.stdout);
    }
    return true;
  }

  /**
   * Restarts a Windows Service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async restart(name, options = {}) {
    await this.stop(name, options);
    // Give SCM a brief pause
    await new Promise((r) => setTimeout(r, 1000));
    return this.start(name, options);
  }

  /**
   * Enables automatic startup for a Windows service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async enable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);

    const res = await this.run('sc.exe', ['config', serviceName, 'start=', 'auto']);
    return res.code === 0;
  }

  /**
   * Disables automatic startup for a Windows service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async disable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);

    const res = await this.run('sc.exe', ['config', serviceName, 'start=', 'disabled']);
    return res.code === 0;
  }

  /**
   * Gets normalized status for a Windows service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async status(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);
    const meta = readAppMetadata(safeName) || {};

    let state = 'stopped';
    const pid = meta.pid || '-';
    let installed = false;
    const details = {};

    const res = await this.run('sc.exe', ['query', serviceName]);
    if (res.code === 0 && res.stdout) {
      installed = true;
      details.raw = res.stdout;

      if (res.stdout.includes('RUNNING')) {
        state = 'running';
      } else if (res.stdout.includes('STOP_PENDING')) {
        state = 'stopping';
      } else if (res.stdout.includes('START_PENDING')) {
        state = 'starting';
      } else if (res.stdout.includes('STOPPED')) {
        state = 'stopped';
      }
    } else {
      // Check if metadata exists even if sc query failed
      if (meta && Object.keys(meta).length > 0) {
        installed = true;
        state = 'stopped';
      }
    }

    const command = meta.command || process.execPath;
    const argsList = meta.args || (meta.script ? [meta.script] : []);

    return {
      name: safeName,
      installed,
      state,
      status: state,
      enabled: installed,
      pid,
      restarts: meta.restarts || '0',
      started: meta.started ? formatRelativeTime(meta.started) : state === 'running' ? 'active' : 'never',
      startedRaw: meta.started || null,
      command,
      arguments: argsList.join(' '),
      args: argsList,
      script: meta.script || argsList[0] || command,
      cwd: meta.cwd || process.cwd(),
      unitFile: serviceName,
      unitPath: serviceName,
      platform: 'win32',
      manager: 'windows',
      details
    };
  }

  /**
   * Inspects detailed configuration and runtime info for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async inspect(name, options = {}) {
    const statusObj = await this.status(name, options);
    const meta = readAppMetadata(name) || {};
    return {
      ...statusObj,
      runtime: meta.runtime || 'node',
      group: meta.group || 'default',
      node: statusObj.command
    };
  }

  /**
   * Retrieves logs for a Windows service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async logs(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const meta = readAppMetadata(safeName);
    const defaultStdout = path.join(getUnitupDir(), 'logs', `${safeName}.log`);
    const defaultStderr = path.join(getUnitupDir(), 'logs', `${safeName}-error.log`);

    const stdoutPath = meta?.logs?.stdout || defaultStdout;
    const stderrPath = meta?.logs?.stderr || defaultStderr;

    let paths = [stdoutPath, stderrPath];
    if (options.output === 'stdout' || options.stdout) {
      paths = [stdoutPath];
    } else if (options.output === 'stderr' || options.stderr) {
      paths = [stderrPath];
    }

    return readServiceLogs(paths, options);
  }

  /**
   * Lists all unitup Windows services.
   *
   * @param {object} [options]
   * @returns {Promise<Array<object>>}
   */
  async list(options = {}) {
    const appsDir = getAppsDir();
    if (!fs.existsSync(appsDir)) return [];

    const files = fs.readdirSync(appsDir).filter((f) => f.endsWith('.json'));
    const result = [];
    const targetGroup = options.group
      ? (options.group.startsWith('@') ? options.group.slice(1) : options.group).toLowerCase()
      : null;

    for (const file of files) {
      const serviceName = file.replace(/\.json$/, '');
      const meta = readAppMetadata(serviceName);
      if (!meta) continue;

      const group = meta.group || 'default';
      if (targetGroup && group.toLowerCase() !== targetGroup) {
        continue;
      }

      try {
        const stat = await this.status(serviceName);
        const cmdBase = path.basename(stat.command || 'node');
        const argsStr = (stat.args || []).map((a) => path.basename(a)).join(' ');
        const commandSummary = (cmdBase + (argsStr ? ` ${argsStr}` : '')).trim();

        result.push({
          name: serviceName,
          runtime: meta.runtime || 'node',
          group,
          status: stat.state,
          enabled: stat.enabled ? 'yes' : 'no',
          pid: stat.pid,
          command: commandSummary,
          uptime: stat.started,
          restarts: stat.restarts || '0',
          platform: 'win32',
          manager: 'windows'
        });
      } catch {
        result.push({
          name: serviceName,
          runtime: meta.runtime || 'node',
          group,
          status: 'unknown',
          enabled: 'unknown',
          pid: '-',
          command: 'unknown',
          uptime: 'never',
          restarts: '0',
          platform: 'win32',
          manager: 'windows'
        });
      }
    }

    return result;
  }

  async isInstalled(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const serviceName = this.getServiceName(safeName);
    const res = await this.run('sc.exe', ['query', serviceName]);
    if (res.code === 0) return true;
    const meta = readAppMetadata(safeName);
    return !!meta;
  }

  async failures(options = {}) {
    const all = await this.list(options);
    return all.filter((i) => i.status === 'failed');
  }
}
