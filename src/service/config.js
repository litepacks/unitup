import fs from 'node:fs';
import path from 'node:path';
import {
  findProjectConfig,
  getConfigFilepath,
  getUnitupDir,
  readGlobalConfig,
  readProjectConfig,
  saveGlobalConfig,
  saveProjectConfig
} from '../utils.js';

export {
  findProjectConfig,
  readProjectConfig,
  saveProjectConfig,
  readGlobalConfig,
  saveGlobalConfig,
  getConfigFilepath,
  getUnitupDir
};

/**
 * Merges raw CLI options with any found project configuration.
 *
 * @param {object} opts
 * @returns {object} Merged options
 */
export function mergeConfigWithOptions(opts = {}) {
  const targetCwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  const configPath = opts.config ? path.resolve(targetCwd, opts.config) : findProjectConfig(targetCwd);
  const projectCfg = configPath ? readProjectConfig(configPath) : null;

  if (!projectCfg) {
    return { ...opts, cwd: targetCwd };
  }

  return {
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
