import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  createService,
  executeJournalctlMaintenance,
  getServiceLogs,
  resetCommandRunner,
  setCommandRunner
} from '../src/index.js';

describe('Journald & Log Maintenance Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `unitup-journal-test-${Date.now()}`);
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;

  test('setup test environment', () => {
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  test('getServiceLogs maps since, until, priority, grep, boot, json flags safely', async () => {
    const dummyScript = path.join(tmpDir, 'log-app.js');
    fs.writeFileSync(dummyScript, 'console.log("log test");');

    let capturedArgs = null;
    setCommandRunner(async (cmd, args) => {
      if (cmd === 'journalctl') {
        capturedArgs = args;
        return { stdout: 'sample log line', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await createService({
      name: 'log-app',
      script: dummyScript
    });

    const logs = await getServiceLogs('log-app', {
      since: '1h',
      until: 'now',
      priority: 'err',
      grep: 'timeout',
      boot: true,
      json: true
    });

    assert.equal(logs, 'sample log line');
    assert.ok(capturedArgs.includes('--since=1h'));
    assert.ok(capturedArgs.includes('--until=now'));
    assert.ok(capturedArgs.includes('--priority=err'));
    assert.ok(capturedArgs.includes('--grep=timeout'));
    assert.ok(capturedArgs.includes('--boot'));
    assert.ok(capturedArgs.includes('-o'));
    assert.ok(capturedArgs.includes('json'));

    resetCommandRunner();
  });

  test('executeJournalctlMaintenance supports disk-usage, rotate, vacuum --dry-run', async () => {
    let capturedArgs = null;
    setCommandRunner(async (cmd, args) => {
      capturedArgs = args;
      return { stdout: 'Archived journal files take up 12.0M', stderr: '', code: 0 };
    });

    const diskUsage = await executeJournalctlMaintenance('disk-usage');
    assert.ok(diskUsage.includes('12.0M'));
    assert.deepEqual(capturedArgs, ['--disk-usage']);

    const rotate = await executeJournalctlMaintenance('rotate');
    assert.deepEqual(capturedArgs, ['--rotate']);

    const dryRun = await executeJournalctlMaintenance('vacuum', { size: '500M', dryRun: true });
    assert.ok(dryRun.includes('[dry-run] Would execute: journalctl --vacuum-size=500M'));

    const dryRunTime = await executeJournalctlMaintenance('vacuum', { time: '14d', dryRun: true });
    assert.ok(dryRunTime.includes('[dry-run] Would execute: journalctl --vacuum-time=14d'));

    const dryRunFiles = await executeJournalctlMaintenance('vacuum', { files: '10', dryRun: true });
    assert.ok(dryRunFiles.includes('[dry-run] Would execute: journalctl --vacuum-files=10'));

    resetCommandRunner();
  });

  test('executeJournalctlMaintenance handles permission errors gracefully', async () => {
    setCommandRunner(async (cmd, args) => {
      return { stdout: '', stderr: 'Permission denied. Must be root.', code: 1 };
    });

    await assert.rejects(
      async () => {
        await executeJournalctlMaintenance('vacuum', { size: '500M' });
      },
      (err) => {
        return err.message.includes('Journal maintenance requires additional privileges on this system');
      }
    );

    resetCommandRunner();
  });

  test('teardown test environment', () => {
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
