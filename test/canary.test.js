import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test, { describe, beforeEach, afterEach } from 'node:test';
import { Router } from '../src/core/router.js';
import { GenerationManager } from '../src/core/generation-manager.js';
import { DeploymentManager, DeploymentState } from '../src/deploy/deployment-manager.js';
import { RollbackManager } from '../src/deploy/rollback-manager.js';
import { ProcessManager } from '../src/core/process-manager.js';
import { ReadinessChecker } from '../src/core/readiness.js';
import { DrainManager } from '../src/core/drain-manager.js';
import { DeploymentLock } from '../src/core/lock.js';
import { IPCServer, IPCClient } from '../src/core/ipc.js';
import { Supervisor } from '../src/core/supervisor.js';
import { parseArgs, runCli } from '../src/cli.js';
import { defaultManager } from '../src/service/manager.js';

describe('Canary & Weighted Routing Suite', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-canary-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Core Router Canary & Weighted Primitives
  describe('Router Canary Primitives', () => {
    test('normalizes weight values across decimals, percentages, and clamp bounds', () => {
      const router = new Router();
      const gen1 = { id: 1, internalPort: 8001 };
      const gen2 = { id: 2, internalPort: 8002 };

      // Decimal 0.15
      router.setCanary('svc', gen2, 0.15);
      assert.strictEqual(router.getCanary('svc')?.weight, 0.15);

      // Percentage string "25%"
      router.setCanary('svc', gen2, '25%');
      assert.strictEqual(router.getCanary('svc')?.weight, 0.25);

      // Number > 1 treated as percentage: 50 -> 0.5
      router.setCanary('svc', gen2, 50);
      assert.strictEqual(router.getCanary('svc')?.weight, 0.5);

      // Over 100% clamped to 1.0
      router.setCanary('svc', gen2, 120);
      assert.strictEqual(router.getCanary('svc')?.weight, 1.0);

      // Negative clamped to 0.0
      router.setCanary('svc', gen2, -0.1);
      assert.strictEqual(router.getCanary('svc')?.weight, 0.0);

      // Default fallback
      router.setCanary('svc', gen2, 'invalid');
      assert.strictEqual(router.getCanary('svc')?.weight, 0.1);

      // Clear canary
      router.clearCanary('svc');
      assert.strictEqual(router.getCanary('svc'), null);
    });

    test('promoteCanary switches primary backend to canary and clears canary state', () => {
      const router = new Router();
      const gen1 = { id: 1, internalPort: 8001 };
      const gen2 = { id: 2, internalPort: 8002 };

      router.switchBackend('svc', gen1);
      router.setCanary('svc', gen2, 0.2);

      assert.strictEqual(router.getActiveBackend('svc')?.id, 1);
      assert.strictEqual(router.getCanary('svc')?.generation.id, 2);

      const promoted = router.promoteCanary('svc');
      assert.strictEqual(promoted?.id, 2);
      assert.strictEqual(router.getActiveBackend('svc')?.id, 2);
      assert.strictEqual(router.getCanary('svc'), null);

      // Calling promote when no canary returns null
      assert.strictEqual(router.promoteCanary('svc'), null);
    });

    test('resolveBackend obeys x-canary header overrides deterministically', () => {
      const router = new Router();
      const primary = { id: 1, internalPort: 8001 };
      const canary = { id: 2, internalPort: 8002 };

      router.switchBackend('svc', primary);
      router.setCanary('svc', canary, 0.0); // 0% probabilistic

      // Explicit canary headers
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': 'true' } })?.id, 2);
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': '1' } })?.id, 2);
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': 'always' } })?.id, 2);

      router.setCanary('svc', canary, 1.0); // 100% probabilistic
      // Explicit primary bypass headers
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': 'false' } })?.id, 1);
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': '0' } })?.id, 1);
      assert.strictEqual(router.resolveBackend('svc', { headers: { 'x-canary': 'never' } })?.id, 1);
    });

    test('resolveBackend statistically splits traffic based on weight', () => {
      const router = new Router();
      const primary = { id: 1, internalPort: 8001 };
      const canary = { id: 2, internalPort: 8002 };

      router.switchBackend('svc', primary);
      router.setCanary('svc', canary, 0.3); // 30% weight

      const trials = 1000;
      let canaryCount = 0;
      for (let i = 0; i < trials; i++) {
        const target = router.resolveBackend('svc');
        if (target?.id === 2) canaryCount++;
      }

      // At 30% with 1000 trials, count should reasonably fall within 200 - 400 (3 sigma ~ 43)
      assert.ok(
        canaryCount >= 200 && canaryCount <= 400,
        `Expected canary count around 300, received: ${canaryCount}`
      );
    });
  });

  // 2. Real HTTP Traffic Verification with Canary
  describe('Router Live HTTP Canary Routing', () => {
    let primaryServer;
    let canaryServer;
    let primaryPort;
    let canaryPort;
    let router;
    let publicPort;

    beforeEach(async () => {
      // Start mock primary server
      primaryServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backend: 'primary', version: 'v1' }));
      });
      await new Promise((resolve) => primaryServer.listen(0, '127.0.0.1', resolve));
      primaryPort = primaryServer.address().port;

      // Start mock canary server
      canaryServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backend: 'canary', version: 'v2' }));
      });
      await new Promise((resolve) => canaryServer.listen(0, '127.0.0.1', resolve));
      canaryPort = canaryServer.address().port;

      // Start router on free port (0)
      router = new Router();
      const listenRes = await router.listen(0, '127.0.0.1');
      publicPort = listenRes.port;
    });

    afterEach(async () => {
      if (router) await router.close();
      if (primaryServer) await new Promise((res) => primaryServer.close(res));
      if (canaryServer) await new Promise((res) => canaryServer.close(res));
    });

    function request(headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: publicPort,
            path: '/',
            method: 'GET',
            headers
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
          }
        );
        req.on('error', reject);
        req.end();
      });
    }

    test('routes to canary with x-canary: true and primary with x-canary: false', async () => {
      router.switchBackend('api', { id: 1, internalPort: primaryPort, service: 'api' });
      router.setCanary('api', { id: 2, internalPort: canaryPort, service: 'api' }, 0.5);

      const canaryRes = await request({ 'x-canary': 'true' });
      assert.strictEqual(canaryRes.body.backend, 'canary');
      assert.strictEqual(canaryRes.body.version, 'v2');

      const primaryRes = await request({ 'x-canary': 'false' });
      assert.strictEqual(primaryRes.body.backend, 'primary');
      assert.strictEqual(primaryRes.body.version, 'v1');
    });
  });

  // 3. GenerationManager Canary State Tracking
  describe('GenerationManager Canary Tracking', () => {
    test('markCanary persists canary status and weight, cleared upon markActive', () => {
      const stateDir = path.join(tmpDir, 'state');
      const gm = new GenerationManager({ stateDir });

      const gen1 = { id: 1, service: 'web', pid: 101, internalPort: 9001 };
      const gen2 = { id: 2, service: 'web', pid: 102, internalPort: 9002 };

      gm.markActive(gen1);
      assert.strictEqual(gm.getActive('web')?.id, 1);
      assert.strictEqual(gm.getCanary('web'), null);

      gm.markCanary(gen2, 0.2);
      const canary = gm.getCanary('web');
      assert.strictEqual(canary?.id, 2);
      assert.strictEqual(canary?.status, 'canary');
      assert.strictEqual(canary?.canaryWeight, 0.2);

      // Reload from disk into fresh GM to verify persistence
      const freshGm = new GenerationManager({ stateDir });
      assert.strictEqual(freshGm.getActive('web')?.id, 1);
      assert.strictEqual(freshGm.getCanary('web')?.id, 2);
      assert.strictEqual(freshGm.getCanary('web')?.canaryWeight, 0.2);

      // Promoting gen2 to active clears canary
      freshGm.markActive(gen2);
      assert.strictEqual(freshGm.getActive('web')?.id, 2);
      assert.strictEqual(freshGm.getCanary('web'), null);
    });
  });

  // 4. DeploymentManager Canary & Promote Workflow
  describe('DeploymentManager Canary & Promote', () => {
    let mockProcesses;
    let processManager;
    let router;
    let generationManager;
    let readiness;
    let drainManager;
    let lock;
    let deploymentManager;

    beforeEach(() => {
      mockProcesses = new Map();
      let pidCounter = 2000;

      processManager = {
        start: (cmd, args, opts) => {
          const pid = ++pidCounter;
          mockProcesses.set(pid, { alive: true });
          return { pid, child: {}, exitPromise: new Promise(() => {}) };
        },
        stop: async (pid) => {
          mockProcesses.delete(pid);
          return true;
        },
        isAlive: (pid) => mockProcesses.has(pid)
      };

      router = new Router();
      generationManager = new GenerationManager({
        processManager,
        stateDir: path.join(tmpDir, 'state')
      });
      readiness = {
        wait: async () => true,
        ensure: async () => true
      };
      drainManager = {
        drain: async () => ({ drained: true, inFlightRemaining: 0, timedOut: false })
      };
      lock = new DeploymentLock({ lockDir: path.join(tmpDir, 'lock') });

      deploymentManager = new DeploymentManager({
        processManager,
        router,
        generationManager,
        readiness,
        drainManager,
        lock,
        defaultStabilizationMs: 0
      });
    });

    afterEach(async () => {
      if (router) await router.close();
    });

    test('deploy with --canary establishes canary without stopping active generation', async () => {
      const config = { command: 'node', script: 'server.js', port: 0 };

      // 1. Initial full deploy (Gen 1)
      const initial = await deploymentManager.deploy('my-app', config);
      assert.strictEqual(initial.status, 'complete');
      assert.strictEqual(initial.currentGeneration, 1);
      assert.strictEqual(generationManager.getActive('my-app')?.id, 1);

      // 2. Canary deploy (Gen 2 with 20% traffic)
      const states = [];
      const canaryResult = await deploymentManager.deploy('my-app', config, {
        canary: true,
        weight: '20%',
        onProgress: (evt) => states.push(evt.state)
      });

      assert.strictEqual(canaryResult.status, 'canary');
      assert.strictEqual(canaryResult.canaryGeneration, 2);
      assert.strictEqual(canaryResult.activeGeneration, 1);
      assert.strictEqual(canaryResult.canaryWeight, 0.2);

      // Both Gen 1 and Gen 2 must remain alive
      assert.strictEqual(generationManager.getActive('my-app')?.id, 1);
      assert.strictEqual(generationManager.getCanary('my-app')?.id, 2);
      assert.strictEqual(router.getActiveBackend('my-app')?.id, 1);
      assert.strictEqual(router.getCanary('my-app')?.generation.id, 2);
      assert.strictEqual(router.getCanary('my-app')?.weight, 0.2);

      // Verify progress emitted SETTING_CANARY
      assert.ok(states.includes(DeploymentState.SETTING_CANARY));
      // DRAINING and STOPPING_PREVIOUS should NOT have occurred
      assert.ok(!states.includes(DeploymentState.DRAINING));
      assert.ok(!states.includes(DeploymentState.STOPPING_PREVIOUS));
    });

    test('promote transitions canary to 100% active and drains previous generation', async () => {
      const config = { command: 'node', script: 'server.js', port: 0 };

      await deploymentManager.deploy('my-app', config);
      await deploymentManager.deploy('my-app', config, { canary: true, weight: 0.1 });

      assert.strictEqual(generationManager.getCanary('my-app')?.id, 2);

      const states = [];
      const promoteResult = await deploymentManager.promote('my-app', config, {
        onProgress: (evt) => states.push(evt.state)
      });

      assert.strictEqual(promoteResult.status, 'promoted');
      assert.strictEqual(promoteResult.promotedGeneration, 2);
      assert.strictEqual(promoteResult.previousGeneration, 1);

      // Gen 2 is now active, canary is cleared
      assert.strictEqual(generationManager.getActive('my-app')?.id, 2);
      assert.strictEqual(generationManager.getCanary('my-app'), null);
      assert.strictEqual(router.getActiveBackend('my-app')?.id, 2);
      assert.strictEqual(router.getCanary('my-app'), null);

      // Gen 1 has been stopped
      assert.strictEqual(generationManager.getGeneration('my-app', 1)?.status, 'stopped');

      // Verify states
      assert.ok(states.includes(DeploymentState.PROMOTING));
      assert.ok(states.includes(DeploymentState.DRAINING));
      assert.ok(states.includes(DeploymentState.STOPPING_PREVIOUS));
      assert.ok(states.includes(DeploymentState.COMPLETE));
    });

    test('promote throws helpful error if no canary exists', async () => {
      const config = { command: 'node', script: 'server.js', port: 0 };
      await deploymentManager.deploy('my-app', config);

      await assert.rejects(
        () => deploymentManager.promote('my-app', config),
        /No canary generation found for service "my-app" to promote/
      );
    });
  });

  // 5. RollbackManager Canary Abort
  describe('RollbackManager Canary Abort', () => {
    test('rollback safely aborts canary and preserves active generation intact', async () => {
      const mockProcesses = new Map();
      let pidCounter = 3000;

      const processManager = {
        start: () => {
          const pid = ++pidCounter;
          mockProcesses.set(pid, { alive: true });
          return { pid, child: {}, exitPromise: new Promise(() => {}) };
        },
        stop: async (pid) => {
          mockProcesses.delete(pid);
          return true;
        },
        isAlive: (pid) => mockProcesses.has(pid)
      };

      const router = new Router();
      const generationManager = new GenerationManager({
        processManager,
        stateDir: path.join(tmpDir, 'state')
      });
      const readiness = { wait: async () => true, ensure: async () => true };
      const drainManager = {
        drain: async (gen, opts) => {
          if (opts.stopProcess && gen.pid) processManager.stop(gen.pid);
          return { drained: true, inFlightRemaining: 0, timedOut: false };
        }
      };
      const lock = new DeploymentLock({ lockDir: path.join(tmpDir, 'lock') });

      const deploymentManager = new DeploymentManager({
        processManager,
        router,
        generationManager,
        readiness,
        drainManager,
        lock,
        defaultStabilizationMs: 0
      });

      const rollbackManager = new RollbackManager({
        processManager,
        router,
        generationManager,
        readiness,
        drainManager,
        lock
      });

      const config = { command: 'node', script: 'server.js', port: 0 };

      try {
        // Deploy Gen 1 (Active)
        await deploymentManager.deploy('my-service', config);
        const gen1Pid = generationManager.getActive('my-service').pid;

        // Deploy Gen 2 (Canary)
        await deploymentManager.deploy('my-service', config, { canary: true, weight: 0.1 });
        const gen2Pid = generationManager.getCanary('my-service').pid;

        assert.strictEqual(router.getCanary('my-service')?.generation.id, 2);

        // Now issue rollback: since canary is running, it must abort canary Gen 2!
        const rollbackResult = await rollbackManager.rollback('my-service', config);

        assert.strictEqual(rollbackResult.status, 'canary_aborted');
        assert.strictEqual(rollbackResult.abortedCanary, 2);
        assert.strictEqual(rollbackResult.activeGeneration, 1);

        // Router canary cleared
        assert.strictEqual(router.getCanary('my-service'), null);
        assert.strictEqual(router.getActiveBackend('my-service')?.id, 1);

        // GenerationManager canary cleared
        assert.strictEqual(generationManager.getCanary('my-service'), null);
        assert.strictEqual(generationManager.getActive('my-service')?.id, 1);

        // Gen 2 process stopped, Gen 1 process still alive!
        assert.strictEqual(processManager.isAlive(gen2Pid), false);
        assert.strictEqual(processManager.isAlive(gen1Pid), true);
      } finally {
        await router.close();
      }
    });
  });

  // 6. CLI Integration for Canary & Promote
  describe('CLI Canary & Promote Commands', () => {
    test('parseArgs parses --canary and --weight flags for deploy and promote command', () => {
      const deployParsed = parseArgs(['deploy', 'api', '--canary', '--weight', '15%']);
      assert.strictEqual(deployParsed.command, 'deploy');
      assert.strictEqual(deployParsed.positionals[0], 'api');
      assert.strictEqual(deployParsed.flags.canary, true);
      assert.strictEqual(deployParsed.flags.weight, '15%');

      const promoteParsed = parseArgs(['promote', 'api']);
      assert.strictEqual(promoteParsed.command, 'promote');
      assert.strictEqual(promoteParsed.positionals[0], 'api');
    });

    test('unitup status displays canary generation and weight when present', async () => {
      const origXdg = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = tmpDir;

      const origStatus = defaultManager.status;
      defaultManager.status = async (name) => ({
        name,
        status: 'running',
        pid: 4000
      });

      const gm = new GenerationManager({ stateDir: path.join(tmpDir, 'unitup', 'state') });
      const now = Date.now();
      gm.saveState('web-app', {
        service: 'web-app',
        activeGeneration: 1,
        canaryGeneration: 2,
        generations: {
          '1': {
            id: 1,
            service: 'web-app',
            pid: 4001,
            internalPort: 42001,
            status: 'active',
            createdAt: new Date(now - 60000).toISOString(),
            activatedAt: new Date(now - 60000).toISOString()
          },
          '2': {
            id: 2,
            service: 'web-app',
            pid: 4002,
            internalPort: 42002,
            status: 'canary',
            canaryWeight: 0.1,
            createdAt: new Date(now - 10000).toISOString()
          }
        }
      });

      const logs = [];
      const origLog = console.log;
      console.log = (...args) => logs.push(args.join(' '));

      try {
        await runCli(['status', 'web-app']);
        const combined = logs.join('\n');
        assert.ok(
          combined.includes('Canary: #2 (10% traffic) -> :42002'),
          `Expected canary line in status output, got:\n${combined}`
        );
      } finally {
        console.log = origLog;
        defaultManager.status = origStatus;
        if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
        else delete process.env.XDG_CONFIG_HOME;
      }
    });
  });

  // 7. Supervisor IPC Handling for Canary & Promote
  describe('Supervisor IPC Canary & Promote', () => {
    test('supervisor handles promote action and returns status with canary info', async () => {
      const ipcDir = path.join(tmpDir, 'ipc');
      const serviceName = 'svc-canary-ipc';

      let promoted = false;
      const mockDeploymentManager = {
        promote: async (svc, cfg, opts) => {
          promoted = true;
          return { service: svc, status: 'promoted', promotedGeneration: 2, previousGeneration: 1 };
        }
      };

      const mockGenerationManager = {
        getActive: () => ({ id: 1, internalPort: 9001 }),
        getCanary: () => ({ id: 2, internalPort: 9002, canaryWeight: 0.2 }),
        getPrevious: () => null,
        listGenerations: () => []
      };

      const mockRouter = {
        listeningPort: 8080,
        getCanary: () => ({ generation: { id: 2 }, weight: 0.2 }),
        getInFlightCount: () => 0
      };

      const supervisor = new Supervisor(serviceName, {}, { ipcDir });
      supervisor.deploymentManager = mockDeploymentManager;
      supervisor.generationManager = mockGenerationManager;
      supervisor.router = mockRouter;

      const server = new IPCServer({
        serviceName,
        handler: (msg) => supervisor._handleIpcMessage(msg),
        ipcDir
      });
      await server.start();

      const client = new IPCClient(serviceName, ipcDir);

      try {
        const statusRes = await client.send({ action: 'status' });
        assert.strictEqual(statusRes.canaryGeneration?.id, 2);
        assert.strictEqual(statusRes.canaryWeight, 0.2);

        const promoteRes = await client.send({ action: 'promote' });
        assert.strictEqual(promoteRes.status, 'promoted');
        assert.strictEqual(promoteRes.promotedGeneration, 2);
        assert.strictEqual(promoted, true);
      } finally {
        await server.stop();
      }
    });
  });
});
