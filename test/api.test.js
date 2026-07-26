import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createService,
  startService,
  stopService,
  restartService,
  removeService,
  getServiceStatus,
  listServices,
  setCommandRunner,
  resetCommandRunner,
  getUserUnitDir,
  unitFileExists
} from '../src/index.js';

describe('Programmatic API with Mocked Systemctl', () => {
  let tmpDir;
  let executedCommands = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    executedCommands = [];

    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          code: 0,
          stdout: 'ActiveState=active\nSubState=running\nMainPID=12345\nNRestarts=0\nActiveEnterTimestamp=2026-07-26 10:00:00 UTC\nUnitFileState=enabled\n',
          stderr: ''
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('createService writes unit file and calls daemon-reload', async () => {
    const dummyScriptPath = path.join(tmpDir, 'dummy.js');
    fs.writeFileSync(dummyScriptPath, 'console.log("hello");');

    const res = await createService({
      name: 'test-app',
      script: dummyScriptPath,
      start: true
    });

    assert.equal(res.name, 'test-app');
    assert.equal(unitFileExists('test-app'), true);

    const unitPath = path.join(getUserUnitDir(), 'unitup-test-app.service');
    assert.equal(fs.existsSync(unitPath), true);

    const content = fs.readFileSync(unitPath, 'utf8');
    assert.match(content, /ExecStart=.*dummy\.js/);

    assert.ok(executedCommands.some(c => c.cmd === 'systemctl' && c.args.includes('daemon-reload')));
    assert.ok(executedCommands.some(c => c.cmd === 'systemctl' && c.args.includes('enable')));
  });

  test('startService, stopService, restartService execute appropriate systemctl commands', async () => {
    const dummyScriptPath = path.join(tmpDir, 'dummy.js');
    fs.writeFileSync(dummyScriptPath, 'console.log("hello");');

    await createService({
      name: 'my-service',
      script: dummyScriptPath
    });

    executedCommands = [];

    await startService('my-service');
    assert.deepEqual(executedCommands[0], {
      cmd: 'systemctl',
      args: ['--user', 'start', 'unitup-my-service.service']
    });

    await stopService('my-service');
    assert.deepEqual(executedCommands[1], {
      cmd: 'systemctl',
      args: ['--user', 'stop', 'unitup-my-service.service']
    });

    await restartService('my-service');
    assert.deepEqual(executedCommands[2], {
      cmd: 'systemctl',
      args: ['--user', 'restart', 'unitup-my-service.service']
    });
  });

  test('getServiceStatus returns formatted status object', async () => {
    const dummyScriptPath = path.join(tmpDir, 'dummy.js');
    fs.writeFileSync(dummyScriptPath, 'console.log("hello");');

    await createService({
      name: 'status-app',
      script: dummyScriptPath
    });

    const status = await getServiceStatus('status-app');
    assert.equal(status.name, 'status-app');
    assert.equal(status.status, 'running');
    assert.equal(status.pid, '12345');
    assert.equal(status.restarts, '0');
  });

  test('removeService disables, removes file, reloads daemon and resets failed state', async () => {
    const dummyScriptPath = path.join(tmpDir, 'dummy.js');
    fs.writeFileSync(dummyScriptPath, 'console.log("hello");');

    await createService({
      name: 'to-remove',
      script: dummyScriptPath
    });

    assert.equal(unitFileExists('to-remove'), true);
    executedCommands = [];

    await removeService('to-remove');

    assert.equal(unitFileExists('to-remove'), false);

    assert.ok(executedCommands.some(c => c.args.includes('disable')));
    assert.ok(executedCommands.some(c => c.args.includes('daemon-reload')));
    assert.ok(executedCommands.some(c => c.args.includes('reset-failed')));
  });

  test('throws meaningful error when service does not exist', async () => {
    await assert.rejects(
      async () => await startService('non-existent'),
      /Service "non-existent" does not exist/
    );
  });
});
