import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { parseArgs, runCli } from '../src/cli.js';
import { GenerationManager } from '../src/core/generation-manager.js';
import { IPCServer } from '../src/core/ipc.js';
import { defaultManager } from '../src/service/manager.js';

describe('CLI Deploy & Rollback Commands Suite', () => {
  test('parseArgs parses deploy and rollback commands with flags', () => {
    const deployArgs = parseArgs([
      'deploy',
      'api',
      '--port',
      '3000',
      '--zero-downtime',
      '--ready',
      '/health',
      '--drain',
      '30s'
    ]);

    assert.strictEqual(deployArgs.command, 'deploy');
    assert.deepStrictEqual(deployArgs.positionals, ['api']);
    assert.strictEqual(deployArgs.flags.port, '3000');
    assert.strictEqual(deployArgs.flags.zeroDowntime, true);
    assert.strictEqual(deployArgs.flags.ready, '/health');
    assert.strictEqual(deployArgs.flags.drain, '30s');

    const rollbackArgs = parseArgs(['rollback', 'api']);
    assert.strictEqual(rollbackArgs.command, 'rollback');
    assert.deepStrictEqual(rollbackArgs.positionals, ['api']);
  });

  test('parseArgs parses inline flag assignments e.g. --port=8080', () => {
    const parsed = parseArgs(['deploy', 'web', '--port=8080', '--ready=/ready', '--drain=15s']);
    assert.strictEqual(parsed.command, 'deploy');
    assert.strictEqual(parsed.flags.port, '8080');
    assert.strictEqual(parsed.flags.ready, '/ready');
    assert.strictEqual(parsed.flags.drain, '15s');
  });

  test('parseArgs parses generations and history commands', () => {
    const genArgs = parseArgs(['generations', 'api']);
    assert.strictEqual(genArgs.command, 'generations');
    assert.deepStrictEqual(genArgs.positionals, ['api']);

    const histArgs = parseArgs(['history', 'api']);
    assert.strictEqual(histArgs.command, 'history');
    assert.deepStrictEqual(histArgs.positionals, ['api']);
  });

  test('unitup generations prints formatted table of generations with ACTIVE FOR', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-cli-gen-'));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;

    const gm = new GenerationManager({ stateDir: path.join(tmpDir, 'unitup', 'state') });
    const now = Date.now();
    gm.saveState('api', {
      service: 'api',
      activeGeneration: 2,
      generations: {
        '1': {
          id: 1,
          service: 'api',
          pid: 1234,
          internalPort: 43121,
          status: 'stopped',
          createdAt: new Date(now - 120000).toISOString(),
          activatedAt: new Date(now - 120000).toISOString(),
          stoppedAt: new Date(now - 60000).toISOString()
        },
        '2': {
          id: 2,
          service: 'api',
          pid: 1235,
          internalPort: 43122,
          status: 'active',
          createdAt: new Date(now - 60000).toISOString(),
          activatedAt: new Date(now - 60000).toISOString()
        }
      }
    });

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['generations', 'api']);
    } finally {
      console.log = origLog;
      if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const output = logs.join('\n');
    assert.match(output, /=== Generations: api ===/);
    assert.match(output, /GEN\s+STATUS\s+PID\s+PORT\s+CREATED\s+ACTIVE FOR/);
    assert.match(output, /#1/);
    assert.match(output, /#2/);
    assert.match(output, /stopped/);
    assert.match(output, /active/);
    assert.match(output, /43121/);
    assert.match(output, /43122/);
    assert.match(output, /1 min/);
  });

  test('unitup generations --json returns valid json array', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-cli-gen-'));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;

    const gm = new GenerationManager({ stateDir: path.join(tmpDir, 'unitup', 'state') });
    gm.saveState('api', {
      service: 'api',
      activeGeneration: 1,
      generations: {
        '1': {
          id: 1,
          service: 'api',
          pid: 5678,
          internalPort: 43199,
          status: 'active',
          createdAt: new Date().toISOString(),
          activatedAt: new Date().toISOString()
        }
      }
    });

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['generations', 'api', '--json']);
    } finally {
      console.log = origLog;
      if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const output = logs.join('\n');
    const parsed = JSON.parse(output);
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 1);
    assert.strictEqual(parsed[0].status, 'active');
    assert.strictEqual(parsed[0].internalPort, 43199);
    assert.ok(parsed[0].activeFor);
  });

  test('unitup status enriches with generation and router information', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-cli-status-'));
    const origXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmpDir;

    const gm = new GenerationManager({ stateDir: path.join(tmpDir, 'unitup', 'state') });
    gm.saveState('api', {
      service: 'api',
      activeGeneration: 2,
      generations: {
        '2': {
          id: 2,
          service: 'api',
          pid: 9999,
          internalPort: 43122,
          status: 'active',
          createdAt: new Date().toISOString()
        }
      }
    });

    const origStatus = defaultManager.status;
    defaultManager.status = async (name) => ({
      name,
      status: 'running',
      pid: 9999,
      started: '5 minutes ago',
      restarts: 0,
      command: 'node server.js',
      arguments: '',
      cwd: '/app'
    });

    // 1. Without supervisor running: shows internal port
    let logs = [];
    let origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['status', 'api']);
    } finally {
      console.log = origLog;
    }

    let output = logs.join('\n');
    assert.match(output, /Active Generation: #2/);
    assert.match(output, /Internal Port: 43122/);

    // 2. With supervisor IPC server running: shows router and in-flight count
    const ipcServer = new IPCServer({
      serviceName: 'api',
      handler: async (msg) => {
        if (msg.action === 'status') {
          return {
            routerPort: 3000,
            inFlightRequests: 5
          };
        }
        return {};
      }
    });
    await ipcServer.start();

    logs = [];
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['status', 'api']);
    } finally {
      console.log = origLog;
    }

    output = logs.join('\n');
    assert.match(output, /Active Generation: #2/);
    assert.match(output, /Router: :3000 -> :43122/);
    assert.match(output, /In-Flight Requests: 5/);

    // 3. With --json flag
    logs = [];
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['status', 'api', '--json']);
    } finally {
      console.log = origLog;
      await ipcServer.close();
      defaultManager.status = origStatus;
      if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
      else delete process.env.XDG_CONFIG_HOME;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    const parsedJson = JSON.parse(logs.join('\n'));
    assert.strictEqual(parsedJson.name, 'api');
    assert.strictEqual(parsedJson.deployment?.activeGeneration, 2);
    assert.strictEqual(parsedJson.deployment?.internalPort, 43122);
    assert.strictEqual(parsedJson.deployment?.routerPort, 3000);
    assert.strictEqual(parsedJson.deployment?.inFlightRequests, 5);
  });
});
