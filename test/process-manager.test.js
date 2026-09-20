import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { ProcessManager } from '../src/core/process-manager.js';

describe('ProcessManager Architecture Boundary Suite', () => {
  test('starts a child process, tracks PID, and verifies liveness', async () => {
    const pm = new ProcessManager();
    const proc = pm.start(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);

    assert.ok(proc.pid > 0, 'PID should be greater than 0');
    assert.strictEqual(pm.isAlive(proc.pid), true, 'Process should be reported alive');

    // Clean up
    await pm.stop(proc.pid, { timeout: 1000 });
    assert.strictEqual(pm.isAlive(proc.pid), false, 'Process should no longer be alive');
  });

  test('captures logs to stdout and stderr files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-pm-test-'));
    const stdoutPath = path.join(tmpDir, 'stdout.log');
    const stderrPath = path.join(tmpDir, 'stderr.log');

    const pm = new ProcessManager();
    const proc = pm.start(
      process.execPath,
      ['-e', 'console.log("hello stdout"); console.error("hello stderr");'],
      { stdoutPath, stderrPath }
    );

    await proc.exitPromise;

    const outContent = fs.readFileSync(stdoutPath, 'utf8');
    const errContent = fs.readFileSync(stderrPath, 'utf8');

    assert.match(outContent, /hello stdout/);
    assert.match(errContent, /hello stderr/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('signals a running process and handles exit', async () => {
    const pm = new ProcessManager();
    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

    assert.strictEqual(pm.isAlive(proc.pid), true);

    const signaled = pm.signal(proc.pid, 'SIGTERM');
    assert.strictEqual(signaled, true);

    const exitResult = await pm.waitForExit(proc.pid, 2000);
    assert.strictEqual(exitResult.exited, true);
    assert.strictEqual(pm.isAlive(proc.pid), false);
  });

  test('stops gracefully with SIGTERM and escalates if necessary', async () => {
    const pm = new ProcessManager({ defaultShutdownTimeout: 500 });
    // Process that ignores SIGTERM
    const proc = pm.start(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
    ]);

    assert.strictEqual(pm.isAlive(proc.pid), true);

    const stopped = await pm.stop(proc.pid, { timeout: 300 });
    assert.strictEqual(stopped, true);
    assert.strictEqual(pm.isAlive(proc.pid), false);
  });

  test('waitForExit resolves immediately for dead or unknown process', async () => {
    const pm = new ProcessManager();
    const res = await pm.waitForExit(99999999, 500);
    assert.strictEqual(res.exited, true);
  });
});
