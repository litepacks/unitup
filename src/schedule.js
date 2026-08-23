import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRuntime, resolveRuntimeConfig } from './runtimes/index.js';
import { runCommand } from './systemd.js';
import {
  deleteScheduleUnitFiles,
  getTimerPath,
  getUnitPath,
  getUserUnitDir,
  timerFileExists,
  unitFileExists,
  writeScheduleUnitFiles
} from './unit.js';
import {
  deleteScheduleMetadata,
  formatFutureTime,
  formatRelativeTime,
  getSchedulesDir,
  getTimerFilename,
  getUnitFilename,
  readScheduleMetadata,
  resolveAbsolutePath,
  resolveWorkingDirectory,
  sanitizeServiceName,
  saveScheduleMetadata,
  validateDuration
} from './utils.js';

/**
 * Validates a systemd calendar expression using systemd-analyze if available.
 *
 * @param {string} expression
 * @returns {Promise<{ valid: boolean, error?: string, warning?: string }>}
 */
export async function validateCalendar(expression) {
  if (!expression || typeof expression !== 'string' || !expression.trim()) {
    throw new Error('Calendar expression cannot be empty.');
  }

  const expr = expression.trim();
  if (/[;&|$`\n\r]/.test(expr)) {
    throw new Error(`Calendar expression contains invalid characters or shell injection attempt: "${expr}".`);
  }

  try {
    const res = await runCommand('systemd-analyze', ['calendar', expr]);
    if (res.code === 0) {
      return { valid: true };
    }
    if (res.stderr && res.stderr.includes('Failed to parse calendar expression')) {
      throw new Error(`Invalid calendar expression "${expr}": ${res.stderr.trim()}`);
    }
    // If systemd-analyze binary is missing
    if (res.code === 127 || (res.stderr && res.stderr.includes('not found'))) {
      return {
        valid: true,
        warning: 'systemd-analyze is not available; calendar expression could not be fully validated by systemd.'
      };
    }
  } catch (err) {
    if (err.message && err.message.startsWith('Invalid calendar expression')) {
      throw err;
    }
  }

  return { valid: true };
}

/**
 * Creates a systemd timer-based schedule.
 *
 * @param {Object} opts
 * @returns {Promise<Object>}
 */
export async function createSchedule(opts = {}) {
  if (opts.every && opts.calendar) {
    throw new Error('Cannot use both --every and --calendar in the same schedule.');
  }

  if (!opts.every && !opts.calendar && !opts.onBoot && !opts.onActive) {
    throw new Error('At least one scheduling option (--every, --calendar, --on-boot, or --on-active) is required.');
  }

  if (opts.every) {
    validateDuration(opts.every, '--every');
  }
  if (opts.onBoot) {
    validateDuration(opts.onBoot, '--on-boot');
  }
  if (opts.onActive) {
    validateDuration(opts.onActive, '--on-active');
  }
  if (opts.randomDelay) {
    validateDuration(opts.randomDelay, '--random-delay');
  }
  if (opts.calendar) {
    await validateCalendar(opts.calendar);
  }

  let rawName = opts.name;
  if (!rawName) {
    if (opts.script) {
      rawName = path.basename(opts.script, path.extname(opts.script));
    } else if (opts.command) {
      rawName = path.basename(opts.command);
    } else {
      throw new Error('Schedule requires a name, script, or command.');
    }
  }

  const safeName = sanitizeServiceName(rawName);

  if (!opts.script && !opts.command) {
    throw new Error('Either script or command must be provided to create schedule.');
  }

  const scriptPath = opts.script ? resolveAbsolutePath(opts.script) : '';
  const resolved = await resolveRuntimeConfig({
    runtime: opts.runtime,
    script: scriptPath,
    command: opts.command,
    args: opts.args || [],
    runtimeArgs: opts.runtimeArgs || [],
    customNodePath: opts.node
  });

  const commandExec = resolved.command;
  const execArgs = resolved.args;
  const detectedRuntime = resolved.runtime;

  const cwd = resolveWorkingDirectory({ cwd: opts.cwd, script: scriptPath });

  const envObj = {};
  if (opts.env) {
    if (Array.isArray(opts.env)) {
      for (const item of opts.env) {
        const idx = item.indexOf('=');
        if (idx > 0) {
          const key = item.slice(0, idx).trim();
          const val = item.slice(idx + 1).trim();
          envObj[key] = val;
        }
      }
    } else if (typeof opts.env === 'object') {
      Object.assign(envObj, opts.env);
    }
  }

  const scheduleOpts = {
    name: safeName,
    runtime: detectedRuntime,
    command: commandExec,
    args: execArgs,
    script: scriptPath,
    cwd,
    env: envObj,
    envFile: opts.envFile ? resolveAbsolutePath(opts.envFile) : undefined,
    group: opts.group || 'default',
    memoryHigh: opts.memoryHigh,
    memoryMax: opts.memoryMax,
    memorySwapMax: opts.memorySwapMax,
    resources: opts.resources,
    every: opts.every,
    calendar: opts.calendar,
    onBoot: opts.onBoot,
    onActive: opts.onActive,
    randomDelay: opts.randomDelay,
    persistent: opts.persistent
  };

  const unitFiles = writeScheduleUnitFiles(scheduleOpts);

  if (opts.start || opts.enable) {
    await runCommand('systemctl', ['--user', 'daemon-reload']);
    await runCommand('systemctl', ['--user', 'reset-failed', getUnitFilename(safeName), getTimerFilename(safeName)]);
    await runCommand('systemctl', ['--user', 'enable', getTimerFilename(safeName)]);
    await runCommand('systemctl', ['--user', 'start', getTimerFilename(safeName)]);
  }

  return {
    name: safeName,
    group: opts.group || 'default',
    type: 'timer',
    runtime: detectedRuntime,
    command: commandExec,
    args: execArgs,
    cwd,
    schedule: {
      every: opts.every || null,
      calendar: opts.calendar || null,
      onBoot: opts.onBoot || null,
      onActive: opts.onActive || null,
      persistent: Boolean(opts.persistent),
      randomDelay: opts.randomDelay || null
    },
    serviceUnit: `unitup-${safeName}.service`,
    timerUnit: `unitup-${safeName}.timer`,
    servicePath: unitFiles.servicePath,
    timerPath: unitFiles.timerPath
  };
}

/**
 * Enables a timer schedule.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function enableSchedule(name) {
  const safeName = sanitizeServiceName(name);
  if (!timerFileExists(safeName)) {
    throw new Error(`Schedule timer unit up for "${name}" does not exist.`);
  }
  await runCommand('systemctl', ['--user', 'daemon-reload']);
  await runCommand('systemctl', ['--user', 'reset-failed', getUnitFilename(safeName), getTimerFilename(safeName)]);
  const res = await runCommand('systemctl', ['--user', 'enable', '--now', getTimerFilename(safeName)]);
  return res.code === 0;
}

/**
 * Disables a timer schedule.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function disableSchedule(name) {
  const safeName = sanitizeServiceName(name);
  if (!timerFileExists(safeName)) {
    throw new Error(`Schedule timer unit up for "${name}" does not exist.`);
  }
  const res = await runCommand('systemctl', ['--user', 'disable', '--now', getTimerFilename(safeName)]);
  return res.code === 0;
}

/**
 * Manually runs a scheduled service unit without altering timer schedule.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function runSchedule(name) {
  const safeName = sanitizeServiceName(name);
  if (!unitFileExists(safeName)) {
    throw new Error(`Schedule service unit for "${name}" does not exist.`);
  }
  const res = await runCommand('systemctl', ['--user', 'start', getUnitFilename(safeName)]);
  return res.code === 0;
}

/**
 * Removes a timer schedule and its service/timer files.
 *
 * @param {string} name
 * @param {Object} [opts]
 * @param {boolean} [opts.force]
 * @returns {Promise<boolean>}
 */
export async function removeSchedule(name, opts = {}) {
  const safeName = sanitizeServiceName(name);
  const timerName = getTimerFilename(safeName);
  const serviceName = getUnitFilename(safeName);

  // 1. Disable timer unit
  await runCommand('systemctl', ['--user', 'disable', '--now', timerName]);

  // 2. Check if service is running
  const activeRes = await runCommand('systemctl', ['--user', 'is-active', serviceName]);
  const isRunning = activeRes.stdout.trim() === 'active';

  if (isRunning) {
    if (!opts.force) {
      throw new Error(`Service ${serviceName} is currently running. Use --force to stop and remove.`);
    }
    await runCommand('systemctl', ['--user', 'stop', serviceName]);
  }

  // 3. Delete files
  deleteScheduleUnitFiles(safeName);

  // 4. Reload daemon & reset failed
  await runCommand('systemctl', ['--user', 'daemon-reload']);
  await runCommand('systemctl', ['--user', 'reset-failed']);

  return true;
}

/**
 * Parses systemctl show properties output.
 *
 * @param {string} stdout
 * @returns {Record<string, string>}
 */
function parseSystemctlShow(stdout) {
  const props = {};
  if (!stdout) return props;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      props[k] = v;
    }
  }
  return props;
}

/**
 * Returns detailed status of a schedule.
 *
 * @param {string} name
 * @returns {Promise<Object>}
 */
export async function getScheduleStatus(name) {
  const safeName = sanitizeServiceName(name);
  const meta = readScheduleMetadata(safeName);

  const timerFilename = getTimerFilename(safeName);
  const serviceFilename = getUnitFilename(safeName);

  const showTimerRes = await runCommand('systemctl', [
    '--user',
    'show',
    timerFilename,
    '--property=ActiveState,SubState,NextElapseUSecRealtime,NextElapseUSecMonotonic,NextElapseUSec,LastTriggerUSec,Unit,Triggers,UnitFileState'
  ]);

  const showServiceRes = await runCommand('systemctl', [
    '--user',
    'show',
    serviceFilename,
    '--property=ActiveState,SubState,ExecMainStatus,ExecMainCode'
  ]);

  const timerProps = parseSystemctlShow(showTimerRes.stdout);
  const serviceProps = parseSystemctlShow(showServiceRes.stdout);

  // Determine schedule description string
  let scheduleExpr = '';
  if (meta?.schedule?.every) {
    scheduleExpr = `every ${meta.schedule.every}`;
  } else if (meta?.schedule?.calendar) {
    scheduleExpr = meta.schedule.calendar;
  } else if (meta?.schedule?.onBoot) {
    scheduleExpr = `on-boot ${meta.schedule.onBoot}`;
  } else if (meta?.schedule?.onActive) {
    scheduleExpr = `on-active ${meta.schedule.onActive}`;
  } else {
    scheduleExpr = 'custom timer';
  }

  const activeState = timerProps.ActiveState || 'unknown';
  const unitFileState = timerProps.UnitFileState || 'unknown';

  let status = 'waiting';
  if (serviceProps.ActiveState === 'active') {
    status = 'running';
  } else if (activeState === 'inactive' || unitFileState === 'disabled') {
    status = 'disabled';
  } else if (timerProps.SubState) {
    status = timerProps.SubState;
  }

  // Parse NextElapse timestamp
  const rawNext = timerProps.NextElapseUSecRealtime || timerProps.NextElapseUSec;
  let nextRun = 'n/a';

  if (rawNext && rawNext !== '0' && rawNext !== '18446744073709551615') {
    const num = Number(rawNext);
    if (!isNaN(num) && num > 0) {
      nextRun = formatFutureTime(Math.floor(num / 1000));
    } else {
      nextRun = formatFutureTime(rawNext);
    }
  } else if (
    timerProps.NextElapseUSecMonotonic &&
    timerProps.NextElapseUSecMonotonic !== '0' &&
    timerProps.NextElapseUSecMonotonic !== '18446744073709551615'
  ) {
    const monoNum = Number(timerProps.NextElapseUSecMonotonic);
    if (!isNaN(monoNum) && monoNum > 0) {
      const currentMonoUSec = os.uptime() * 1000000;
      const diffUSec = monoNum - currentMonoUSec;
      if (diffUSec > 0) {
        const targetMs = Date.now() + Math.floor(diffUSec / 1000);
        nextRun = formatFutureTime(targetMs);
      } else {
        nextRun = 'imminent';
      }
    }
  }

  // Parse LastTrigger timestamp
  const rawLast = timerProps.LastTriggerUSec;
  let lastRun = 'never';
  if (rawLast && rawLast !== '0' && rawLast !== 'n/a') {
    const num = Number(rawLast);
    if (!isNaN(num) && num > 0) {
      lastRun = formatRelativeTime(Math.floor(num / 1000));
    } else {
      lastRun = formatRelativeTime(rawLast);
    }
  }

  return {
    name: safeName,
    group: meta?.group || 'default',
    schedule: scheduleExpr,
    nextRun,
    lastRun,
    status,
    activeState,
    subState: timerProps.SubState || 'unknown',
    unitFileState,
    serviceActiveState: serviceProps.ActiveState || 'unknown',
    metadata: meta,
    serviceUnit: serviceFilename,
    timerUnit: timerFilename
  };
}

/**
 * Lists all schedules and their status.
 *
 * @param {string} [group]
 * @returns {Promise<Array<Object>>}
 */
export async function listSchedules(group) {
  const dir = getSchedulesDir();
  const scheduleNames = new Set();

  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (f.endsWith('.json')) {
        scheduleNames.add(f.slice(0, -5));
      }
    }
  }

  const unitDir = getUserUnitDir();
  if (fs.existsSync(unitDir)) {
    const files = fs.readdirSync(unitDir);
    for (const f of files) {
      if (f.startsWith('unitup-') && f.endsWith('.timer')) {
        scheduleNames.add(f.slice(7, -6));
      }
    }
  }

  const result = [];
  for (const name of scheduleNames) {
    try {
      const st = await getScheduleStatus(name);
      if (!group || st.group === group) {
        result.push(st);
      }
    } catch {
      // ignore individual parse errors
    }
  }

  return result;
}
