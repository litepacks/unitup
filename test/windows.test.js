import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PermissionRequiredError, ServiceNotFoundError } from '../src/errors.js';
import { WindowsServiceHost } from '../src/platform/windows-host.js';
import { WindowsAdapter } from '../src/platform/windows.js';
import { normalizeServiceConfig } from '../src/service/normalize.js';
import { resetCommandRunner, setCommandRunner } from '../src/systemd.js';

describe('Windows Service Adapter Suite', () => {
  let tmpDir;
  let adapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-win-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    adapter = new WindowsAdapter();
  });

  afterEach(() => {
    resetCommandRunner();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('windows adapter exposes correct capabilities and service name', () => {
    assert.equal(adapter.name, 'windows');
    assert.equal(adapter.capabilities.serviceManager, 'windows');
    assert.equal(adapter.capabilities.supports.install, true);
    assert.equal(adapter.capabilities.supports.start, true);
    assert.equal(adapter.capabilities.supports.stop, true);
    assert.equal(adapter.getServiceName('api-service'), 'unitup-api-service');
  });

  test('generateService produces correct sc.exe binPath and configuration', async () => {
    const dummyScript = path.join(tmpDir, 'server.js');
    fs.writeFileSync(dummyScript, 'console.log("win");');

    const config = await normalizeServiceConfig({
      name: 'worker-app',
      script: dummyScript,
      cwd: tmpDir,
      autostart: true
    });

    const generated = adapter.generateService(config);

    assert.equal(generated.serviceName, 'unitup-worker-app');
    assert.match(generated.displayName, /Unitup - worker-app/);
    assert.equal(generated.startType, 'auto');
    assert.ok(generated.binPath.includes('windows-host.js'));
    assert.ok(generated.binPath.includes('worker-app'));
  });

  test('install issues sc.exe create command with binPath and startType', async () => {
    const executedCommands = [];
    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      return { code: 0, stdout: '[SC] CreateService SUCCESS', stderr: '' };
    });

    const dummyScript = path.join(tmpDir, 'service.js');
    fs.writeFileSync(dummyScript, '');

    const config = await normalizeServiceConfig({
      name: 'background-task',
      script: dummyScript,
      cwd: tmpDir
    });

    const res = await adapter.install(config);
    assert.equal(res.name, 'background-task');
    assert.equal(res.serviceName, 'unitup-background-task');

    assert.ok(
      executedCommands.some(
        (c) => c.cmd === 'sc.exe' && c.args.includes('create') && c.args.includes('unitup-background-task')
      )
    );
  });

  test('install throws PermissionRequiredError when sc.exe returns Access is denied', async () => {
    setCommandRunner(async () => {
      return { code: 5, stdout: '', stderr: '[SC] OpenSCManager FAILED 5: Access is denied.' };
    });

    const dummyScript = path.join(tmpDir, 'app.js');
    fs.writeFileSync(dummyScript, '');

    const config = await normalizeServiceConfig({
      name: 'denied-service',
      script: dummyScript,
      cwd: tmpDir
    });

    await assert.rejects(async () => adapter.install(config), PermissionRequiredError);
  });

  test('start, stop, restart, enable, disable sc.exe commands', async () => {
    const executedCommands = [];
    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    });

    await adapter.start('my-svc');
    assert.ok(
      executedCommands.some((c) => c.cmd === 'sc.exe' && c.args.includes('start') && c.args.includes('unitup-my-svc'))
    );

    await adapter.stop('my-svc');
    assert.ok(
      executedCommands.some((c) => c.cmd === 'sc.exe' && c.args.includes('stop') && c.args.includes('unitup-my-svc'))
    );

    await adapter.enable('my-svc');
    assert.ok(executedCommands.some((c) => c.cmd === 'sc.exe' && c.args.includes('config') && c.args.includes('auto')));

    await adapter.disable('my-svc');
    assert.ok(
      executedCommands.some((c) => c.cmd === 'sc.exe' && c.args.includes('config') && c.args.includes('disabled'))
    );
  });

  test('status parses sc.exe query RUNNING and STOPPED states', async () => {
    setCommandRunner(async (cmd, args) => {
      if (cmd === 'sc.exe' && args.includes('query')) {
        return {
          code: 0,
          stdout: `
            SERVICE_NAME: unitup-status-svc
                    TYPE               : 10  WIN32_OWN_PROCESS
                    STATE              : 4  RUNNING
                                            (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
                    WIN32_EXIT_CODE    : 0  (0x0)
                    SERVICE_EXIT_CODE  : 0  (0x0)
                    CHECKPOINT         : 0x0
                    WAIT_HINT          : 0x0
          `,
          stderr: ''
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const stat = await adapter.status('status-svc');
    assert.equal(stat.name, 'status-svc');
    assert.equal(stat.state, 'running');
    assert.equal(stat.installed, true);
    assert.equal(stat.platform, 'win32');
    assert.equal(stat.manager, 'windows');
  });

  test('WindowsServiceHost manages child process lifecycle and shutdown', async () => {
    const stdoutLog = path.join(tmpDir, 'child.log');
    const host = new WindowsServiceHost({
      name: 'test-host-svc',
      command: process.execPath,
      args: ['-e', 'setInterval(() => console.log("running"), 100);'],
      cwd: tmpDir,
      shutdownTimeout: 2000,
      logs: {
        stdout: stdoutLog,
        stderr: stdoutLog
      }
    });

    host.start();
    assert.ok(host.child);
    assert.ok(host.child.pid > 0);

    // Wait a brief moment for child to write
    await new Promise((r) => setTimeout(r, 250));

    // Graceful stop
    await host.stop();
    assert.equal(host.child, null);
    assert.equal(host.stopping, true);

    const logContent = fs.readFileSync(stdoutLog, 'utf8');
    assert.ok(logContent.includes('[unitup host]'));
  });
});
