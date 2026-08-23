import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteUnitFile,
  getUnitPath,
  getUserUnitDir,
  listUnitFiles,
  parseUnitContent,
  unitFileExists,
  writeUnitFile
} from './unit.js';
import {
  findProjectConfig,
  formatRelativeTime,
  getTimerFilename,
  getUnitFilename,
  readAppMetadata,
  readProjectConfig,
  readScheduleMetadata,
  sanitizeServiceName
} from './utils.js';

/**
 * Default runner for executing commands via child_process.execFile.
 * Can be mocked during testing.
 *
 * @type {(cmd: string, args: string[], opts?: any) => Promise<{ stdout: string, stderr: string, code: number }>}
 */
let commandRunner = defaultExecFileRunner;

function defaultExecFileRunner(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: stdout || '', stderr: stderr || '', code });
    });
  });
}

/**
 * Overrides the internal command runner for test mocking.
 *
 * @param {typeof commandRunner} runner
 */
export function setCommandRunner(runner) {
  commandRunner = runner;
}

/**
 * Resets the command runner to default child_process.execFile implementation.
 */
export function resetCommandRunner() {
  commandRunner = defaultExecFileRunner;
}

/**
 * Executes a command safely without invoking a shell.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {any} [opts]
 */
export async function runCommand(cmd, args, opts) {
  return commandRunner(cmd, args, opts);
}

// ---------------------------------------------------------------------------
// System Diagnostics & Doctor checks
// ---------------------------------------------------------------------------

export function isLinux() {
  return process.platform === 'linux';
}

export async function isSystemctlAvailable() {
  try {
    const res = await runCommand('systemctl', ['--version']);
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function isSystemdPID1() {
  if (!isLinux()) return false;
  try {
    if (fs.existsSync('/run/systemd/system')) {
      return true;
    }
    if (fs.existsSync('/proc/1/comm')) {
      const comm = fs.readFileSync('/proc/1/comm', 'utf8').trim();
      return comm === 'systemd' || comm === 'init';
    }
  } catch {
    // ignore
  }
  return false;
}

export async function isUserSystemdAvailable() {
  try {
    const res = await runCommand('systemctl', ['--user', 'is-system-running']);
    // exit code 0 (running), 1 (degraded) or stderr non-fatal means user bus is accessible
    if (res.stderr && res.stderr.includes('Failed to connect to bus')) {
      return false;
    }
    return res.code === 0 || res.code === 1 || res.stdout.length > 0;
  } catch {
    return false;
  }
}

export async function isUserUnitDirWritable() {
  const dir = getUserUnitDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds and validates Node.js executable path safely using process.execPath, which, or command -v.
 *
 * @param {string} [customPath]
 * @returns {Promise<string|null>}
 */
export async function findNodeExecutable(customPath) {
  if (customPath) {
    const absPath = path.resolve(process.cwd(), customPath);
    try {
      if (fs.existsSync(absPath)) {
        fs.accessSync(absPath, fs.constants.X_OK);
        return absPath;
      }
    } catch {
      return null;
    }
    return null;
  }

  // 1. Try process.execPath
  if (process.execPath && fs.existsSync(process.execPath)) {
    try {
      fs.accessSync(process.execPath, fs.constants.X_OK);
      return process.execPath;
    } catch {
      // ignore
    }
  }

  // 2. Try which node
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const res = await runCommand(whichCmd, ['node']);
    if (res.code === 0 && res.stdout.trim()) {
      const p = res.stdout.trim().split('\n')[0].trim();
      if (fs.existsSync(p)) {
        return p;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Checks detailed Node.js runtime diagnostics.
 *
 * @param {string} [customNodePath]
 * @returns {Promise<Object>}
 */
export async function checkNodeDiagnostics(customNodePath) {
  const result = {
    found: false,
    executable: false,
    execPath: '',
    whichPath: '',
    version: '',
    inPath: false,
    error: null,
    solution: null
  };

  // Check which node
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const res = await runCommand(whichCmd, ['node']);
    if (res.code === 0 && res.stdout.trim()) {
      result.whichPath = res.stdout.trim().split('\n')[0].trim();
      result.inPath = true;
    }
  } catch {
    result.inPath = false;
  }

  const resolvedNode = await findNodeExecutable(customNodePath);
  if (!resolvedNode) {
    if (result.whichPath && fs.existsSync(result.whichPath)) {
      result.execPath = result.whichPath;
      result.found = true;
      result.executable = false;
      result.error = 'Node.js binary exists but is not executable';
      result.solution = `Check permissions:\n  chmod +x $(which node)`;
      return result;
    }

    result.found = false;
    result.error = 'Node.js not found in PATH';
    result.solution = `Install Node.js:\n  https://nodejs.org\nor via package manager:\n  sudo apt install nodejs`;
    return result;
  }

  result.execPath = resolvedNode;
  result.found = true;

  // Test executing node -v
  try {
    const res = await runCommand(resolvedNode, ['-v']);
    if (res.code === 0 && res.stdout.trim()) {
      result.version = res.stdout.trim();
      result.executable = true;
    } else {
      result.executable = false;
      result.error = 'Node.js binary exists but fails execution';
      result.solution = `Check Node.js installation or explicit path:\n  unitup add app.js --node ${resolvedNode}`;
    }
  } catch (err) {
    result.executable = false;
    result.error = `Node.js execution failed: ${err.message}`;
    result.solution = `Try setting explicit path:\n  unitup add app.js --node ${resolvedNode}`;
  }

  return result;
}

export async function checkUserLinger() {
  const username = os.userInfo().username;
  // Method 1: check /var/lib/systemd/linger/<user>
  try {
    if (fs.existsSync(`/var/lib/systemd/linger/${username}`)) {
      return true;
    }
  } catch {
    // ignore
  }
  // Method 2: loginctl show-user $USER --property=Linger
  try {
    const res = await runCommand('loginctl', ['show-user', username, '--property=Linger']);
    if (res.code === 0 && res.stdout.includes('Linger=yes')) {
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

// ---------------------------------------------------------------------------
// Systemd Operations
// ---------------------------------------------------------------------------

import { resolveRuntimeConfig } from './runtimes/index.js';

export async function daemonReload() {
  const res = await runCommand('systemctl', ['--user', 'daemon-reload']);
  if (res.code !== 0) {
    throw new Error(`Failed to reload systemd daemon: ${res.stderr || res.stdout}`);
  }
  return true;
}

export async function resetFailed() {
  await runCommand('systemctl', ['--user', 'reset-failed']);
}

export async function addService(opts) {
  const targetCwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  const configPath = opts.config ? path.resolve(targetCwd, opts.config) : findProjectConfig(targetCwd);
  const projectCfg = configPath ? readProjectConfig(configPath) : null;

  let mergedOpts = { ...opts };
  if (projectCfg) {
    mergedOpts = {
      name: opts.name || projectCfg.name,
      group: opts.group || projectCfg.group || 'default',
      script: opts.script || projectCfg.script,
      command: opts.command || projectCfg.command,
      runtime: opts.runtime || projectCfg.runtime,
      runtimeArgs: opts.runtimeArgs && opts.runtimeArgs.length > 0 ? opts.runtimeArgs : projectCfg.runtimeArgs || [],
      args: opts.args && opts.args.length > 0 ? opts.args : projectCfg.args || [],
      envFile: opts.envFile || projectCfg.envFile,
      restart: opts.restart && opts.restart !== 'on-failure' ? opts.restart : projectCfg.restart || 'on-failure',
      memoryHigh: opts.memoryHigh || projectCfg?.resources?.memoryHigh || projectCfg?.memoryHigh || '',
      memoryMax: opts.memoryMax || projectCfg?.resources?.memoryMax || projectCfg?.memoryMax || '',
      memorySwapMax: opts.memorySwapMax || projectCfg?.resources?.memorySwapMax || projectCfg?.memorySwapMax || '',
      ...opts,
      env: { ...(projectCfg.env || {}), ...(opts.env || {}) },
      cwd: targetCwd
    };
  }

  const safeName = sanitizeServiceName(mergedOpts.name);
  let wasActive = false;

  if (unitFileExists(safeName)) {
    try {
      const show = await getServiceShow(safeName);
      if (show.ActiveState === 'active') {
        wasActive = true;
        if (!mergedOpts.force) {
          throw new Error(
            `Service "${safeName}" is currently running.\n` +
              `Use --force (-f) to overwrite running services, or stop it first:\n` +
              `  unitup stop ${safeName}`
          );
        }
      }
    } catch (err) {
      if (err.message.includes('currently running')) {
        throw err;
      }
    }
  }

  const runtimeConfig = await resolveRuntimeConfig({ ...mergedOpts, name: safeName });

  const { path: unitPath } = writeUnitFile({
    ...mergedOpts,
    name: safeName,
    runtime: runtimeConfig.runtime,
    command: runtimeConfig.command,
    args: runtimeConfig.args,
    cwd: mergedOpts.cwd
  });

  await daemonReload();

  if (wasActive && mergedOpts.force) {
    await restartService(safeName);
  } else if (mergedOpts.start) {
    await startService(safeName, true);
  }

  return { name: safeName, unitPath };
}

export async function startService(name, enable = false) {
  if (name && typeof name === 'string' && name.startsWith('@')) {
    const list = await getServicesByGroup(name);
    if (list.length === 0) {
      throw new Error(`No services found in group "${name}".`);
    }
    for (const s of list) {
      await startService(s, enable);
    }
    return true;
  }

  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.\nCreate it with: unitup add <script> --name ${safeName}`);
  }

  const args = enable
    ? ['--user', 'enable', '--now', getUnitFilename(safeName)]
    : ['--user', 'start', getUnitFilename(safeName)];

  const res = await runCommand('systemctl', args);
  if (res.code !== 0) {
    throw new Error(`Failed to start service "${safeName}": ${res.stderr || res.stdout}`);
  }
  return true;
}

export async function stopService(name) {
  if (name && typeof name === 'string' && name.startsWith('@')) {
    const list = await getServicesByGroup(name);
    if (list.length === 0) {
      throw new Error(`No services found in group "${name}".`);
    }
    for (const s of list) {
      await stopService(s);
    }
    return true;
  }

  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  const res = await runCommand('systemctl', ['--user', 'stop', getUnitFilename(safeName)]);
  if (res.code !== 0) {
    throw new Error(`Failed to stop service "${safeName}": ${res.stderr || res.stdout}`);
  }
  return true;
}

export async function restartService(name) {
  if (name && typeof name === 'string' && name.startsWith('@')) {
    const list = await getServicesByGroup(name);
    if (list.length === 0) {
      throw new Error(`No services found in group "${name}".`);
    }
    for (const s of list) {
      await restartService(s);
    }
    return true;
  }

  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  const res = await runCommand('systemctl', ['--user', 'restart', getUnitFilename(safeName)]);
  if (res.code !== 0) {
    throw new Error(`Failed to restart service "${safeName}": ${res.stderr || res.stdout}`);
  }
  return true;
}

export async function removeService(name, opts = {}) {
  const force = typeof opts === 'boolean' ? opts : !!opts?.force;

  if (name && typeof name === 'string' && name.startsWith('@')) {
    const list = await getServicesByGroup(name);
    if (list.length === 0) {
      throw new Error(`No services found in group "${name}".`);
    }
    for (const s of list) {
      await removeService(s, { force });
    }
    return true;
  }

  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  try {
    const show = await getServiceShow(safeName);
    if (show.ActiveState === 'active') {
      if (!force) {
        throw new Error(
          `Service "${safeName}" is currently running.\n` +
            `Use --force (-f) to remove running services, or stop it first:\n` +
            `  unitup stop ${safeName}`
        );
      }
    }
  } catch (err) {
    if (err.message.includes('currently running')) {
      throw err;
    }
  }

  // Attempt disable and stop
  await runCommand('systemctl', ['--user', 'disable', '--now', getUnitFilename(safeName)]);

  deleteUnitFile(safeName);

  await daemonReload();
  await resetFailed();
  return true;
}

export async function getServiceShow(name) {
  const safeName = sanitizeServiceName(name);
  const unitFilename = getUnitFilename(safeName);

  const res = await runCommand('systemctl', ['--user', 'show', unitFilename]);
  const info = {};

  if (res.stdout) {
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      const idx = line.indexOf('=');
      if (idx !== -1) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        info[key] = val;
      }
    }
  }

  return info;
}

export async function getServiceStatusRaw(name) {
  const safeName = sanitizeServiceName(name);
  const res = await runCommand('systemctl', ['--user', 'status', getUnitFilename(safeName)]);
  return res.stdout || res.stderr;
}

export async function getServiceStatus(name) {
  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  const show = await getServiceShow(safeName);

  // Read unit file content for script and working dir
  let script = 'unknown';
  let cwd = 'unknown';
  let parsed = {};

  const unitPath = getUnitPath(safeName);
  try {
    const content = fs.readFileSync(unitPath, 'utf8');
    parsed = parseUnitContent(content);
    if (parsed.script) script = parsed.script;
    if (parsed.cwd) cwd = parsed.cwd;
  } catch {
    // ignore
  }

  let status = 'stopped';
  const activeState = show.ActiveState || 'unknown';
  const subState = show.SubState || 'unknown';

  if (activeState === 'active' && subState === 'running') {
    status = 'running';
  } else if (activeState === 'active') {
    status = subState;
  } else if (activeState === 'failed') {
    status = 'failed';
  } else if (activeState === 'inactive') {
    status = 'stopped';
  } else {
    status = activeState;
  }

  const pid = show.MainPID && show.MainPID !== '0' ? show.MainPID : '-';
  const restarts = show.NRestarts ?? '0';
  const startedRaw = show.ActiveEnterTimestamp;
  const started = startedRaw && startedRaw !== '0' && startedRaw !== 'n/a' ? formatRelativeTime(startedRaw) : 'never';

  const meta = readAppMetadata(safeName) || readScheduleMetadata(safeName);
  const command = meta?.command || parsed.command || meta?.node || process.execPath;
  const argsList = meta?.args || (parsed.script ? [parsed.script] : []);

  const { formatMemoryBytes } = await import('./utils.js');
  const memoryCurrent = formatMemoryBytes(show.MemoryCurrent);
  const memoryPeak = formatMemoryBytes(show.MemoryPeak);
  const memoryHigh = formatMemoryBytes(show.MemoryHigh || meta?.resources?.memoryHigh || parsed.memoryHigh);
  const memoryMax = formatMemoryBytes(show.MemoryMax || meta?.resources?.memoryMax || parsed.memoryMax);
  const memorySwapMax = formatMemoryBytes(show.MemorySwapMax || meta?.resources?.memorySwapMax || parsed.memorySwapMax);

  return {
    name: safeName,
    unitFile: getUnitFilename(safeName),
    status,
    activeState,
    subState,
    pid,
    restarts,
    started,
    startedRaw,
    command,
    arguments: argsList.join(' '),
    args: argsList,
    script,
    cwd,
    memory: memoryCurrent,
    memoryPeak,
    memoryHigh,
    memoryMax,
    memorySwapMax
  };
}

export async function getServicesByGroup(groupName) {
  const cleanGroup = groupName.startsWith('@') ? groupName.slice(1) : groupName;
  const units = listUnitFiles();
  const matched = [];
  for (const unit of units) {
    const meta = readAppMetadata(unit.name) || readScheduleMetadata(unit.name);
    const itemGroup = meta?.group || 'default';
    if (itemGroup.toLowerCase() === cleanGroup.toLowerCase()) {
      matched.push(unit.name);
    }
  }
  return matched;
}

export async function listServices(filterOpts = {}) {
  const units = listUnitFiles();
  const result = [];
  const targetGroup = filterOpts.group
    ? (filterOpts.group.startsWith('@') ? filterOpts.group.slice(1) : filterOpts.group).toLowerCase()
    : null;

  for (const unit of units) {
    const meta = readAppMetadata(unit.name) || readScheduleMetadata(unit.name);
    const group = meta?.group || 'default';
    const runtime = meta?.runtime || 'node';

    if (targetGroup && group.toLowerCase() !== targetGroup) {
      continue;
    }

    let commandSummary = '';
    if (meta?.command) {
      if (runtime === 'native') {
        commandSummary = './' + path.basename(meta.command);
      } else {
        const cmdBase = path.basename(meta.command);
        const argsStr = (meta.args || [])
          .map((a) => (a.startsWith('/') || a.startsWith('./') ? path.basename(a) : a))
          .join(' ');
        commandSummary = (cmdBase + (argsStr ? ' ' + argsStr : '')).trim();
      }
    } else if (meta?.script) {
      commandSummary = `node ${path.basename(meta.script)}`;
    } else {
      commandSummary = 'unknown';
    }

    try {
      const show = await getServiceShow(unit.name);
      const activeState = show.ActiveState || 'inactive';
      const subState = show.SubState || 'dead';
      const unitFileState = show.UnitFileState || 'unknown';

      let status = 'stopped';
      if (meta?.type === 'timer' || meta?.schedule) {
        if (activeState === 'active' && subState === 'running') {
          status = 'running';
        } else if (activeState === 'failed') {
          status = 'failed';
        } else {
          try {
            const timerShow = await getServiceShow(getTimerFilename(unit.name));
            if (timerShow.ActiveState === 'active') {
              status = 'scheduled';
            } else if (timerShow.UnitFileState === 'disabled' || timerShow.ActiveState === 'inactive') {
              status = 'disabled';
            } else {
              status = 'scheduled';
            }
          } catch {
            status = 'scheduled';
          }
        }
      } else {
        if (activeState === 'active' && subState === 'running') {
          status = 'running';
        } else if (activeState === 'failed') {
          status = 'failed';
        } else if (activeState === 'active') {
          status = subState;
        } else {
          status = 'stopped';
        }
      }

      const enabled = unitFileState.startsWith('enabled') ? 'yes' : 'no';
      const pid = show.MainPID && show.MainPID !== '0' ? show.MainPID : '-';
      const restarts = show.NRestarts ?? '0';
      const startedRaw = show.ActiveEnterTimestamp;
      const uptime =
        startedRaw && startedRaw !== '0' && startedRaw !== 'n/a' ? formatRelativeTime(startedRaw) : 'never';

      result.push({
        name: unit.name,
        runtime,
        group,
        status,
        enabled,
        pid,
        command: commandSummary,
        uptime,
        restarts
      });
    } catch {
      result.push({
        name: unit.name,
        runtime,
        group,
        status: 'unknown',
        enabled: 'unknown',
        pid: '-',
        command: commandSummary,
        uptime: 'never',
        restarts: '0'
      });
    }
  }

  return result;
}

export async function inspectService(name) {
  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  const meta = readAppMetadata(safeName) || readScheduleMetadata(safeName);
  const statusObj = await getServiceStatus(safeName);

  let inspectStatus = statusObj.status;
  if ((meta?.type === 'timer' || meta?.schedule) && inspectStatus === 'stopped') {
    try {
      const timerShow = await getServiceShow(getTimerFilename(safeName));
      if (timerShow.ActiveState === 'active') {
        inspectStatus = 'scheduled';
      } else if (timerShow.UnitFileState === 'disabled' || timerShow.ActiveState === 'inactive') {
        inspectStatus = 'disabled';
      } else {
        inspectStatus = 'scheduled';
      }
    } catch {
      inspectStatus = 'scheduled';
    }
  }

  const command = meta?.command || statusObj.command || statusObj.node || process.execPath;
  const argsList = meta?.args || (statusObj.script ? [statusObj.script] : []);

  return {
    name: safeName,
    runtime: meta?.runtime || 'node',
    status: inspectStatus,
    activeState: statusObj.activeState,
    subState: statusObj.subState,
    command,
    arguments: argsList.join(' '),
    args: argsList,
    cwd: meta?.cwd || statusObj.cwd,
    unit: getUnitFilename(safeName),
    unitPath: getUnitPath(safeName),
    group: meta?.group || 'default',
    pid: statusObj.pid,
    restarts: statusObj.restarts,
    started: statusObj.started,
    memory: statusObj.memory,
    memoryPeak: statusObj.memoryPeak,
    memoryHigh: statusObj.memoryHigh,
    memoryMax: statusObj.memoryMax,
    memorySwapMax: statusObj.memorySwapMax,
    // Legacy fields for backward compatibility
    script: meta?.script || statusObj.script,
    node: meta?.node || command
  };
}

export async function getServiceFailures() {
  const allServices = await listServices();
  const failures = [];

  for (const item of allServices) {
    if (item.status === 'failed') {
      const show = await getServiceShow(item.name);
      const exitCode = show.ExecMainStatus || show.ExecMainCode || '1';
      failures.push({
        name: item.name,
        group: item.group,
        status: 'failed',
        exitCode: String(exitCode),
        restarts: item.restarts,
        uptime: item.uptime
      });
    }
  }

  return failures;
}

export async function runJournalctlLogs(name, opts = {}) {
  const safeName = sanitizeServiceName(name);
  const unitFilename = getUnitFilename(safeName);

  if (opts.diskUsage) {
    const res = await runCommand('journalctl', ['--disk-usage']);
    if (
      res.code !== 0 &&
      (res.stderr.toLowerCase().includes('permission') || res.stderr.toLowerCase().includes('root'))
    ) {
      throw new Error(
        'Journal maintenance requires additional privileges on this system.\nRun the command manually with the appropriate permissions.'
      );
    }
    return res.stdout || res.stderr;
  }

  const syslogId = `unitup-${safeName}`;

  const candidateArgSets = [
    ['--user', '-u', unitFilename],
    ['--user', '-u', `unitup-${safeName}`],
    ['--user', '-t', syslogId],
    ['-u', unitFilename],
    ['-u', `unitup-${safeName}`],
    ['-t', syslogId]
  ];

  let chosenCandidate = null;

  for (const candidateArgs of candidateArgSets) {
    const testArgs = [...candidateArgs, '--no-pager', '-n', '1'];
    const res = await runCommand('journalctl', testArgs);
    const out = (res.stdout || res.stderr || '').trim();

    if (res.code === 0 && !out.includes('No journal files')) {
      if (!chosenCandidate) {
        chosenCandidate = candidateArgs;
      }
      if (!out.includes('No entries') && !out.includes('0 entries')) {
        chosenCandidate = candidateArgs;
        break;
      }
    }
  }

  const workingCandidate = chosenCandidate || ['--user', '-u', unitFilename];
  const filterArgs = [...workingCandidate];

  if (opts.since) filterArgs.push(`--since=${opts.since}`);
  if (opts.until) filterArgs.push(`--until=${opts.until}`);
  if (opts.priority) filterArgs.push(`--priority=${opts.priority}`);
  if (opts.grep) filterArgs.push(`--grep=${opts.grep}`);
  if (opts.boot) filterArgs.push('--boot');

  if (opts.json) {
    filterArgs.push('-o', 'json');
  } else if (opts.cat || opts.output === 'cat') {
    filterArgs.push('-o', 'cat');
  } else if (opts.output) {
    filterArgs.push('-o', opts.output);
  }

  if (opts.follow) {
    filterArgs.push('-f');
    if (opts.lines) filterArgs.push('-n', String(opts.lines));
    try {
      const child = spawn('journalctl', filterArgs, { stdio: 'inherit', shell: false });
      child.on('error', () => {});
      return child;
    } catch {
      return null;
    }
  }

  filterArgs.push('--no-pager');
  const lines = opts.lines ? String(opts.lines) : '100';
  filterArgs.push('-n', lines);

  const res = await runCommand('journalctl', filterArgs);
  return res.stdout || res.stderr || 'No logs found.';
}

export async function setServiceLimits(name, options = {}) {
  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Service "${safeName}" does not exist.`);
  }

  const meta = readAppMetadata(safeName) || {};
  const { validateMemorySize } = await import('./utils.js');

  let memoryHigh = options.memoryHigh;
  let memoryMax = options.memoryMax;
  let memorySwapMax = options.memorySwapMax;

  const resources = { ...(meta.resources || {}) };

  if (options.resetMemory) {
    delete resources.memoryHigh;
    delete resources.memoryMax;
    delete resources.memorySwapMax;
    memoryHigh = undefined;
    memoryMax = undefined;
    memorySwapMax = undefined;
  } else {
    if (memoryHigh !== undefined) {
      memoryHigh = validateMemorySize(memoryHigh, 'MemoryHigh');
      resources.memoryHigh = memoryHigh;
    }
    if (memoryMax !== undefined) {
      memoryMax = validateMemorySize(memoryMax, 'MemoryMax');
      resources.memoryMax = memoryMax;
    }
    if (memorySwapMax !== undefined) {
      memorySwapMax = validateMemorySize(memorySwapMax, 'MemorySwapMax');
      resources.memorySwapMax = memorySwapMax;
    }
  }

  const updatedMeta = {
    ...meta,
    name: safeName,
    resources: Object.keys(resources).length > 0 ? resources : undefined,
    memoryHigh: resources.memoryHigh,
    memoryMax: resources.memoryMax,
    memorySwapMax: resources.memorySwapMax
  };

  writeUnitFile(updatedMeta);

  await runCommand('systemctl', ['--user', 'daemon-reload']);

  const status = await getServiceStatus(safeName);
  if (status.status === 'running') {
    const setPropsArgs = ['--user', 'set-property', getUnitFilename(safeName)];
    if (options.resetMemory) {
      setPropsArgs.push('MemoryHigh=infinity', 'MemoryMax=infinity', 'MemorySwapMax=infinity');
    } else {
      if (resources.memoryHigh) setPropsArgs.push(`MemoryHigh=${resources.memoryHigh}`);
      if (resources.memoryMax) setPropsArgs.push(`MemoryMax=${resources.memoryMax}`);
      if (resources.memorySwapMax) setPropsArgs.push(`MemorySwapMax=${resources.memorySwapMax}`);
    }

    if (setPropsArgs.length > 3) {
      try {
        await runCommand('systemctl', setPropsArgs);
      } catch {
        // Graceful fallback if runtime property setting fails
      }
    }
  }

  return await inspectService(safeName);
}

export async function executeJournalctlMaintenance(action, opts = {}) {
  const args = [];
  if (action === 'disk-usage') {
    args.push('--disk-usage');
  } else if (action === 'rotate') {
    args.push('--rotate');
  } else if (action === 'vacuum') {
    const { validateMemorySize } = await import('./utils.js');
    if (opts.size) {
      const validSize = validateMemorySize(opts.size, 'Vacuum size');
      args.push(`--vacuum-size=${validSize}`);
    } else if (opts.time) {
      const timeStr = String(opts.time).trim();
      if (/[;&|$`"'\n\r\t ]/.test(timeStr)) {
        throw new Error(`Vacuum time contains invalid characters or shell injection: "${timeStr}".`);
      }
      args.push(`--vacuum-time=${timeStr}`);
    } else if (opts.files) {
      const filesNum = Number.parseInt(opts.files, 10);
      if (Number.isNaN(filesNum) || filesNum <= 0) {
        throw new Error(`Invalid vacuum files count: "${opts.files}". Must be a positive integer.`);
      }
      args.push(`--vacuum-files=${filesNum}`);
    } else {
      throw new Error('Vacuum action requires one of --size, --time, or --files.');
    }
  } else {
    throw new Error(`Unknown journal maintenance action: "${action}".`);
  }

  if (opts.dryRun) {
    return `[dry-run] Would execute: journalctl ${args.join(' ')}`;
  }

  const res = await runCommand('journalctl', args);
  if (
    res.code !== 0 &&
    (res.stderr.toLowerCase().includes('permission') ||
      res.stderr.toLowerCase().includes('root') ||
      res.stderr.toLowerCase().includes('access denied'))
  ) {
    throw new Error(
      'Journal maintenance requires additional privileges on this system.\nRun the command manually with the appropriate permissions.'
    );
  }

  return (res.stdout || res.stderr || 'Journal maintenance completed successfully.').trim();
}

/**
 * Retrieves memory usage overview for a single service or schedule task.
 *
 * @param {string} name
 * @returns {Promise<Object>}
 */
export async function getServiceMemoryUsage(name) {
  const safeName = sanitizeServiceName(name);
  const unitFilename = getUnitFilename(safeName);

  const res = await runCommand('systemctl', [
    '--user',
    'show',
    unitFilename,
    '--property=ActiveState,SubState,MainPID,MemoryCurrent,MemoryPeak,MemoryHigh,MemoryMax,MemorySwapMax'
  ]);

  const props = {};
  if (res.stdout) {
    for (const line of res.stdout.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        props[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }

  const { readScheduleMetadata } = await import('./utils.js');
  const meta = readAppMetadata(safeName) || readScheduleMetadata(safeName);
  const { formatMemoryBytes, resolveEffectiveMemoryLimits } = await import('./utils.js');

  const effective = resolveEffectiveMemoryLimits(meta || {});

  const memoryCurrentBytes = Number(props.MemoryCurrent);
  const rawBytes =
    !isNaN(memoryCurrentBytes) && memoryCurrentBytes > 0 && memoryCurrentBytes < 1e15 ? memoryCurrentBytes : 0;

  const status =
    props.ActiveState === 'active'
      ? props.SubState === 'running'
        ? 'running'
        : props.SubState || 'active'
      : props.ActiveState || 'stopped';

  return {
    name: safeName,
    group: meta?.group || 'default',
    type: meta?.type === 'timer' ? 'timer' : 'service',
    status,
    pid: props.MainPID && props.MainPID !== '0' ? props.MainPID : '-',
    memoryBytes: rawBytes,
    memory: formatMemoryBytes(props.MemoryCurrent),
    memoryPeak: formatMemoryBytes(props.MemoryPeak),
    memoryHigh: formatMemoryBytes(props.MemoryHigh || effective.memoryHigh),
    memoryMax: formatMemoryBytes(props.MemoryMax || effective.memoryMax),
    memorySwapMax: formatMemoryBytes(props.MemorySwapMax || effective.memorySwapMax)
  };
}

/**
 * Retrieves aggregated memory usage overview for all unitup services and schedules.
 *
 * @param {Object} [opts]
 * @param {string} [opts.group]
 * @returns {Promise<Object>}
 */
export async function getAllServicesMemoryUsage(opts = {}) {
  const { formatMemoryBytes } = await import('./utils.js');
  const services = await listServices({ group: opts.group });
  const { listSchedules } = await import('./schedule.js');
  const schedules = await listSchedules(opts.group);

  const items = [];
  let totalBytes = 0;
  const processedNames = new Set();

  for (const svc of services) {
    processedNames.add(svc.name);
    try {
      const mem = await getServiceMemoryUsage(svc.name);
      items.push({
        name: svc.name,
        group: svc.group || 'default',
        type: 'service',
        status: svc.status,
        pid: svc.pid,
        memory: mem.memory,
        memoryPeak: mem.memoryPeak,
        memoryMax: mem.memoryMax,
        memoryHigh: mem.memoryHigh,
        memoryBytes: mem.memoryBytes
      });
      totalBytes += mem.memoryBytes;
    } catch {
      // ignore
    }
  }

  for (const sched of schedules) {
    if (!processedNames.has(sched.name)) {
      processedNames.add(sched.name);
      try {
        const mem = await getServiceMemoryUsage(sched.name);
        items.push({
          name: sched.name,
          group: sched.group || 'default',
          type: 'timer',
          status: sched.status,
          pid: mem.pid,
          memory: mem.memory,
          memoryPeak: mem.memoryPeak,
          memoryMax: mem.memoryMax,
          memoryHigh: mem.memoryHigh,
          memoryBytes: mem.memoryBytes
        });
        totalBytes += mem.memoryBytes;
      } catch {
        // ignore
      }
    }
  }

  const runningCount = items.filter((i) => i.status === 'running' || i.status === 'active').length;

  return {
    items,
    totalBytes,
    totalMemory: formatMemoryBytes(totalBytes),
    runningCount
  };
}
