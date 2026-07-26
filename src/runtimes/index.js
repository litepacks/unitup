import path from 'node:path';
import fs from 'node:fs';
import { createNodeAdapter } from './node.js';
import { createPythonAdapter } from './python.js';
import { createRubyAdapter } from './ruby.js';
import { createPhpAdapter } from './php.js';
import { createBunAdapter } from './bun.js';
import { createDenoAdapter } from './deno.js';
import { createShellAdapter } from './shell.js';
import { createNativeAdapter } from './native.js';
import { createGoAdapter } from './go.js';
import { createElixirAdapter } from './elixir.js';

export function detectRuntime(filepath) {
  if (!filepath) {
    throw new Error('Script path or command is required for runtime detection.');
  }

  const baseName = path.basename(filepath);
  const ext = path.extname(baseName).toLowerCase();

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return 'node';
  }
  if (ext === '.py') {
    return 'python';
  }
  if (ext === '.rb') {
    return 'ruby';
  }
  if (ext === '.php') {
    return 'php';
  }
  if (ext === '.sh') {
    return 'shell';
  }
  if (ext === '.go') {
    return 'go';
  }
  if (ext === '.ex' || ext === '.exs') {
    return 'elixir';
  }

  // Inspect shebang header if file exists
  const absPath = path.resolve(process.cwd(), filepath);
  if (fs.existsSync(absPath)) {
    try {
      const fd = fs.openSync(absPath, 'r');
      const buffer = Buffer.alloc(256);
      const bytesRead = fs.readSync(fd, buffer, 0, 256, 0);
      fs.closeSync(fd);

      const header = buffer.toString('utf8', 0, bytesRead);
      const firstLine = header.split('\n')[0].trim();

      if (firstLine.startsWith('#!')) {
        if (firstLine.includes('python')) return 'python';
        if (firstLine.includes('node')) return 'node';
        if (firstLine.includes('ruby')) return 'ruby';
        if (firstLine.includes('bash') || firstLine.includes('/sh')) return 'shell';
        if (firstLine.includes('bun')) return 'bun';
        if (firstLine.includes('deno')) return 'deno';
        if (firstLine.includes('php')) return 'php';
        if (firstLine.includes('go')) return 'go';
        if (firstLine.includes('elixir')) return 'elixir';
      }
    } catch {
      // ignore
    }
  }

  if (ext === '.ts') {
    throw new Error(
      `Could not determine runtime for ${baseName}.\n\nSpecify one:\n  unitup add ${baseName} --runtime bun\n  unitup add ${baseName} --runtime deno\n  unitup add ${baseName} --runtime node`
    );
  }

  if (ext === '') {
    return 'node';
  }

  throw new Error(
    `Could not determine runtime for ${baseName}.\n\nSpecify runtime with --runtime <name> or custom executable with --command <path>`
  );
}

export async function resolveRuntimeConfig(opts = {}) {
  // 1. If explicit --command is provided, bypass runtime auto-detection
  if (opts.command) {
    const absCommand = path.resolve(process.cwd(), opts.command);
    if (!fs.existsSync(absCommand)) {
      // If binary doesn't exist as exact file path, check if it's in PATH or native executable
      const { findRuntimeExecutable } = await import('./common.js');
      const resolved = await findRuntimeExecutable([opts.command]);
      if (!resolved) {
        throw new Error(`Command executable could not be resolved: ${opts.command}`);
      }
      const args = Array.isArray(opts.args) ? opts.args : [];
      return {
        command: resolved,
        args,
        runtime: opts.runtime || 'custom',
        version: 'custom'
      };
    }

    const args = Array.isArray(opts.args) ? opts.args : [];
    return {
      command: absCommand,
      args,
      runtime: opts.runtime || 'custom',
      version: 'custom'
    };
  }

  // 2. Resolve target runtime name
  let runtimeName = opts.runtime;
  if (!runtimeName) {
    runtimeName = detectRuntime(opts.script);
  }

  const cleanRuntime = runtimeName.toLowerCase();

  switch (cleanRuntime) {
    case 'node':
    case 'nodejs':
      return createNodeAdapter(opts);
    case 'python':
    case 'python3':
      return createPythonAdapter(opts);
    case 'ruby':
      return createRubyAdapter(opts);
    case 'php':
      return createPhpAdapter(opts);
    case 'bun':
      return createBunAdapter(opts);
    case 'deno':
      return createDenoAdapter(opts);
    case 'shell':
    case 'bash':
    case 'sh':
      return createShellAdapter(opts);
    case 'go':
    case 'golang':
      return createGoAdapter(opts);
    case 'elixir':
    case 'ex':
    case 'exs':
      return createElixirAdapter(opts);
    case 'native':
      return createNativeAdapter(opts);
    default:
      throw new Error(`Unsupported runtime: "${runtimeName}"`);
  }
}
