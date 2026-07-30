import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

/**
 * Returns the base unitup config directory (~/.config/unitup).
 * @returns {string}
 */
export function getUnitupDir() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'unitup');
}

/**
 * Returns the directory for app metadata (~/.config/unitup/apps).
 * @returns {string}
 */
export function getAppsDir() {
  return path.join(getUnitupDir(), 'apps');
}

/**
 * Returns the filepath for a specific service's metadata JSON file.
 * @param {string} name
 * @returns {string}
 */
export function getAppMetadataPath(name) {
  const safeName = sanitizeServiceName(name);
  return path.join(getAppsDir(), `${safeName}.json`);
}

/**
 * Validates systemd memory limit sizes (128K, 256M, 1G, 2T, infinity, max, or raw bytes).
 * @param {string|number} val
 * @param {string} paramName
 * @returns {string} Normalized memory limit string
 */
export function validateMemorySize(val, paramName = 'Memory limit') {
  if (val === null || val === undefined || val === '') {
    throw new Error(`${paramName} cannot be empty.`);
  }

  const str = String(val).trim();

  // Prevent shell injection and unsafe characters
  if (/[;&|$`"'\n\r\t ]/.test(str)) {
    throw new Error(`${paramName} contains invalid characters or shell injection attempt: "${str}".`);
  }

  // Reject negative numbers
  if (str.startsWith('-')) {
    throw new Error(`${paramName} cannot be negative: "${str}".`);
  }

  const lower = str.toLowerCase();
  if (lower === 'infinity' || lower === 'max') {
    return 'infinity';
  }

  // Matches numbers with optional K, M, G, T, P unit suffix (with optional 'b' or 'B')
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([kmgtp]?[bb]?)?$/i);
  if (!match) {
    throw new Error(`Invalid ${paramName} format: "${str}". Expected values like 128K, 256M, 1G, or infinity.`);
  }

  const num = match[1];
  const unit = (match[2] || '').toUpperCase().replace(/B$/, '');

  return `${num}${unit}`;
}

/**
 * Formats byte values or systemd memory limit markers into human readable strings.
 * @param {number|string} bytes
 * @returns {string} Formatted memory string e.g. "284 MB", "infinity", "unavailable"
 */
export function formatMemoryBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '' || bytes === 'unavailable' || bytes === '[unavailable]' || bytes === '-') {
    return 'unavailable';
  }

  const str = String(bytes).trim().toLowerCase();
  if (str === 'infinity' || str === 'max' || str === '18446744073709551615') {
    return 'infinity';
  }

  const num = Number(bytes);
  if (Number.isNaN(num) || num < 0) {
    // If it's already a formatted string like "400M" or "400 MB"
    if (/^\d+\s*[a-zA-Z]+$/.test(str)) {
      const match = str.match(/^(\d+)\s*([a-zA-Z]+)$/);
      if (match) {
        const u = match[2].toUpperCase().replace(/B$/, '');
        return `${match[1]} ${u === 'M' ? 'MB' : u === 'G' ? 'GB' : u === 'K' ? 'KB' : u}`;
      }
    }
    return 'unavailable';
  }

  if (num === 0) return '0 MB';

  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  const tb = gb * 1024;

  if (num >= tb) {
    const val = num / tb;
    return `${Number.isInteger(val) ? val : val.toFixed(1)} TB`;
  }
  if (num >= gb) {
    const val = num / gb;
    return `${Number.isInteger(val) ? val : val.toFixed(1)} GB`;
  }
  if (num >= mb) {
    const val = num / mb;
    return `${Number.isInteger(val) ? val : Math.round(val)} MB`;
  }
  if (num >= kb) {
    const val = num / kb;
    return `${Number.isInteger(val) ? val : Math.round(val)} KB`;
  }

  return `${num} B`;
}

/**
 * Saves metadata JSON for a service.
 * @param {object} meta
 * @returns {object}
 */
export function saveAppMetadata(meta) {
  const safeName = sanitizeServiceName(meta.name);
  const dir = getAppsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getAppMetadataPath(safeName);

  const command = meta.command ? resolveAbsolutePath(meta.command) : (meta.node ? resolveAbsolutePath(meta.node) : process.execPath);
  const rawArgs = Array.isArray(meta.args) ? meta.args : (meta.script ? [meta.script] : []);
  const args = rawArgs.map(a => (a.startsWith('/') || a.startsWith('./') || a.startsWith('../') || a.startsWith('~/')) ? resolveAbsolutePath(a) : a);
  const scriptPath = meta.script ? resolveAbsolutePath(meta.script) : (args[0] ? resolveAbsolutePath(args[0]) : command);
  const cwd = resolveWorkingDirectory(meta);

  // Extract memory resources if present
  const resources = meta.resources || {};
  if (meta.memoryHigh) resources.memoryHigh = validateMemorySize(meta.memoryHigh, 'MemoryHigh');
  if (meta.memoryMax) resources.memoryMax = validateMemorySize(meta.memoryMax, 'MemoryMax');
  if (meta.memorySwapMax) resources.memorySwapMax = validateMemorySize(meta.memorySwapMax, 'MemorySwapMax');

  const payload = {
    name: safeName,
    unit: getUnitFilename(safeName),
    runtime: meta.runtime || 'node',
    command,
    args,
    cwd,
    group: meta.group || 'default',
    // Optional resources section
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    // Backward compatibility fields
    script: scriptPath,
    node: meta.node ? resolveAbsolutePath(meta.node) : command
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Reads metadata JSON for a service.
 * @param {string} name
 * @returns {object|null}
 */
export function readAppMetadata(name) {
  try {
    let filePath = getAppMetadataPath(name);
    if (!fs.existsSync(filePath)) {
      filePath = getScheduleMetadataPath(name);
    }
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);
    if (!data) return null;

    const command = data.command || data.node || process.execPath;
    const args = data.args || (data.script ? [data.script] : []);
    let runtime = data.runtime;
    if (!runtime || (runtime === 'node' && data.command)) {
      const baseCmd = path.basename(command).toLowerCase();
      if (baseCmd !== 'node' && baseCmd !== 'nodejs') {
        runtime = 'custom';
      } else {
        runtime = 'node';
      }
    }
    const script = data.script || args[0] || command;
    const cwd = data.cwd || (script ? path.dirname(script) : process.cwd());

    return {
      ...data,
      name: data.name || sanitizeServiceName(name),
      unit: data.unit || getUnitFilename(name),
      runtime,
      command,
      args,
      cwd,
      group: data.group || 'default',
      resources: data.resources || undefined,
      script,
      node: data.node || command
    };
  } catch {
    return null;
  }
}

/**
 * Deletes metadata JSON for a service if it exists.
 * @param {string} name
 * @returns {boolean}
 */
export function deleteAppMetadata(name) {
  try {
    const filePath = getAppMetadataPath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Sanitizes a service name to ensure it is safe for systemd unit filenames.
 * - Converts to lowercase.
 * - Replaces spaces with hyphens.
 * - Strips any characters outside [a-z0-9_-].
 * - Prevents path traversal and empty results.
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeServiceName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('Service name must be a non-empty string.');
  }

  // Strip leading unitup- if already present to avoid double prefixing
  let clean = name.trim();
  if (clean.startsWith('unitup-')) {
    clean = clean.slice(7);
  }
  if (clean.endsWith('.service')) {
    clean = clean.slice(0, -8);
  }

  clean = clean
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-+/g, '-');

  if (!clean) {
    throw new Error(`Invalid service name "${name}". Name must contain alphanumeric characters.`);
  }

  return clean;
}

/**
 * Returns the full systemd unit filename for a service name.
 *
 * @param {string} name
 * @returns {string}
 */
export function getUnitFilename(name) {
  const safeName = sanitizeServiceName(name);
  return `unitup-${safeName}.service`;
}

/**
 * Extracts the user-friendly service name from a unit filename (e.g., unitup-api.service -> api).
 *
 * @param {string} unitFilename
 * @returns {string}
 */
export function getServiceNameFromUnit(unitFilename) {
  let base = path.basename(unitFilename);
  if (base.endsWith('.service')) {
    base = base.slice(0, -8);
  }
  if (base.startsWith('unitup-')) {
    base = base.slice(7);
  }
  return base;
}

/**
 * Resolves a file path to an absolute path, expanding tilde (~) if present.
 *
 * @param {string} filepath
 * @param {string} [baseDir]
 * @returns {string}
 */
export function resolveAbsolutePath(filepath, baseDir = process.cwd()) {
  if (!filepath) return '';
  let p = filepath;
  if (p.startsWith('~/') || p === '~') {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(baseDir, p);
}

/**
 * Safely resolves the working directory for a service or schedule unit.
 *
 * @param {Object} [opts]
 * @returns {string}
 */
export function resolveWorkingDirectory(opts = {}) {
  if (opts.cwd) {
    return resolveAbsolutePath(opts.cwd);
  }
  if (opts.script) {
    return path.dirname(resolveAbsolutePath(opts.script));
  }
  try {
    const cwd = process.cwd();
    if (fs.existsSync(cwd)) {
      fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
      return cwd;
    }
  } catch {
    // fallback if process.cwd() is inaccessible
  }
  return os.homedir();
}

/**
 * Escapes values for systemd Environment= line entries.
 * E.g. KEY="val with spaces"
 *
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function formatSystemdEnv(key, value) {
  // Validate key to be alphanumeric + underscore
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
    throw new Error(`Invalid environment variable key: "${key}"`);
  }
  const strVal = String(value);
  // Systemd environment escaping: quote value if it contains space, quote, or special chars
  const escaped = strVal.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$');
  return `${key}="${escaped}"`;
}

/**
 * Escapes an argument for an ExecStart directive in systemd unit file.
 *
 * @param {string} arg
 * @returns {string}
 */
export function escapeExecArg(arg) {
  const str = String(arg);
  if (!str) return '""';
  // If argument contains spaces, quotes, or backslashes, wrap in double quotes and escape internal quotes/backslashes
  if (/[\s"'\\]/.test(str)) {
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return str;
}

/**
 * Formats a timestamp string into a human readable "X ago" or date string.
 *
 * @param {string|number} timestamp
 * @returns {string}
 */
export function formatRelativeTime(timestamp) {
  if (!timestamp || timestamp === 'n/a' || timestamp === '0') {
    return 'unknown';
  }
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) {
    return String(timestamp);
  }
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds} seconds ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Formats data rows into a text table.
 *
 * @param {Array<Object>} data
 * @param {Array<{ key: string, label: string }>} columns
 * @returns {string}
 */
export function formatTable(data, columns) {
  if (!data || data.length === 0) {
    return 'No services found.';
  }

  const widths = columns.map(col => col.label.length);

  for (const row of data) {
    columns.forEach((col, idx) => {
      const val = String(row[col.key] ?? '');
      if (val.length > widths[idx]) {
        widths[idx] = val.length;
      }
    });
  }

  const headerLine = columns.map((col, idx) => col.label.padEnd(widths[idx])).join('   ');
  const lines = [headerLine];

  for (const row of data) {
    const line = columns
      .map((col, idx) => String(row[col.key] ?? '').padEnd(widths[idx]))
      .join('   ');
    lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Returns the directory for schedule metadata (~/.config/unitup/schedules).
 * @returns {string}
 */
export function getSchedulesDir() {
  return path.join(getUnitupDir(), 'schedules');
}

/**
 * Returns the filepath for a specific schedule's metadata JSON file.
 * @param {string} name
 * @returns {string}
 */
export function getScheduleMetadataPath(name) {
  const safeName = sanitizeServiceName(name);
  return path.join(getSchedulesDir(), `${safeName}.json`);
}

/**
 * Saves metadata JSON for a schedule.
 * @param {object} meta
 * @returns {object}
 */
export function saveScheduleMetadata(meta) {
  const safeName = sanitizeServiceName(meta.name);
  const dir = getSchedulesDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getScheduleMetadataPath(safeName);

  const command = meta.command ? resolveAbsolutePath(meta.command) : process.execPath;
  const rawArgs = Array.isArray(meta.args) ? meta.args : [];
  const args = rawArgs.map(a => (a.startsWith('/') || a.startsWith('./') || a.startsWith('../') || a.startsWith('~/')) ? resolveAbsolutePath(a) : a);

  const resources = meta.resources || {};
  if (meta.memoryHigh) resources.memoryHigh = validateMemorySize(meta.memoryHigh, 'MemoryHigh');
  if (meta.memoryMax) resources.memoryMax = validateMemorySize(meta.memoryMax, 'MemoryMax');
  if (meta.memorySwapMax) resources.memorySwapMax = validateMemorySize(meta.memorySwapMax, 'MemorySwapMax');

  const payload = {
    name: safeName,
    group: meta.group || 'default',
    type: 'timer',
    runtime: meta.runtime || (meta.command ? 'custom' : 'node'),
    command,
    args,
    cwd: meta.cwd ? resolveAbsolutePath(meta.cwd) : process.cwd(),
    schedule: {
      every: meta.schedule?.every || null,
      calendar: meta.schedule?.calendar || null,
      onBoot: meta.schedule?.onBoot || null,
      onActive: meta.schedule?.onActive || null,
      persistent: Boolean(meta.schedule?.persistent),
      randomDelay: meta.schedule?.randomDelay || null
    },
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    serviceUnit: `unitup-${safeName}.service`,
    timerUnit: `unitup-${safeName}.timer`
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * Reads metadata JSON for a schedule.
 * @param {string} name
 * @returns {object|null}
 */
export function readScheduleMetadata(name) {
  try {
    const filePath = getScheduleMetadataPath(name);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const meta = JSON.parse(content);
    if (!meta) return null;

    // Normalization for legacy metadata format where runtime defaulted to 'node' for custom commands
    if (meta.runtime === 'node' && meta.command) {
      const baseCmd = path.basename(meta.command).toLowerCase();
      if (baseCmd !== 'node' && baseCmd !== 'nodejs') {
        meta.runtime = 'custom';
      }
    }
    return meta;
  } catch {
    return null;
  }
}

/**
 * Deletes metadata JSON for a schedule if it exists.
 * @param {string} name
 * @returns {boolean}
 */
export function deleteScheduleMetadata(name) {
  try {
    const filePath = getScheduleMetadataPath(name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {}
  return false;
}

/**
 * Returns the full systemd timer filename for a schedule name.
 * @param {string} name
 * @returns {string}
 */
export function getTimerFilename(name) {
  const safeName = sanitizeServiceName(name);
  return `unitup-${safeName}.timer`;
}

/**
 * Validates systemd time span duration strings (e.g., 30s, 10m, 2h, 1d).
 * @param {string|number} val
 * @param {string} [paramName]
 * @returns {string}
 */
export function validateDuration(val, paramName = 'Duration') {
  if (val === null || val === undefined || val === '') {
    throw new Error(`${paramName} cannot be empty.`);
  }

  const str = String(val).trim();

  // Prevent shell injection and unsafe characters
  if (/[;&|$`"'\n\r\t]/.test(str)) {
    throw new Error(`${paramName} contains invalid characters or shell injection attempt: "${str}".`);
  }

  // Reject negative numbers
  if (str.startsWith('-')) {
    throw new Error(`${paramName} cannot be negative: "${str}".`);
  }

  const tokens = str.split(/\s+/);
  const tokenRegex = /^(\d+(?:\.\d+)?)(us|usec|ms|msec|s|sec|seconds?|m|min|minutes?|h|hr|hours?|d|day|days?|w|week|weeks?|mth|months?|y|year|years?)$/i;

  for (const token of tokens) {
    if (!tokenRegex.test(token)) {
      throw new Error(`Invalid ${paramName} format: "${str}". Expected values like 30s, 10m, 2h, 1d.`);
    }
  }

  return str;
}

/**
 * Formats a future date/timestamp into relative human readable string (e.g. "in 12 minutes", "tomorrow").
 * @param {string|number|Date} dateVal
 * @returns {string}
 */
export function formatFutureTime(dateVal) {
  if (!dateVal || dateVal === 'n/a' || dateVal === '0' || dateVal === 'infinity') {
    return 'n/a';
  }
  const date = new Date(typeof dateVal === 'number' && dateVal > 1e12 ? dateVal : (typeof dateVal === 'number' ? dateVal / 1000 : dateVal));
  if (isNaN(date.getTime())) {
    return String(dateVal);
  }
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'imminent';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `in ${seconds} seconds`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * Returns the filepath to the global unitup config JSON file (~/.config/unitup/config.json).
 * @returns {string}
 */
export function getConfigFilepath() {
  return path.join(getUnitupDir(), 'config.json');
}

/**
 * Reads global unitup configuration JSON file.
 * @returns {object}
 */
export function readGlobalConfig() {
  try {
    const file = getConfigFilepath();
    if (!fs.existsSync(file)) return {};
    const content = fs.readFileSync(file, 'utf8');
    return JSON.parse(content) || {};
  } catch {
    return {};
  }
}

/**
 * Saves global unitup configuration JSON file.
 * @param {object} config
 * @returns {object}
 */
export function saveGlobalConfig(config) {
  const dir = getUnitupDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const file = getConfigFilepath();
  const current = readGlobalConfig();
  const updated = { ...current, ...config };
  fs.writeFileSync(file, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Resolves effective memory limits considering explicit options, env vars, and global config defaults (default: 1G).
 * @param {object} opts
 * @returns {{ memoryHigh?: string, memoryMax?: string, memorySwapMax?: string }}
 */
export function resolveEffectiveMemoryLimits(opts = {}) {
  const memHigh = opts.memoryHigh || opts.resources?.memoryHigh;
  const memMax = opts.memoryMax || opts.resources?.memoryMax;
  const memSwapMax = opts.memorySwapMax || opts.resources?.memorySwapMax;

  if (memHigh || memMax || memSwapMax) {
    return {
      ...(memHigh ? { memoryHigh: validateMemorySize(memHigh, 'MemoryHigh') } : {}),
      ...(memMax ? { memoryMax: validateMemorySize(memMax, 'MemoryMax') } : {}),
      ...(memSwapMax ? { memorySwapMax: validateMemorySize(memSwapMax, 'MemorySwapMax') } : {})
    };
  }

  let defaultMem = opts.defaultMemory;

  if (!defaultMem && process.env.UNITUP_DEFAULT_MEMORY) {
    defaultMem = process.env.UNITUP_DEFAULT_MEMORY;
  }

  if (!defaultMem) {
    const cfg = readGlobalConfig();
    if (cfg.defaultMemory) {
      defaultMem = cfg.defaultMemory;
    }
  }

  if (defaultMem) {
    const sizeStr = (typeof defaultMem === 'boolean' || defaultMem === 'true' || defaultMem === '') ? '1G' : String(defaultMem);
    const validSize = validateMemorySize(sizeStr, 'Default memory limit');
    return { memoryMax: validSize };
  }

  return {};
}


