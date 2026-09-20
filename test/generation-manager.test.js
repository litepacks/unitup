import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { GenerationManager, findFreePort } from '../src/core/generation-manager.js';
import { ProcessManager } from '../src/core/process-manager.js';

describe('GenerationManager Architecture Boundary Suite', () => {
  test('findFreePort returns an open ephemeral port', async () => {
    const port = await findFreePort();
    assert.ok(typeof port === 'number');
    assert.ok(port > 1024 && port < 65535);
  });

  test('creates a generation, tracks active and previous, and persists state', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-gm-test-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });

    const gen1 = await gm.create('api', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    });

    assert.strictEqual(gen1.id, 1);
    assert.strictEqual(gen1.service, 'api');
    assert.ok(gen1.internalPort > 0);
    assert.ok(pm.isAlive(gen1.pid));

    // Initially no active generation until marked
    assert.strictEqual(gm.getActive('api'), null);

    gm.markActive(gen1);
    assert.strictEqual(gm.getActive('api')?.id, 1);

    // State persisted to disk
    const stateFile = path.join(tmpDir, 'api.json');
    assert.ok(fs.existsSync(stateFile));
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.strictEqual(state.activeGeneration, 1);
    assert.strictEqual(state.generations['1'].status, 'active');

    // Create generation 2
    const gen2 = await gm.create('api', {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    });

    assert.strictEqual(gen2.id, 2);
    assert.notStrictEqual(gen2.internalPort, gen1.internalPort);

    // Mark gen2 active
    gm.markActive(gen2);
    assert.strictEqual(gm.getActive('api')?.id, 2);
    assert.strictEqual(gm.getPrevious('api')?.id, 1);

    // Mark gen1 draining
    gm.markDraining(gen1);
    const updatedState = gm.loadState('api');
    assert.strictEqual(updatedState.generations['1'].status, 'draining');
    assert.ok(updatedState.generations['1'].activatedAt);
    assert.ok(updatedState.generations['1'].deactivatedAt);
    assert.ok(updatedState.generations['2'].activatedAt);

    // Clean up
    await pm.stop(gen1.pid, { timeout: 500 });
    await pm.stop(gen2.pid, { timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('cleans up stale dead processes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-gm-test-'));
    const pm = new ProcessManager();
    const gm = new GenerationManager({ processManager: pm, stateDir: tmpDir });

    // Simulate state with an already dead PID
    const deadPid = 99999999;
    const mockState = {
      service: 'api',
      activeGeneration: 1,
      generations: {
        '1': { id: 1, service: 'api', pid: deadPid, internalPort: 54321, status: 'active' }
      }
    };
    gm.saveState('api', mockState);

    const cleaned = gm.cleanupStale('api');
    assert.strictEqual(cleaned, 1);

    const reloaded = gm.loadState('api');
    assert.strictEqual(reloaded.generations['1'].status, 'stopped');
    assert.strictEqual(reloaded.activeGeneration, null);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
