import fs from 'node:fs';
import path from 'node:path';
import { ExecutableNotFoundError, InvalidServiceConfigError } from '../errors.js';
import { detectRuntime, resolveRuntimeConfig } from '../runtimes/index.js';
import { getUnitupDir, resolveEffectiveMemoryLimits, resolveWorkingDirectory, sanitizeServiceName } from '../utils.js';

/**
 * Resolves a binary or command name to an absolute executable path.
 * Supports Windows PATHEXT extensions (.exe, .cmd, .bat, etc.) and Unix executable permissions.
 *
 * @param {string} binaryName
 * @param {object} [opts]
 * @param {string} [opts.cwd]
 * @param {string} [opts.pathEnv]
 * @returns {string|null}
 */
export function resolveExecutable(binaryName, opts = {}) {
  if (!binaryName || typeof binaryName !== 'string') {
    return null;
  }

  const trimmed = binaryName.trim();
  if (!trimmed) return null;

  const baseDir = opts.cwd || process.cwd();
  const isWin = process.platform === 'win32';
  const pathext = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.WSC;.MSI').split(';').filter(Boolean)
    : [''];

  // Helper to check if a specific file is executable
  function isExecutableFile(targetPath) {
    try {
      if (!fs.existsSync(targetPath)) return false;
      const stat = fs.statSync(targetPath);
      if (!stat.isFile()) return false;
      if (isWin) return true;
      fs.accessSync(targetPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  // 1. If path is absolute or explicit relative path (starts with ./, ../, /)
  if (path.isAbsolute(trimmed) || trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~/')) {
    const expanded = trimmed.startsWith('~/')
      ? path.join(process.env.HOME || process.env.USERPROFILE || '', trimmed.slice(2))
      : path.resolve(baseDir, trimmed);

    if (isExecutableFile(expanded)) {
      return fs.realpathSync(expanded);
    }

    if (isWin) {
      for (const ext of pathext) {
        const withExt = expanded + ext.toLowerCase();
        if (isExecutableFile(withExt)) {
          return fs.realpathSync(withExt);
        }
      }
    }

    return null;
  }

  // 2. Look in system PATH
  const envPath = opts.pathEnv || process.env.PATH || '';
  const searchDirs = envPath.split(path.delimiter).filter(Boolean);

  for (const dir of searchDirs) {
    const candidate = path.join(dir, trimmed);
    if (isExecutableFile(candidate)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }

    if (isWin) {
      for (const ext of pathext) {
        const candidateWithExt = candidate + ext.toLowerCase();
        if (isExecutableFile(candidateWithExt)) {
          try {
            return fs.realpathSync(candidateWithExt);
          } catch {
            return candidateWithExt;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Normalizes input service options into a complete, validated NormalizedServiceConfig object.
 *
 * @param {object} rawOpts
 * @returns {Promise<object>} NormalizedServiceConfig
 */
export async function normalizeServiceConfig(rawOpts = {}) {
  if (!rawOpts || typeof rawOpts !== 'object') {
    throw new InvalidServiceConfigError('Service configuration options must be an object.');
  }

  const name = rawOpts.name ? sanitizeServiceName(rawOpts.name) : '';
  if (!name) {
    throw new InvalidServiceConfigError('Service name is required.', 'name');
  }

  const cwd = resolveWorkingDirectory(rawOpts);
  const runtimeConfig = await resolveRuntimeConfig({
    ...rawOpts,
    name,
    cwd
  });

  const command = runtimeConfig.command;
  if (!command) {
    throw new ExecutableNotFoundError(
      rawOpts.command || rawOpts.script || 'executable',
      `Executable could not be resolved for service "${name}".`
    );
  }

  const args = Array.isArray(runtimeConfig.args) ? [...runtimeConfig.args] : [];
  const displayName = rawOpts.displayName || rawOpts.name || name;
  const description = rawOpts.description || `unitup service: ${name}`;
  const group = rawOpts.group || 'default';
  const system = !!rawOpts.system;
  const autostart = rawOpts.autostart !== undefined ? !!rawOpts.autostart : true;
  const shutdownTimeout =
    rawOpts.shutdownTimeout !== undefined &&
    !Number.isNaN(Number(rawOpts.shutdownTimeout)) &&
    Number(rawOpts.shutdownTimeout) > 0
      ? Number(rawOpts.shutdownTimeout)
      : 10000;

  // Environment normalization
  const env = {};
  if (rawOpts.env && typeof rawOpts.env === 'object') {
    for (const [k, v] of Object.entries(rawOpts.env)) {
      if (v !== undefined && v !== null) {
        env[k] = String(v);
      }
    }
  }

  // Restart policy normalization
  let restartPolicy = 'on-failure';
  let restartEnabled = true;
  let restartDelay = 3000;
  let maxRetries = null;
  let resetAfter = null;

  if (typeof rawOpts.restart === 'string') {
    restartPolicy = rawOpts.restart;
    restartEnabled = restartPolicy !== 'no';
  } else if (rawOpts.restart && typeof rawOpts.restart === 'object') {
    restartEnabled = rawOpts.restart.enabled !== false;
    restartPolicy = rawOpts.restart.policy || (restartEnabled ? 'on-failure' : 'no');
    if (rawOpts.restart.delay !== undefined && !Number.isNaN(Number(rawOpts.restart.delay))) {
      restartDelay = Number(rawOpts.restart.delay);
    }
    if (rawOpts.restart.maxRetries !== undefined && !Number.isNaN(Number(rawOpts.restart.maxRetries))) {
      maxRetries = Number(rawOpts.restart.maxRetries);
    }
    if (rawOpts.restart.resetAfter !== undefined && !Number.isNaN(Number(rawOpts.restart.resetAfter))) {
      resetAfter = Number(rawOpts.restart.resetAfter);
    }
  }

  // Logs normalization
  const unitupDir = getUnitupDir();
  const logsDir = path.join(unitupDir, 'logs');
  const defaultStdout = path.join(logsDir, `${name}.log`);
  const defaultStderr = path.join(logsDir, `${name}-error.log`);

  const logs = {
    stdout: rawOpts.logs?.stdout || rawOpts.stdout || defaultStdout,
    stderr: rawOpts.logs?.stderr || rawOpts.stderr || defaultStderr
  };

  // Memory and resource limits
  const resources = resolveEffectiveMemoryLimits(rawOpts);

  return {
    name,
    displayName,
    description,
    runtime: runtimeConfig.runtime || 'custom',
    command,
    args,
    script: rawOpts.script ? path.resolve(cwd, rawOpts.script) : undefined,
    cwd,
    env,
    envFile: rawOpts.envFile ? path.resolve(cwd, rawOpts.envFile) : undefined,
    autostart,
    restart: {
      enabled: restartEnabled,
      policy: restartPolicy,
      delay: restartDelay,
      maxRetries,
      resetAfter
    },
    logs,
    group,
    system,
    shutdownTimeout,
    resources,
    raw: rawOpts
  };
}
