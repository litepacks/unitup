import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { DeploymentLock, DeploymentLockError } from '../src/core/lock.js';
import { ProcessManager } from '../src/core/process-manager.js';

describe('DeploymentLock Concurrency Suite', () => {
  test('acquires and releases lock cleanly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-lock-test-'));
    const lock = new DeploymentLock({ lockDir: tmpDir });

    const acquired = await lock.acquire('api');
    assert.strictEqual(acquired, true);

    const released = await lock.release('api');
    assert.strictEqual(released, true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rejects concurrent deployment when locked by another active process', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-lock-test-'));
    const pm = new ProcessManager();
    const otherProc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

    // Write lock file owned by otherProc
    const lockPath = path.join(tmpDir, 'api.deploy.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ service: 'api', pid: otherProc.pid, timestamp: new Date().toISOString() })
    );

    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    await assert.rejects(
      () => lock.acquire('api'),
      (err) => err instanceof DeploymentLockError && err.lockedPid === otherProc.pid
    );

    await pm.stop(otherProc.pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('breaks stale lock if holding process has died', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-lock-test-'));
    const pm = new ProcessManager();

    // Dead PID
    const lockPath = path.join(tmpDir, 'api.deploy.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ service: 'api', pid: 99999999, timestamp: new Date().toISOString() })
    );

    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    // Should break stale lock and succeed
    const acquired = await lock.acquire('api');
    assert.strictEqual(acquired, true);

    await lock.release('api');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
