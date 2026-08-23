import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { parseArgs, runCli } from '../src/cli.js';
import { getDoctorInfo, runDoctor } from '../src/doctor.js';
import {
  checkNodeDiagnostics,
  checkUserLinger,
  daemonReload,
  findNodeExecutable,
  getServiceStatus,
  getServiceStatusRaw,
  isSystemctlAvailable,
  isSystemdPID1,
  isUserSystemdAvailable,
  isUserUnitDirWritable,
  listServices,
  removeService,
  resetCommandRunner,
  restartService,
  runJournalctlLogs,
  setCommandRunner,
  startService,
  stopService
} from '../src/systemd.js';
import {
  deleteUnitFile,
  getUnitPath,
  getUserUnitDir,
  listUnitFiles,
  parseUnitContent,
  unitFileExists,
  writeUnitFile
} from '../src/unit.js';
import {
  escapeExecArg,
  formatRelativeTime,
  formatSystemdEnv,
  formatTable,
  getServiceNameFromUnit,
  getUnitFilename,
  resolveAbsolutePath,
  sanitizeServiceName
} from '../src/utils.js';

async function captureConsole(fn) {
  const origLog = console.log;
  const origErr = console.error;
  const logs = [];
  console.log = (...args) => {
    logs.push(args.join(' '));
  };
  console.error = (...args) => {
    logs.push(args.join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return logs;
}

describe('Coverage Extension Suite', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-cov-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'which' || cmd === 'where') {
        return { code: 0, stdout: process.execPath + '\n', stderr: '' };
      }
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          code: 0,
          stdout:
            'ActiveState=active\nSubState=running\nMainPID=9999\nNRestarts=0\nActiveEnterTimestamp=2026-07-26 10:00:00 UTC\nUnitFileState=enabled\n',
          stderr: ''
        };
      }
      if (cmd === 'systemctl' && args.includes('status')) {
        return { code: 0, stdout: '● unitup-test.service - Active running', stderr: '' };
      }
      if (cmd === 'journalctl') {
        return { code: 0, stdout: 'Sample log line 1\nSample log line 2', stderr: '' };
      }
      if (cmd === 'loginctl') {
        return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
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

  test('utils.js extra edge cases', () => {
    const home = os.homedir();
    assert.equal(resolveAbsolutePath('~/file.txt'), path.join(home, 'file.txt'));
    assert.equal(resolveAbsolutePath('~'), home);
    assert.equal(resolveAbsolutePath(''), '');

    const now = Date.now();
    assert.equal(formatRelativeTime(now - 10000), '10 seconds ago');
    assert.equal(formatRelativeTime(now - 120000), '2 minutes ago');
    assert.equal(formatRelativeTime(now - 60000), '1 minute ago');
    assert.equal(formatRelativeTime(now - 7200000), '2 hours ago');
    assert.equal(formatRelativeTime(now - 3600000), '1 hour ago');
    assert.equal(formatRelativeTime(now - 172800000), '2 days ago');
    assert.equal(formatRelativeTime(now - 86400000), '1 day ago');
    assert.equal(formatRelativeTime(now + 100000), 'just now');
    assert.equal(formatRelativeTime('invalid-date-str'), 'invalid-date-str');
    assert.equal(formatRelativeTime('0'), 'unknown');

    assert.equal(formatTable([], [{ key: 'a', label: 'A' }]), 'No services found.');
    assert.equal(escapeExecArg(''), '""');
  });

  test('unit.js extra edge cases', () => {
    const origConfig = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = '/custom/config';
      assert.equal(getUserUnitDir(), path.join('/custom/config', 'systemd', 'user'));
    } finally {
      process.env.XDG_CONFIG_HOME = origConfig;
    }

    assert.equal(deleteUnitFile('non-existent-xyz-unit'), false);

    try {
      process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'missing');
      assert.deepEqual(listUnitFiles(), []);
    } finally {
      process.env.XDG_CONFIG_HOME = origConfig;
    }

    assert.deepEqual(parseUnitContent(''), {});
    const res = parseUnitContent('ExecStart="node"');
    assert.equal(res.script, 'node');
  });

  test('systemd.js extra edge cases and error branches', async () => {
    setCommandRunner(async () => ({ code: 1, stdout: '', stderr: 'command failed' }));
    await assert.rejects(async () => await daemonReload(), /Failed to reload systemd daemon: command failed/);

    setCommandRunner(async () => ({ code: 1, stdout: '', stderr: '' }));
    assert.equal(await isSystemctlAvailable(), false);

    setCommandRunner(async () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }));
    assert.equal(await isUserSystemdAvailable(), false);

    const origConfig = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = '/root/non-writable-test-dir-12345';
      assert.equal(await isUserUnitDirWritable(), false);
    } finally {
      process.env.XDG_CONFIG_HOME = origConfig;
    }

    assert.equal(await findNodeExecutable('/non/existent/node/path'), null);

    const dummyNode = path.join(tmpDir, 'node');
    fs.writeFileSync(dummyNode, '#!/bin/sh\necho v20.0.0');
    fs.chmodSync(dummyNode, 0o755);
    assert.equal(await findNodeExecutable(dummyNode), dummyNode);

    setCommandRunner(async (cmd) => {
      if (cmd === 'which' || cmd === 'where') {
        return { code: 1, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: '' };
    });

    const diag = await checkNodeDiagnostics('/non/existent/custom/node/path');
    assert.equal(diag.found, false);
    assert.match(diag.error, /Node.js/);

    setCommandRunner(async (cmd) => {
      if (cmd === 'loginctl') {
        return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    assert.equal(await checkUserLinger(), true);

    const dummyScript = path.join(tmpDir, 'app.js');
    fs.writeFileSync(dummyScript, '');
    writeUnitFile({ name: 'err-test', script: dummyScript });

    setCommandRunner(async () => ({ code: 1, stdout: '', stderr: 'systemd error' }));
    await assert.rejects(async () => await startService('err-test'), /Failed to start service/);
    await assert.rejects(async () => await stopService('err-test'), /Failed to stop service/);
    await assert.rejects(async () => await restartService('err-test'), /Failed to restart service/);

    // Status states
    setCommandRunner(async () => ({
      code: 0,
      stdout: 'ActiveState=active\nSubState=exited\nMainPID=0\nNRestarts=2\nActiveEnterTimestamp=0\n'
    }));
    let status = await getServiceStatus('err-test');
    assert.equal(status.status, 'exited');
    assert.equal(status.pid, '-');

    setCommandRunner(async () => ({
      code: 0,
      stdout: 'ActiveState=failed\nSubState=failed\nMainPID=0\n'
    }));
    status = await getServiceStatus('err-test');
    assert.equal(status.status, 'failed');

    setCommandRunner(async () => ({
      code: 0,
      stdout: 'ActiveState=inactive\nSubState=dead\nMainPID=0\n'
    }));
    status = await getServiceStatus('err-test');
    assert.equal(status.status, 'stopped');

    setCommandRunner(async () => ({
      code: 0,
      stdout: 'ActiveState=activating\nSubState=start-pre\nMainPID=0\n'
    }));
    status = await getServiceStatus('err-test');
    assert.equal(status.status, 'activating');

    // listServices failure branch
    setCommandRunner(async () => {
      throw new Error('Command failed');
    });
    const list = await listServices();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'unknown');

    // runJournalctlLogs
    setCommandRunner(async () => ({ code: 0, stdout: 'Log line', stderr: '' }));
    const logs = await runJournalctlLogs('err-test', { follow: false, lines: 20, cat: true });
    assert.equal(logs, 'Log line');

    const logs2 = await runJournalctlLogs('err-test', { follow: false, output: 'short' });
    assert.equal(logs2, 'Log line');

    setCommandRunner(async (cmd, args) => {
      if (args.includes('--user')) {
        return { code: 0, stdout: 'No journal files were found.', stderr: '' };
      }
      return { code: 0, stdout: 'Fallback system log line', stderr: '' };
    });
    const fallbackLogs = await runJournalctlLogs('err-test', { follow: false });
    assert.equal(fallbackLogs, 'Fallback system log line');
  });

  test('cli.js parsing and execution coverage', async () => {
    const parseRes = parseArgs([
      '--name=my-name',
      '--cwd=/my/cwd',
      '--env=ENV1=VAL1',
      '--env',
      'ENV2',
      '--env-file=/my/env',
      '--restart=always',
      '--arg=arg1',
      '--lines=25',
      '--unknown-flag'
    ]);

    assert.equal(parseRes.flags.name, 'my-name');
    assert.equal(parseRes.flags.cwd, '/my/cwd');
    assert.deepEqual(parseRes.flags.env, ['ENV1=VAL1', 'ENV2']);
    assert.equal(parseRes.flags.envFile, '/my/env');
    assert.equal(parseRes.flags.restart, 'always');
    assert.deepEqual(parseRes.flags.args, ['arg1']);
    assert.equal(parseRes.flags.lines, 25);

    const missingCommands = ['add', 'start', 'stop', 'restart', 'status', 'logs', 'remove'];
    for (const cmd of missingCommands) {
      await captureConsole(async () => {
        process.exitCode = 0;
        await runCli([cmd]);
        assert.equal(process.exitCode, 1, `Command ${cmd} should fail when missing argument`);
        process.exitCode = 0;
      });
    }

    await captureConsole(async () => {
      process.exitCode = 0;
      await runCli(['add', '/non/existent/script.js']);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    });

    const noExtScript = path.join(tmpDir, 'worker');
    fs.writeFileSync(noExtScript, 'console.log("worker");');

    setCommandRunner(async (cmd) => {
      if (cmd === 'which' || cmd === 'where') {
        return { code: 0, stdout: process.execPath + '\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const addLogs = await captureConsole(async () => {
      await runCli(['add', noExtScript, '--env-file', noExtScript]);
    });
    assert.ok(
      addLogs.some((line) => line.includes('Service "worker" created')),
      `addLogs output: ${JSON.stringify(addLogs)}`
    );

    const nodeErrLogs = await captureConsole(async () => {
      process.exitCode = 0;
      await runCli(['add', 'app.js', '--node', '/non/existent/node']);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    });
    assert.ok(
      nodeErrLogs.some((line) => line.includes('Node.js is required but not found')),
      `nodeErrLogs output: ${JSON.stringify(nodeErrLogs)}`
    );

    const helpLogs = await captureConsole(async () => {
      await runCli(['--help']);
    });
    assert.ok(helpLogs.some((line) => line.includes('unitup - Minimal systemd user service wrapper')));

    const versionLogs = await captureConsole(async () => {
      await runCli(['--version']);
    });
    assert.ok(versionLogs.some((line) => line.includes('unitup v')));

    const doctorLogs = await captureConsole(async () => {
      await runCli(['doctor']);
    });
    assert.ok(doctorLogs.some((line) => line.includes('unitup doctor')));

    // Status formatted and raw CLI commands
    setCommandRunner(async (cmd, args) => {
      if (cmd === 'which' || cmd === 'where') {
        return { code: 0, stdout: process.execPath + '\n', stderr: '' };
      }
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          code: 0,
          stdout:
            'ActiveState=active\nSubState=running\nMainPID=1111\nNRestarts=0\nActiveEnterTimestamp=2026-07-26 10:00:00 UTC\nUnitFileState=enabled\n',
          stderr: ''
        };
      }
      if (cmd === 'systemctl' && args.includes('status')) {
        return { code: 0, stdout: '● unitup-worker.service - Active running', stderr: '' };
      }
      if (cmd === 'journalctl') {
        return { code: 0, stdout: 'Worker log 1', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await captureConsole(async () => {
      await runCli(['status', 'worker']);
      await runCli(['status', 'worker', '--raw']);
      await runCli(['logs', 'worker']);
      await runCli(['start', 'worker']);
      await runCli(['stop', 'worker']);
      await runCli(['restart', 'worker']);
      await runCli(['list']);
      await runCli(['remove', 'worker']);
    });
  });

  test('doctor.js failure formatting coverage', async () => {
    // 1. All negative checks
    setCommandRunner(async (cmd) => {
      if (cmd === 'which' || cmd === 'where') return { code: 1, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'Failed' };
    });

    const docLogs1 = await captureConsole(async () => {
      await runDoctor();
    });
    assert.ok(docLogs1.some((line) => line.includes('unitup doctor')));
    assert.ok(docLogs1.some((line) => line.includes('User lingering is')));

    // 2. Non-Linux OS check
    const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const docLogs2 = await captureConsole(async () => {
      await runDoctor();
    });
    assert.ok(docLogs2.some((line) => line.includes('Non-Linux OS detected')));

    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform);
    }
  });

  test('cli.js edge case branches coverage', async () => {
    // --env flag without value
    const parseRes = parseArgs(['--env', '']);
    assert.deepEqual(parseRes.flags.env, []);

    // --cwd flag without value
    const parseResCwd = parseArgs(['--cwd', '']);
    assert.equal(parseResCwd.flags.cwd, '');

    // --env-file flag without value
    const parseResEnvFile = parseArgs(['--env-file', '']);
    assert.equal(parseResEnvFile.flags.envFile, '');

    // add command with explicit cwd and env-file
    const dummyScript = path.join(tmpDir, 'test_script.js');
    fs.writeFileSync(dummyScript, 'console.log(1);');

    const dummyEnvFile = path.join(tmpDir, '.env');
    fs.writeFileSync(dummyEnvFile, 'A=B');

    setCommandRunner(async (cmd) => {
      if (cmd === 'which' || cmd === 'where') return { code: 0, stdout: process.execPath + '\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await captureConsole(async () => {
      await runCli(['add', dummyScript, '--cwd', tmpDir, '--env-file', dummyEnvFile, '--env', 'MY_KEY']);
    });

    // runCli error handling catch block
    await captureConsole(async () => {
      process.exitCode = 0;
      await runCli(['add']);
      assert.equal(process.exitCode, 1);
      process.exitCode = 0;
    });
  });
});
