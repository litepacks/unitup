import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { DrainManager } from '../src/core/drain-manager.js';
import { GenerationManager, findFreePort } from '../src/core/generation-manager.js';
import { DeploymentLock } from '../src/core/lock.js';
import { ProcessManager } from '../src/core/process-manager.js';
import { ReadinessChecker } from '../src/core/readiness.js';
import { Router } from '../src/core/router.js';
import { RollbackManager } from '../src/deploy/rollback-manager.js';

describe('RollbackManager Orchestration Suite', () => {
  test('switches traffic back to previous generation and drains current', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-rb-test-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const rollbackManager = new RollbackManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock
    });

    const publicPort = await findFreePort();
    await router.listen(publicPort, '127.0.0.1');

    // Create gen1 and gen2
    const v1Script = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('v1'));
      srv.listen(process.env.PORT, '127.0.0.1');
    `;
    const v2Script = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('v2'));
      srv.listen(process.env.PORT, '127.0.0.1');
    `;

    const gen1 = await gm.create('api', { command: process.execPath, args: ['-e', v1Script] });
    await readiness.wait(gen1);
    gm.markActive(gen1);
    router.switchBackend('api', gen1);

    const gen2 = await gm.create('api', { command: process.execPath, args: ['-e', v2Script] });
    await readiness.wait(gen2);
    gm.markActive(gen2);
    router.switchBackend('api', gen2);

    assert.strictEqual(gm.getActive('api')?.id, 2);
    assert.strictEqual(gm.getPrevious('api')?.id, 1);
    assert.strictEqual(router.getActiveBackend('api')?.id, 2);

    // Perform rollback
    const recordedEvents = [];
    const res = await rollbackManager.rollback(
      'api',
      {},
      {
        onProgress: (evt) => recordedEvents.push(evt.state)
      }
    );

    assert.strictEqual(res.service, 'api');
    assert.strictEqual(res.rolledBackFrom, 2);
    assert.strictEqual(res.activeGeneration, 1);
    assert.strictEqual(res.status, 'rolled_back');

    // Verify router is pointing to gen1
    assert.strictEqual(router.getActiveBackend('api')?.id, 1);
    assert.strictEqual(gm.getActive('api')?.id, 1);

    // Verify gen2 was stopped
    assert.strictEqual(pm.isAlive(gen2.pid), false);
    // Verify gen1 is still alive
    assert.strictEqual(pm.isAlive(gen1.pid), true);

    await router.close();
    await pm.stop(gen1.pid);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('throws error if no previous generation exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-rb-empty-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const rollbackManager = new RollbackManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock
    });

    await assert.rejects(
      () => rollbackManager.rollback('api'),
      /No previous generation available/
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
