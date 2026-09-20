import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { DrainManager } from '../src/core/drain-manager.js';
import { GenerationManager, findFreePort } from '../src/core/generation-manager.js';
import { DeploymentLock, DeploymentLockError } from '../src/core/lock.js';
import { ProcessManager } from '../src/core/process-manager.js';
import { ReadinessChecker } from '../src/core/readiness.js';
import { Router } from '../src/core/router.js';
import { DeploymentManager, DeploymentState } from '../src/deploy/deployment-manager.js';

describe('DeploymentManager Orchestration Suite', () => {
  test('executes state machine in exact expected sequence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-dm-seq-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const deployer = new DeploymentManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock,
      defaultStabilizationMs: 50
    });

    const recordedStates = [];
    const onProgress = (evt) => {
      recordedStates.push(evt.state);
    };

    // Helper app that starts an HTTP server on internal PORT
    const appScript = `
      const http = require('http');
      const port = process.env.PORT;
      const srv = http.createServer((req, res) => res.end('v1'));
      srv.listen(port, '127.0.0.1');
    `;

    const publicPort = await findFreePort();

    const res = await deployer.deploy(
      'api',
      {
        command: process.execPath,
        args: ['-e', appScript]
      },
      {
        publicPort,
        stabilizationWindowMs: 50,
        readinessTimeout: 3000,
        onProgress
      }
    );

    assert.strictEqual(res.service, 'api');
    assert.strictEqual(res.currentGeneration, 1);
    assert.strictEqual(res.previousGeneration, null);
    assert.strictEqual(res.status, 'complete');

    // Verify state progression
    const expectedPrefix = [
      DeploymentState.IDLE,
      DeploymentState.CREATING_GENERATION,
      DeploymentState.STARTING,
      DeploymentState.WAITING_READY,
      DeploymentState.SWITCHING,
      DeploymentState.STABILIZING,
      DeploymentState.COMPLETE
    ];

    assert.deepStrictEqual(recordedStates, expectedPrefix);

    // Clean up
    await router.close();
    const activeGen = gm.getActive('api');
    if (activeGen) {
      await pm.stop(activeGen.pid, { timeout: 500 });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('failure during readiness preserves previous active generation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-dm-fail-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const deployer = new DeploymentManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock,
      defaultStabilizationMs: 50
    });

    const publicPort = await findFreePort();

    // 1. Deploy successful v1
    const v1Script = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('v1'));
      srv.listen(process.env.PORT, '127.0.0.1');
    `;
    await deployer.deploy(
      'api',
      { command: process.execPath, args: ['-e', v1Script] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    const v1Gen = gm.getActive('api');
    assert.strictEqual(v1Gen.id, 1);
    assert.strictEqual(router.getActiveBackend('api')?.id, 1);

    // 2. Deploy failing v2 (exits immediately)
    const v2FailingScript = `process.exit(1);`;

    await assert.rejects(
      () =>
        deployer.deploy(
          'api',
          { command: process.execPath, args: ['-e', v2FailingScript] },
          { publicPort, stabilizationWindowMs: 50, readinessTimeout: 1000 }
        )
    );

    // Verify v1 is still active and router still points to v1!
    const activeAfterFail = gm.getActive('api');
    assert.strictEqual(activeAfterFail.id, 1);
    assert.strictEqual(router.getActiveBackend('api')?.id, 1);
    assert.strictEqual(pm.isAlive(v1Gen.pid), true);

    // Clean up
    await router.close();
    await pm.stop(v1Gen.pid, { timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('automatic rollback if new generation crashes during stabilization window', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-dm-stab-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const deployer = new DeploymentManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock,
      defaultStabilizationMs: 200
    });

    const publicPort = await findFreePort();

    // 1. Deploy v1
    const v1Script = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('v1'));
      srv.listen(process.env.PORT, '127.0.0.1');
    `;
    await deployer.deploy(
      'api',
      { command: process.execPath, args: ['-e', v1Script] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    const v1Gen = gm.getActive('api');
    assert.strictEqual(v1Gen.id, 1);

    // 2. Deploy v2 that becomes ready, but crashes 100ms later (within 300ms stabilization window)
    const v2CrashingScript = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('v2'));
      srv.listen(process.env.PORT, '127.0.0.1', () => {
        setTimeout(() => process.exit(1), 100);
      });
    `;

    await assert.rejects(
      () =>
        deployer.deploy(
          'api',
          { command: process.execPath, args: ['-e', v2CrashingScript] },
          { publicPort, stabilizationWindowMs: 300, readinessTimeout: 2000 }
        ),
      /crashed during stabilization window/
    );

    // Must revert traffic back to v1!
    assert.strictEqual(router.getActiveBackend('api')?.id, 1);
    assert.strictEqual(gm.getActive('api')?.id, 1);
    assert.strictEqual(pm.isAlive(v1Gen.pid), true);

    await router.close();
    await pm.stop(v1Gen.pid, { timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('prevents concurrent deployment on the same service', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-dm-conc-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });
    const router = new Router();
    const readiness = new ReadinessChecker({ processManager: pm });
    const dm = new DrainManager({ router, processManager: pm });
    const lock = new DeploymentLock({ lockDir: tmpDir, processManager: pm });

    const deployer = new DeploymentManager({
      generationManager: gm,
      router,
      readiness,
      drainManager: dm,
      processManager: pm,
      lock,
      defaultStabilizationMs: 200
    });

    const publicPort = await findFreePort();
    const appScript = `
      const http = require('http');
      const srv = http.createServer((req, res) => res.end('ok'));
      srv.listen(process.env.PORT, '127.0.0.1');
    `;

    // Start first deploy
    const firstDeploy = deployer.deploy(
      'api',
      { command: process.execPath, args: ['-e', appScript] },
      { publicPort, stabilizationWindowMs: 200 }
    );

    // Second deploy immediately
    const secondDeploy = deployer.deploy(
      'api',
      { command: process.execPath, args: ['-e', appScript] },
      { publicPort, stabilizationWindowMs: 200 }
    );

    // One of them must fail due to lock
    const results = await Promise.allSettled([firstDeploy, secondDeploy]);
    const rejected = results.find((r) => r.status === 'rejected');
    const fulfilled = results.find((r) => r.status === 'fulfilled');

    assert.ok(fulfilled, 'One deploy should succeed');
    assert.ok(rejected, 'Second concurrent deploy should be rejected');
    assert.ok(rejected.reason instanceof DeploymentLockError);

    await router.close();
    const active = gm.getActive('api');
    if (active) await pm.stop(active.pid, { timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
