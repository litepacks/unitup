import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

/**
 * Escapes XML special characters.
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates XML plist for a dict item.
 */
function dictToPlistXml(dict) {
  const lines = ['<dict>'];
  for (const [key, value] of Object.entries(dict)) {
    lines.push(`  <key>${escapeXml(key)}</key>`);
    if (typeof value === 'boolean') {
      lines.push(`  <${value ? 'true' : 'false'}/>`);
    } else if (typeof value === 'number') {
      lines.push(`  <integer>${value}</integer>`);
    } else if (typeof value === 'string') {
      lines.push(`  <string>${escapeXml(value)}</string>`);
    } else if (Array.isArray(value)) {
      lines.push('  <array>');
      for (const item of value) {
        if (typeof item === 'boolean') {
          lines.push(`    <${item ? 'true' : 'false'}/>`);
        } else if (typeof item === 'number') {
          lines.push(`    <integer>${item}</integer>`);
        } else {
          lines.push(`    <string>${escapeXml(item)}</string>`);
        }
      }
      lines.push('  </array>');
    } else if (value && typeof value === 'object') {
      lines.push('  <dict>');
      for (const [subKey, subVal] of Object.entries(value)) {
        lines.push(`    <key>${escapeXml(subKey)}</key>`);
        if (typeof subVal === 'boolean') {
          lines.push(`    <${subVal ? 'true' : 'false'}/>`);
        } else if (typeof subVal === 'number') {
          lines.push(`    <integer>${subVal}</integer>`);
        } else {
          lines.push(`    <string>${escapeXml(subVal)}</string>`);
        }
      }
      lines.push('  </dict>');
    }
  }
  lines.push('</dict>');
  return lines.join('\n');
}

/**
 * macOS launchd service adapter.
 */
export class MacOSAdapter extends ServiceAdapter {
  get name() {
    return 'macos';
  }

  get capabilities() {
    return {
      serviceManager: 'launchd',
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
        memoryLimits: false,
        schedule: false
      }
    };
  }

  /**
   * Returns the launchd label for a service.
   * @param {string} name
   * @returns {string}
   */
  getLabel(name) {
    const safeName = sanitizeServiceName(name);
    return `dev.unitup.${safeName}`;
  }

  /**
   * Returns the plist directory (user LaunchAgents or system LaunchDaemons).
   * @param {boolean} [system=false]
   * @returns {string}
   */
  getPlistDir(system = false) {
    if (system) {
      return '/Library/LaunchDaemons';
    }
    const home = os.homedir();
    return path.join(home, 'Library', 'LaunchAgents');
  }

  /**
   * Returns the plist file path for a service.
   * @param {string} name
   * @param {boolean} [system=false]
   * @returns {string}
   */
  getPlistPath(name, system = false) {
    const label = this.getLabel(name);
    return path.join(this.getPlistDir(system), `${label}.plist`);
  }

  /**
   * Gets the launchctl domain target (gui/<uid> or system).
   * @param {boolean} [system=false]
   * @returns {string}
   */
  getDomain(system = false) {
    if (system) return 'system';
    const uid = process.getuid ? process.getuid() : os.userInfo().uid || 501;
    return `gui/${uid}`;
  }

  /**
   * Generates .plist XML content for a service from normalized config.
   *
   * @param {object} config - NormalizedServiceConfig
   * @returns {string}
   */
  generateService(config) {
    const safeName = sanitizeServiceName(config.name);
    const label = this.getLabel(safeName);

    const programArguments = [config.command, ...(config.args || [])];

    // Ensure log directory exists
    const stdoutLog = config.logs?.stdout || path.join(getUnitupDir(), 'logs', `${safeName}.log`);
    const stderrLog = config.logs?.stderr || path.join(getUnitupDir(), 'logs', `${safeName}-error.log`);

    const dict = {
      Label: label,
      ProgramArguments: programArguments,
      WorkingDirectory: config.cwd || process.cwd(),
      RunAtLoad: config.autostart !== false,
      StandardOutPath: stdoutLog,
      StandardErrorPath: stderrLog
    };

    // Restart policy
    if (config.restart?.enabled !== false && config.restart?.policy !== 'no') {
      dict.KeepAlive = {
        SuccessfulExit: false,
        Crashed: true
      };
      if (typeof config.restart?.delay === 'number' && config.restart.delay > 0) {
        dict.ThrottleInterval = Math.ceil(config.restart.delay / 1000);
      }
    } else {
      dict.KeepAlive = false;
    }

    // Environment variables
    const envObj = { ...(config.env || {}) };
    const binDir = path.dirname(config.command);
    if (!envObj.PATH) {
      envObj.PATH = [binDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || '']
        .filter((p, i, self) => p && self.indexOf(p) === i)
        .join(':');
    }

    if (Object.keys(envObj).length > 0) {
      dict.EnvironmentVariables = envObj;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${dictToPlistXml(dict)}
</plist>
`;
  }

  /**
   * Installs a service as a launchd agent/daemon.
   *
   * @param {object} config - NormalizedServiceConfig
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async install(config, options = {}) {
    const safeName = sanitizeServiceName(config.name);
    const system = !!(options.system || config.system);

    if (system && process.getuid && process.getuid() !== 0) {
      throw new PermissionRequiredError(
        'Installing a system-level launch daemon requires administrator privileges.\n\nTry:\n  sudo unitup install --system',
        'install-system'
      );
    }

    const plistDir = this.getPlistDir(system);
    if (!fs.existsSync(plistDir)) {
      fs.mkdirSync(plistDir, { recursive: true });
    }

    // Ensure logs dir exists
    const logsDir = path.dirname(config.logs?.stdout || path.join(getUnitupDir(), 'logs', `${safeName}.log`));
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const plistPath = this.getPlistPath(safeName, system);
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);

    const exists = fs.existsSync(plistPath);
    let wasRunning = false;

    if (exists) {
      const currentStatus = await this.status(safeName, { system });
      if (currentStatus.state === 'running') {
        wasRunning = true;
        if (!options.force && !config.raw?.force) {
          throw new ServiceAlreadyExistsError(safeName);
        }
        await this.stop(safeName, { system });
      }

      // Try bootout existing service before overwriting
      try {
        await this.run('launchctl', ['bootout', `${domain}/${label}`]);
      } catch {
        try {
          await this.run('launchctl', ['unload', '-w', plistPath]);
        } catch {
          // ignore
        }
      }
    }

    const plistContent = this.generateService(config);
    fs.writeFileSync(plistPath, plistContent, 'utf8');

    // Save unitup metadata
    saveAppMetadata({
      ...config,
      name: safeName,
      system,
      plistPath,
      label
    });

    // Bootstrap into launchd
    let bootstrapSuccess = false;
    try {
      const res = await this.run('launchctl', ['bootstrap', domain, plistPath]);
      if (res.code === 0) {
        bootstrapSuccess = true;
      }
    } catch {
      // fallback
    }

    if (!bootstrapSuccess) {
      try {
        await this.run('launchctl', ['load', '-w', plistPath]);
      } catch {
        // ignore load errors if already registered
      }
    }

    if (options.start || config.raw?.start || wasRunning) {
      await this.start(safeName, { system });
    }

    return {
      name: safeName,
      unitPath: plistPath,
      label,
      system
    };
  }

  /**
   * Uninstalls a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async uninstall(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const plistPath = this.getPlistPath(safeName, system);
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);

    if (!fs.existsSync(plistPath)) {
      throw new ServiceNotFoundError(safeName);
    }

    const currentStatus = await this.status(safeName, { system });
    if (currentStatus.state === 'running' && !options.force) {
      throw new Error(
        `Service "${safeName}" is currently running.\n` +
          `Use --force (-f) to remove running services, or stop it first:\n` +
          `  unitup stop ${safeName}`
      );
    }

    // Stop and bootout
    try {
      await this.run('launchctl', ['bootout', `${domain}/${label}`]);
    } catch {
      try {
        await this.run('launchctl', ['unload', '-w', plistPath]);
      } catch {
        // ignore
      }
    }

    // Delete plist file
    try {
      if (fs.existsSync(plistPath)) {
        fs.unlinkSync(plistPath);
      }
    } catch (err) {
      throw new Error(`Failed to remove plist file "${plistPath}": ${err.message}`);
    }

    deleteAppMetadata(safeName);
    return true;
  }

  /**
   * Starts a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async start(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);
    const plistPath = this.getPlistPath(safeName, system);

    if (!fs.existsSync(plistPath)) {
      throw new ServiceNotFoundError(safeName);
    }

    // 1. Try kickstart
    let res = await this.run('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    if (res.code === 0) return true;

    // 2. Fallback to start
    res = await this.run('launchctl', ['start', label]);
    if (res.code === 0) return true;

    // 3. Fallback: try bootstrap then kickstart
    await this.run('launchctl', ['bootstrap', domain, plistPath]);
    res = await this.run('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    if (res.code === 0) return true;

    throw new ServiceStartError(safeName, res.stderr || res.stdout);
  }

  /**
   * Stops a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async stop(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);
    const plistPath = this.getPlistPath(safeName, system);

    if (!fs.existsSync(plistPath)) {
      throw new ServiceNotFoundError(safeName);
    }

    // 1. Try kill SIGTERM
    let res = await this.run('launchctl', ['kill', 'SIGTERM', `${domain}/${label}`]);
    if (res.code === 0) return true;

    // 2. Fallback to stop
    res = await this.run('launchctl', ['stop', label]);
    if (res.code === 0) return true;

    return true;
  }

  /**
   * Restarts a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async restart(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);

    // Try kickstart with -k (kill existing and restart)
    const res = await this.run('launchctl', ['kickstart', '-k', `${domain}/${label}`]);
    if (res.code === 0) return true;

    // Fallback: stop then start
    await this.stop(safeName, options);
    return this.start(safeName, options);
  }

  /**
   * Enables a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async enable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);

    const res = await this.run('launchctl', ['enable', `${domain}/${label}`]);
    return res.code === 0;
  }

  /**
   * Disables a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<boolean>}
   */
  async disable(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);

    const res = await this.run('launchctl', ['disable', `${domain}/${label}`]);
    return res.code === 0;
  }

  /**
   * Gets normalized status for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async status(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    const label = this.getLabel(safeName);
    const domain = this.getDomain(system);
    const plistPath = this.getPlistPath(safeName, system);

    const installed = fs.existsSync(plistPath);
    const meta = readAppMetadata(safeName) || {};

    let state = 'stopped';
    let pid = '-';
    let lastExitCode = null;
    const details = {};

    if (installed) {
      // 1. Try launchctl print
      const printRes = await this.run('launchctl', ['print', `${domain}/${label}`]);
      if (printRes.code === 0 && printRes.stdout) {
        details.raw = printRes.stdout;
        const pidMatch = printRes.stdout.match(/pid\s*=\s*(\d+)/i);
        if (pidMatch && pidMatch[1] && pidMatch[1] !== '0') {
          pid = pidMatch[1];
          state = 'running';
        }

        const stateMatch = printRes.stdout.match(/state\s*=\s*([a-zA-Z]+)/i);
        if (stateMatch) {
          const rawState = stateMatch[1].toLowerCase();
          if (rawState === 'running') state = 'running';
          else if (rawState === 'waiting') state = 'stopped';
        }

        const exitMatch = printRes.stdout.match(/last exit code\s*=\s*(\d+)/i);
        if (exitMatch) {
          lastExitCode = exitMatch[1];
          if (lastExitCode !== '0' && state !== 'running') {
            state = 'failed';
          }
        }
      } else {
        // 2. Fallback to launchctl list
        const listRes = await this.run('launchctl', ['list', label]);
        if (listRes.code === 0 && listRes.stdout) {
          details.raw = listRes.stdout;
          const pidMatch = listRes.stdout.match(/"PID"\s*=\s*(\d+);/i);
          if (pidMatch && pidMatch[1]) {
            pid = pidMatch[1];
            state = 'running';
          }
          const exitMatch = listRes.stdout.match(/"LastExitStatus"\s*=\s*(\d+);/i);
          if (exitMatch) {
            lastExitCode = exitMatch[1];
            if (lastExitCode !== '0' && state !== 'running') {
              state = 'failed';
            }
          }
        }
      }
    }

    const command = meta.command || process.execPath;
    const argsList = meta.args || (meta.script ? [meta.script] : []);

    return {
      name: safeName,
      installed,
      state,
      status: state, // for backward compatibility with table renderers
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
      unitFile: path.basename(plistPath),
      unitPath: plistPath,
      platform: 'darwin',
      manager: 'launchd',
      details,
      lastExitCode
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
   * Retrieves or streams logs for a service.
   *
   * @param {string} name
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  async logs(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const meta = readAppMetadata(safeName);
    const stdoutPath = meta?.logs?.stdout || path.join(getUnitupDir(), 'logs', `${safeName}.log`);
    const stderrPath = meta?.logs?.stderr || path.join(getUnitupDir(), 'logs', `${safeName}-error.log`);

    let paths = [stdoutPath, stderrPath];
    if (options.output === 'stdout' || options.stdout) {
      paths = [stdoutPath];
    } else if (options.output === 'stderr' || options.stderr) {
      paths = [stderrPath];
    }

    return readServiceLogs(paths, options);
  }

  /**
   * Lists all unitup services on macOS.
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
        const stat = await this.status(serviceName, { system: meta.system });
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
          platform: 'darwin',
          manager: 'launchd'
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
          platform: 'darwin',
          manager: 'launchd'
        });
      }
    }

    return result;
  }

  isInstalled(name, options = {}) {
    const safeName = sanitizeServiceName(name);
    const system = !!options.system;
    return fs.existsSync(this.getPlistPath(safeName, system));
  }

  async failures(options = {}) {
    const all = await this.list(options);
    const failed = [];
    for (const item of all) {
      if (item.status === 'failed') {
        const stat = await this.status(item.name);
        failed.push({
          name: item.name,
          group: item.group,
          status: 'failed',
          exitCode: stat.lastExitCode || '1',
          restarts: stat.restarts || '0',
          uptime: stat.started || 'never'
        });
      }
    }
    return failed;
  }
}
