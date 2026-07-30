import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  sanitizeServiceName,
  getUnitFilename,
  getTimerFilename,
  getServiceNameFromUnit,
  formatSystemdEnv,
  escapeExecArg,
  resolveAbsolutePath,
  saveAppMetadata,
  deleteAppMetadata,
  saveScheduleMetadata,
  deleteScheduleMetadata,
  validateDuration,
  resolveEffectiveMemoryLimits
} from './utils.js';

/**
 * Returns the path to the systemd user service directory (~/.config/systemd/user).
 *
 * @returns {string}
 */
export function getUserUnitDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  if (xdgConfig) {
    return path.join(xdgConfig, 'systemd', 'user');
  }
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

/**
 * Returns the full file path for a given service unit.
 *
 * @param {string} name
 * @returns {string}
 */
export function getUnitPath(name) {
  const filename = getUnitFilename(name);
  return path.join(getUserUnitDir(), filename);
}

/**
 * Checks if a unit file exists for the given service name.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function unitFileExists(name) {
  const unitPath = getUnitPath(name);
  return fs.existsSync(unitPath);
}

/**
 * Generates the text content of a systemd unit file.
 *
 * @param {Object} opts
 * @param {string} opts.name - Service name
 * @param {string} [opts.command] - Absolute path to binary executable
 * @param {Array<string>} [opts.args] - Command arguments
 * @param {string} [opts.script] - Absolute path to script (legacy support)
 * @param {string} [opts.cwd] - Working directory path
 * @param {string} [opts.nodePath] - Absolute path to Node executable (legacy support)
 * @param {Record<string, string>} [opts.env] - Environment variables object
 * @param {string} [opts.envFile] - Path to environment file
 * @param {string} [opts.restart] - Restart policy (default: 'on-failure')
 * @returns {string}
 */
export function generateUnitContent(opts) {
  const safeName = sanitizeServiceName(opts.name);
  let commandExec = '';
  let execArgs = [];

  if (opts.command) {
    commandExec = resolveAbsolutePath(opts.command);
    execArgs = Array.isArray(opts.args) ? [...opts.args] : [];
  } else if (opts.script) {
    const scriptPath = resolveAbsolutePath(opts.script);
    commandExec = opts.nodePath ? resolveAbsolutePath(opts.nodePath) : process.execPath;
    execArgs = [scriptPath, ...(Array.isArray(opts.args) ? opts.args : [])];
  } else {
    throw new Error('Either "command" or "script" must be provided to generate systemd unit file.');
  }

  const cwd = opts.cwd
    ? resolveAbsolutePath(opts.cwd)
    : opts.script
    ? path.dirname(resolveAbsolutePath(opts.script))
    : process.cwd();
  const restartPolicy = opts.restart || 'on-failure';

  const execStartTokens = [commandExec, ...execArgs];
  const execStartLine = execStartTokens.map(escapeExecArg).join(' ');

  const binDir = path.dirname(commandExec);
  const defaultPath = [binDir, '/usr/local/bin', '/usr/bin', '/bin']
    .filter((p, i, self) => p && self.indexOf(p) === i)
    .join(':');

  const serviceLines = [
    '[Unit]',
    `Description=unitup service: ${safeName}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `SyslogIdentifier=unitup-${safeName}`,
    `WorkingDirectory=${cwd}`,
    `ExecStart=${execStartLine}`,
    `Restart=${restartPolicy}`,
    'RestartSec=3',
    'StandardOutput=journal',
    'StandardError=journal'
  ];

  const effectiveLimits = resolveEffectiveMemoryLimits(opts);
  const memHigh = effectiveLimits.memoryHigh;
  const memMax = effectiveLimits.memoryMax;
  const memSwapMax = effectiveLimits.memorySwapMax;

  if (memHigh || memMax || memSwapMax) {
    serviceLines.push('MemoryAccounting=yes');
    if (memHigh) serviceLines.push(`MemoryHigh=${memHigh}`);
    if (memMax) serviceLines.push(`MemoryMax=${memMax}`);
    if (memSwapMax) serviceLines.push(`MemorySwapMax=${memSwapMax}`);
  }

  const envObj = opts.env && typeof opts.env === 'object' ? { ...opts.env } : {};
  if (!envObj.PATH) {
    envObj.PATH = defaultPath;
  }

  if (opts.envFile) {
    const absEnvFile = resolveAbsolutePath(opts.envFile);
    serviceLines.push(`EnvironmentFile=${absEnvFile}`);
  }

  for (const [key, val] of Object.entries(envObj)) {
    serviceLines.push(`Environment=${formatSystemdEnv(key, val)}`);
  }

  serviceLines.push('', '[Install]', 'WantedBy=default.target', '');

  return serviceLines.join('\n');
}

/**
 * Creates or updates a systemd unit file on disk.
 *
 * @param {Object} opts - Same options as generateUnitContent
 * @returns {{ path: string, content: string }}
 */
export function writeUnitFile(opts) {
  const safeName = sanitizeServiceName(opts.name);
  const unitDir = getUserUnitDir();

  if (!fs.existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true });
  }

  const unitPath = getUnitPath(safeName);
  const content = generateUnitContent({ ...opts, name: safeName });

  fs.writeFileSync(unitPath, content, 'utf8');
  saveAppMetadata({
    name: safeName,
    group: opts.group || 'default',
    runtime: opts.runtime || 'node',
    command: opts.command,
    args: opts.args,
    script: opts.script,
    cwd: opts.cwd,
    node: opts.nodePath,
    memoryHigh: opts.memoryHigh || opts.resources?.memoryHigh,
    memoryMax: opts.memoryMax || opts.resources?.memoryMax,
    memorySwapMax: opts.memorySwapMax || opts.resources?.memorySwapMax,
    resources: opts.resources
  });

  return { path: unitPath, content };
}

/**
 * Removes a unit file from disk.
 *
 * @param {string} name
 * @returns {boolean} True if file existed and was removed
 */
export function deleteUnitFile(name) {
  const safeName = sanitizeServiceName(name);
  deleteAppMetadata(safeName);
  const unitPath = getUnitPath(safeName);
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    return true;
  }
  return false;
}

/**
 * Lists all unitup-*.service files in the user unit directory.
 *
 * @returns {Array<{ name: string, filename: string, path: string }>}
 */
export function listUnitFiles() {
  const unitDir = getUserUnitDir();
  if (!fs.existsSync(unitDir)) {
    return [];
  }

  const files = fs.readdirSync(unitDir);
  const units = [];

  for (const filename of files) {
    if (filename.startsWith('unitup-') && filename.endsWith('.service')) {
      const name = filename.slice(7, -8);
      units.push({
        name,
        filename,
        path: path.join(unitDir, filename)
      });
    }
  }

  return units;
}

/**
 * Parses basic information (Command, Arguments, Script, WorkingDirectory) from a unit file content.
 *
 * @param {string} content
 * @returns {{ command?: string, args?: string[], script?: string, cwd?: string, restart?: string }}
 */
export function parseUnitContent(content) {
  const result = {};
  if (!content) return result;

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('WorkingDirectory=')) {
      result.cwd = trimmed.slice(17).trim();
    } else if (trimmed.startsWith('ExecStart=')) {
      const execVal = trimmed.slice(10).trim();
      const parts = execVal.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
      const cleanParts = parts.map(p => p.replace(/^"|"$/g, ''));
      if (cleanParts.length > 0) {
        result.command = cleanParts[0];
        result.args = cleanParts.slice(1);
        if (cleanParts.length >= 2) {
          result.script = cleanParts[1];
        } else {
          result.script = cleanParts[0];
        }
      }
    } else if (trimmed.startsWith('Restart=')) {
      result.restart = trimmed.slice(8).trim();
    } else if (trimmed.startsWith('MemoryHigh=')) {
      result.memoryHigh = trimmed.slice(11).trim();
    } else if (trimmed.startsWith('MemoryMax=')) {
      result.memoryMax = trimmed.slice(10).trim();
    } else if (trimmed.startsWith('MemorySwapMax=')) {
      result.memorySwapMax = trimmed.slice(14).trim();
    }
  }

  return result;
}

/**
 * Returns the full file path for a given timer unit.
 * @param {string} name
 * @returns {string}
 */
export function getTimerPath(name) {
  const filename = getTimerFilename(name);
  return path.join(getUserUnitDir(), filename);
}

/**
 * Checks if a timer unit file exists for the given schedule name.
 * @param {string} name
 * @returns {boolean}
 */
export function timerFileExists(name) {
  const timerPath = getTimerPath(name);
  return fs.existsSync(timerPath);
}

/**
 * Generates systemd service unit content for a scheduled oneshot task.
 * @param {Object} opts
 * @returns {string}
 */
export function generateScheduleServiceContent(opts) {
  const safeName = sanitizeServiceName(opts.name);
  let commandExec = '';
  let execArgs = [];

  if (opts.command) {
    commandExec = resolveAbsolutePath(opts.command);
    execArgs = Array.isArray(opts.args) ? [...opts.args] : [];
  } else if (opts.script) {
    const scriptPath = resolveAbsolutePath(opts.script);
    commandExec = opts.nodePath ? resolveAbsolutePath(opts.nodePath) : process.execPath;
    execArgs = [scriptPath, ...(Array.isArray(opts.args) ? opts.args : [])];
  } else {
    throw new Error('Either "command" or "script" must be provided to generate scheduled unit file.');
  }

  const cwd = opts.cwd
    ? resolveAbsolutePath(opts.cwd)
    : opts.script
    ? path.dirname(resolveAbsolutePath(opts.script))
    : process.cwd();

  const execStartTokens = [commandExec, ...execArgs];
  const execStartLine = execStartTokens.map(escapeExecArg).join(' ');

  const binDir = path.dirname(commandExec);
  const defaultPath = [binDir, '/usr/local/bin', '/usr/bin', '/bin']
    .filter((p, i, self) => p && self.indexOf(p) === i)
    .join(':');

  const serviceLines = [
    '[Unit]',
    `Description=unitup scheduled task: ${safeName}`,
    'After=network.target',
    '',
    '[Service]',
    'Type=oneshot',
    `SyslogIdentifier=unitup-${safeName}`,
    `WorkingDirectory=${cwd}`,
    `ExecStart=${execStartLine}`,
    'StandardOutput=journal',
    'StandardError=journal'
  ];

  const effectiveLimits = resolveEffectiveMemoryLimits(opts);
  const memHigh = effectiveLimits.memoryHigh;
  const memMax = effectiveLimits.memoryMax;
  const memSwapMax = effectiveLimits.memorySwapMax;

  if (memHigh || memMax || memSwapMax) {
    serviceLines.push('MemoryAccounting=yes');
    if (memHigh) serviceLines.push(`MemoryHigh=${memHigh}`);
    if (memMax) serviceLines.push(`MemoryMax=${memMax}`);
    if (memSwapMax) serviceLines.push(`MemorySwapMax=${memSwapMax}`);
  }

  const envObj = opts.env && typeof opts.env === 'object' ? { ...opts.env } : {};
  if (!envObj.PATH) {
    envObj.PATH = defaultPath;
  }

  if (opts.envFile) {
    const absEnvFile = resolveAbsolutePath(opts.envFile);
    serviceLines.push(`EnvironmentFile=${absEnvFile}`);
  }

  for (const [key, val] of Object.entries(envObj)) {
    serviceLines.push(`Environment=${formatSystemdEnv(key, val)}`);
  }

  serviceLines.push('');
  return serviceLines.join('\n');
}

/**
 * Generates systemd timer unit content.
 * @param {Object} opts
 * @returns {string}
 */
export function generateTimerContent(opts) {
  const safeName = sanitizeServiceName(opts.name);

  const timerLines = [
    '[Unit]',
    `Description=unitup timer: ${safeName}`,
    '',
    '[Timer]'
  ];

  if (opts.every) {
    const validEvery = validateDuration(opts.every, '--every');
    const onActive = opts.onActive ? validateDuration(opts.onActive, '--on-active') : validEvery;
    timerLines.push(`OnActiveSec=${onActive}`);
    timerLines.push(`OnUnitActiveSec=${validEvery}`);
  } else if (opts.onActive) {
    const validActive = validateDuration(opts.onActive, '--on-active');
    timerLines.push(`OnActiveSec=${validActive}`);
  }

  if (opts.calendar) {
    if (typeof opts.calendar !== 'string' || !opts.calendar.trim()) {
      throw new Error('Calendar expression cannot be empty.');
    }
    timerLines.push(`OnCalendar=${opts.calendar.trim()}`);
  }

  if (opts.onBoot) {
    const validBoot = validateDuration(opts.onBoot, '--on-boot');
    timerLines.push(`OnBootSec=${validBoot}`);
  }

  if (opts.randomDelay) {
    const validDelay = validateDuration(opts.randomDelay, '--random-delay');
    timerLines.push(`RandomizedDelaySec=${validDelay}`);
  }

  if (opts.persistent) {
    timerLines.push('Persistent=true');
  }

  const serviceFilename = getUnitFilename(safeName);
  timerLines.push(`Unit=${serviceFilename}`);

  timerLines.push('', '[Install]', 'WantedBy=timers.target', '');

  return timerLines.join('\n');
}

/**
 * Creates or updates systemd service and timer files for a schedule on disk.
 * @param {Object} opts
 * @returns {{ servicePath: string, timerPath: string, serviceContent: string, timerContent: string }}
 */
export function writeScheduleUnitFiles(opts) {
  const safeName = sanitizeServiceName(opts.name);
  const unitDir = getUserUnitDir();

  if (!fs.existsSync(unitDir)) {
    fs.mkdirSync(unitDir, { recursive: true });
  }

  const servicePath = getUnitPath(safeName);
  const timerPath = getTimerPath(safeName);

  const serviceContent = generateScheduleServiceContent({ ...opts, name: safeName });
  const timerContent = generateTimerContent({ ...opts, name: safeName });

  fs.writeFileSync(servicePath, serviceContent, 'utf8');
  fs.writeFileSync(timerPath, timerContent, 'utf8');

  saveScheduleMetadata({
    name: safeName,
    group: opts.group || 'default',
    runtime: opts.runtime || 'node',
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    memoryHigh: opts.memoryHigh || opts.resources?.memoryHigh,
    memoryMax: opts.memoryMax || opts.resources?.memoryMax,
    memorySwapMax: opts.memorySwapMax || opts.resources?.memorySwapMax,
    resources: opts.resources,
    schedule: {
      every: opts.every || null,
      calendar: opts.calendar || null,
      onBoot: opts.onBoot || null,
      onActive: opts.onActive || null,
      persistent: Boolean(opts.persistent),
      randomDelay: opts.randomDelay || null
    }
  });

  return { servicePath, timerPath, serviceContent, timerContent };
}

/**
 * Removes service, timer, and metadata files for a schedule.
 * @param {string} name
 * @returns {boolean}
 */
export function deleteScheduleUnitFiles(name) {
  const safeName = sanitizeServiceName(name);
  deleteScheduleMetadata(safeName);
  const servicePath = getUnitPath(safeName);
  const timerPath = getTimerPath(safeName);

  let removed = false;
  if (fs.existsSync(timerPath)) {
    fs.unlinkSync(timerPath);
    removed = true;
  }
  if (fs.existsSync(servicePath)) {
    fs.unlinkSync(servicePath);
    removed = true;
  }
  return removed;
}

