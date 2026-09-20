import assert from 'node:assert';
import test, { describe } from 'node:test';
import { DrainManager } from '../src/core/drain-manager.js';
import { ProcessManager } from '../src/core/process-manager.js';
import { Router } from '../src/core/router.js';

describe('DrainManager Architecture Boundary Suite', () => {
  test('drains immediately when there are zero in-flight requests', async () => {
    const pm = new ProcessManager();
    const router = new Router();
    const dm = new DrainManager({ router, processManager: pm });

    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const gen = { id: 1, pid: proc.pid, internalPort: 12345 };

    const result = await dm.drain(gen, { timeout: 1000, stopProcess: true });
    assert.strictEqual(result.drained, true);
    assert.strictEqual(result.inFlightRemaining, 0);
    assert.strictEqual(result.timedOut, false);
    assert.strictEqual(pm.isAlive(proc.pid), false);
  });

  test('waits for in-flight requests to drop before stopping process', async () => {
    const pm = new ProcessManager();
    const router = new Router();
    const dm = new DrainManager({ router, processManager: pm });

    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const gen = { id: 2, pid: proc.pid, internalPort: 12346 };

    // Simulate in-flight requests
    router._incrementInFlight(2);
    assert.strictEqual(router.getInFlightCount(2), 1);

    // Decrement in-flight count after 100ms
    setTimeout(() => {
      router._decrementInFlight(2);
    }, 100);

    const start = Date.now();
    const result = await dm.drain(gen, { timeout: 2000, stopProcess: true });
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 90, `Should wait for in-flight requests (elapsed: ${elapsed}ms)`);
    assert.strictEqual(result.drained, true);
    assert.strictEqual(pm.isAlive(proc.pid), false);
  });

  test('terminates process after timeout if requests remain in-flight', async () => {
    const pm = new ProcessManager();
    const router = new Router();
    const dm = new DrainManager({ router, processManager: pm });

    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const gen = { id: 3, pid: proc.pid, internalPort: 12347 };

    // Never decremented in-flight request
    router._incrementInFlight(3);

    const result = await dm.drain(gen, { timeout: 200, pollInterval: 20, stopProcess: true });
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(result.inFlightRemaining, 1);
    assert.strictEqual(pm.isAlive(proc.pid), false);
  });
});
