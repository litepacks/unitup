import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  addService,
  startService,
  stopService,
  restartService,
  removeService,
  listServices,
  inspectService,
  getServiceFailures,
  setCommandRunner,
  getAppMetadataPath,
  readAppMetadata
} from '../src/index.js';
import { runCli } from '../src/cli.js';

describe('Group & Metadata & Inspect & Failures Features', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-group-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'which' || cmd === 'where') {
        return { code: 0, stdout: process.execPath + '\n', stderr: '' };
      }
      if (cmd === 'systemctl' && args.includes('show')) {
        const unitName = args[args.length - 1];
        if (unitName.includes('failed')) {
          return {
            code: 0,
            stdout: 'ActiveState=failed\nSubState=failed\nMainPID=0\nNRestarts=3\nExecMainStatus=1\nActiveEnterTimestamp=2026-07-26 10:00:00 UTC\nUnitFileState=enabled\n',
            stderr: ''
          };
        }
        return {
          code: 0,
          stdout: 'ActiveState=active\nSubState=running\nMainPID=12345\nNRestarts=0\nActiveEnterTimestamp=2026-07-26 10:00:00 UTC\nUnitFileState=enabled\n',
          stderr: ''
        };
      }
      if (cmd === 'journalctl') {
        return { code: 0, stdout: 'Sample log line', stderr: '' };
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

  test('saves app metadata in ~/.config/unitup/apps/<name>.json', async () => {
    const dummyScript = path.join(tmpDir, 'server.js');
    fs.writeFileSync(dummyScript, 'console.log("api");');

    await addService({
      name: 'api',
      group: 'myproject',
      script: dummyScript
    });

    const metaPath = getAppMetadataPath('api');
    assert.ok(fs.existsSync(metaPath), 'Metadata JSON file should exist');

    const meta = readAppMetadata('api');
    assert.equal(meta.name, 'api');
    assert.equal(meta.unit, 'unitup-api.service');
    assert.equal(meta.group, 'myproject');
    assert.equal(meta.script, dummyScript);
    assert.equal(meta.node, process.execPath);
  });

  test('listServices includes group, pid, uptime, restarts and filters by group', async () => {
    const script1 = path.join(tmpDir, 's1.js');
    const script2 = path.join(tmpDir, 's2.js');
    fs.writeFileSync(script1, '');
    fs.writeFileSync(script2, '');

    await addService({ name: 'web', group: 'frontend', script: script1 });
    await addService({ name: 'api', group: 'backend', script: script2 });

    const all = await listServices();
    assert.equal(all.length, 2);

    const frontendOnly = await listServices({ group: 'frontend' });
    assert.equal(frontendOnly.length, 1);
    assert.equal(frontendOnly[0].name, 'web');
    assert.equal(frontendOnly[0].group, 'frontend');

    const backendOnly = await listServices({ group: 'backend' });
    assert.equal(backendOnly.length, 1);
    assert.equal(backendOnly[0].name, 'api');
  });

  test('batch commands with @group target', async () => {
    const script1 = path.join(tmpDir, 'svc1.js');
    const script2 = path.join(tmpDir, 'svc2.js');
    fs.writeFileSync(script1, '');
    fs.writeFileSync(script2, '');

    await addService({ name: 'worker1', group: 'workers', script: script1 });
    await addService({ name: 'worker2', group: 'workers', script: script2 });

    const startRes = await startService('@workers');
    assert.equal(startRes, true);

    const stopRes = await stopService('@workers');
    assert.equal(stopRes, true);

    const restartRes = await restartService('@workers');
    assert.equal(restartRes, true);
  });

  test('inspectService returns detailed app overview without environment secrets', async () => {
    const script = path.join(tmpDir, 'secret_app.js');
    fs.writeFileSync(script, 'console.log(1);');

    await addService({
      name: 'auth',
      group: 'security',
      script,
      env: { SECRET_KEY: 'super-secret-pass' }
    });

    const info = await inspectService('auth');
    assert.equal(info.name, 'auth');
    assert.equal(info.group, 'security');
    assert.equal(info.script, script);
    assert.equal(info.node, process.execPath);
    assert.equal(info.unit, 'unitup-auth.service');
    assert.equal(info.status, 'running');

    // Verify secrets are NOT present on inspect object keys
    assert.equal(info.SECRET_KEY, undefined);
    assert.equal(info.env, undefined);
  });

  test('getServiceFailures lists failed services with exit code', async () => {
    const script = path.join(tmpDir, 'failing.js');
    fs.writeFileSync(script, '');

    await addService({ name: 'failed-job', group: 'jobs', script });

    const failures = await getServiceFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].name, 'failed-job');
    assert.equal(failures[0].status, 'failed');
    assert.equal(failures[0].exitCode, '1');
    assert.equal(failures[0].restarts, '3');
  });

  test('CLI integration for ls, inspect, failures and @group commands', async () => {
    const script = path.join(tmpDir, 'cli_app.js');
    fs.writeFileSync(script, 'console.log("cli");');

    // capture console logs
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli(['add', script, '--name', 'my-cli-app', '--group', 'my-group']);
      await runCli(['ls']);
      await runCli(['list', '--group', 'my-group']);
      await runCli(['inspect', 'my-cli-app']);
      await runCli(['failures']);
      await runCli(['start', '@my-group']);
      await runCli(['stop', '@my-group']);
      await runCli(['restart', '@my-group']);
      await runCli(['remove', '@my-group', '--force']);
    } finally {
      console.log = origLog;
    }

    assert.ok(logs.some(line => line.includes('my-cli-app')));
    assert.ok(logs.some(line => line.includes('my-group')));
  });
});
