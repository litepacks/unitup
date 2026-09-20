import assert from 'node:assert';
import http from 'node:http';
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
import { DeploymentManager } from '../src/deploy/deployment-manager.js';

describe('Zero-Downtime Continuous Traffic Integration Test', () => {
  test('serves continuous traffic with zero errors during v1 -> v2 -> v1 -> v2 deployments', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-zdt-test-'));

    // 1. Create app files v1 and v2
    const v1Path = path.join(tmpDir, 'app_v1.js');
    const v2Path = path.join(tmpDir, 'app_v2.js');

    const v1Code = `
      const http = require('http');
      const port = process.env.PORT;
      const srv = http.createServer((req, res) => {
        if (req.url === '/slow') {
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('slow-v1');
          }, 150);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v1');
      });
      srv.listen(port, '127.0.0.1');
    `;

    const v2Code = `
      const http = require('http');
      const port = process.env.PORT;
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v2');
      });
      srv.listen(port, '127.0.0.1');
    `;

    fs.writeFileSync(v1Path, v1Code, 'utf8');
    fs.writeFileSync(v2Path, v2Code, 'utf8');

    // 2. Initialize Unitup core primitives & deployment manager
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

    // 3. Initial deployment of v1
    await deployer.deploy(
      'webapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    // Metrics for continuous traffic
    const metrics = {
      total: 0,
      v1: 0,
      v2: 0,
      econnrefused: 0,
      empty: 0,
      malformed: 0,
      otherErrors: 0,
      errors: []
    };

    let trafficActive = true;

    // 4. Start continuous traffic loop
    const sendRequest = () =>
      new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${publicPort}/`, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            metrics.total++;
            if (!data) {
              metrics.empty++;
            } else if (data === 'v1') {
              metrics.v1++;
            } else if (data === 'v2') {
              metrics.v2++;
            } else {
              metrics.malformed++;
            }
            resolve();
          });
        });

        req.on('error', (err) => {
          metrics.total++;
          if (err.code === 'ECONNREFUSED') {
            metrics.econnrefused++;
          } else {
            metrics.otherErrors++;
          }
          metrics.errors.push(err.message);
          resolve();
        });
      });

    // Run continuous requests concurrently
    const trafficLoopPromise = (async () => {
      while (trafficActive) {
        await Promise.all([
          sendRequest(),
          sendRequest(),
          sendRequest()
        ]);
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    // 5. Test slow request in flight during deploy
    let slowResponseData = '';
    const slowRequestPromise = new Promise((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${publicPort}/slow`, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            slowResponseData = body;
            resolve();
          });
        })
        .on('error', reject);
    });

    // Short wait to ensure slow request reached v1 backend
    await new Promise((r) => setTimeout(r, 20));

    // 6. Perform sequential deployments: v1 -> v2 -> v1 -> v2
    // v1 -> v2
    await deployer.deploy(
      'webapp',
      { command: process.execPath, args: [v2Path] },
      { publicPort, stabilizationWindowMs: 50, drainTimeout: 2000 }
    );

    // Wait for the slow request started on previous generation to complete
    await slowRequestPromise;
    assert.strictEqual(slowResponseData, 'slow-v1', 'slow request started on v1 must complete successfully');

    // v2 -> v1
    await deployer.deploy(
      'webapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50, drainTimeout: 2000 }
    );

    // v1 -> v2
    await deployer.deploy(
      'webapp',
      { command: process.execPath, args: [v2Path] },
      { publicPort, stabilizationWindowMs: 50, drainTimeout: 2000 }
    );

    // Stop continuous traffic
    trafficActive = false;
    await trafficLoopPromise;

    // 7. Assert zero-downtime criteria
    assert.strictEqual(metrics.econnrefused, 0, `zero ECONNREFUSED (got ${metrics.econnrefused})`);
    assert.strictEqual(metrics.empty, 0, `zero empty responses (got ${metrics.empty})`);
    assert.strictEqual(metrics.malformed, 0, `zero malformed responses (got ${metrics.malformed})`);
    assert.strictEqual(metrics.otherErrors, 0, `zero connection errors (errors: ${metrics.errors.join(', ')})`);
    assert.ok(metrics.total > 50, `total requests served should be > 50 (got ${metrics.total})`);
    assert.ok(metrics.v1 > 0, `should have served v1 responses (got ${metrics.v1})`);
    assert.ok(metrics.v2 > 0, `should have served v2 responses (got ${metrics.v2})`);

    // Clean up
    await router.close();
    for (const gen of gm.listGenerations('webapp')) {
      if (gen.pid) {
        await pm.stop(gen.pid, { timeout: 500 });
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
