import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
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

describe('Live Connections (WebSocket, SSE, Chunked Upload) Drain Suite', () => {
  test('WebSocket/Upgrade connection remains intact and drained gracefully during deployment', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-ws-test-'));

    // 1. Create v1 and v2 app files with HTTP and Upgrade support
    const v1Path = path.join(tmpDir, 'ws_v1.js');
    const v2Path = path.join(tmpDir, 'ws_v2.js');

    const makeAppCode = (version) => `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('${version}');
      });

      server.on('upgrade', (req, socket, head) => {
        socket.write(
          'HTTP/1.1 101 Switching Protocols\\r\\n' +
          'Upgrade: websocket\\r\\n' +
          'Connection: Upgrade\\r\\n' +
          '\\r\\n'
        );
        socket.on('data', (data) => {
          socket.write('${version}:' + data.toString());
        });
      });

      server.listen(port, '127.0.0.1');
    `;

    fs.writeFileSync(v1Path, makeAppCode('v1'), 'utf8');
    fs.writeFileSync(v2Path, makeAppCode('v2'), 'utf8');

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

    // 2. Deploy v1
    await deployer.deploy(
      'wsapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    // 3. Connect client via Upgrade on public router port
    const clientSocket1 = net.connect(publicPort, '127.0.0.1');
    await new Promise((resolve) => clientSocket1.once('connect', resolve));

    clientSocket1.write(
      'GET /ws HTTP/1.1\r\n' +
      'Host: 127.0.0.1\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n\r\n'
    );

    // Wait for 101 Switching Protocols response
    const handshakeData = await new Promise((resolve) => {
      clientSocket1.once('data', (buf) => resolve(buf.toString()));
    });
    assert.match(handshakeData, /101 Switching Protocols/);

    // In-flight count for gen 1 should be 1
    assert.strictEqual(router.getInFlightCount(1), 1);

    // Test ping-pong on v1
    const p1 = new Promise((resolve) => {
      clientSocket1.once('data', (buf) => resolve(buf.toString()));
    });
    clientSocket1.write('hello-v1');
    const reply1 = await p1;
    assert.strictEqual(reply1, 'v1:hello-v1');

    // 4. Trigger deployment to v2 while clientSocket1 is actively connected!
    let switchedToV2 = false;
    const deployPromise = deployer.deploy(
      'wsapp',
      { command: process.execPath, args: [v2Path] },
      {
        publicPort,
        drainTimeout: 4000,
        stabilizationWindowMs: 50,
        onProgress: (evt) => {
          if (evt.state === 'SWITCHING' || evt.state === 'DRAINING') {
            switchedToV2 = true;
          }
        }
      }
    );

    // Wait until router switches traffic to v2
    while (!switchedToV2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // Verify router has switched active backend to v2
    const activeGen = gm.getActive('wsapp');
    assert.strictEqual(activeGen?.id, 2);

    // New HTTP request reaches v2
    const resV2 = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${publicPort}/`, (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      });
    });
    assert.strictEqual(resV2, 'v2');

    // Crucial check: clientSocket1 on v1 is STILL ALIVE and can still transmit data!
    const p2 = new Promise((resolve) => {
      clientSocket1.once('data', (buf) => resolve(buf.toString()));
    });
    clientSocket1.write('still-connected');
    const reply2 = await p2;
    assert.strictEqual(reply2, 'v1:still-connected');

    // Now client closes the v1 upgrade connection
    clientSocket1.destroy();

    // Deployment completes and previous generation 1 drains cleanly
    await deployPromise;

    // Wait a brief tick to ensure socket close event cycle completes
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(router.getInFlightCount(1), 0);

    // Cleanup
    await router.close();
    await dm.drain(activeGen, { stopProcess: true, timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Server-Sent Events (SSE) stream remains uninterrupted during deployment', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-sse-test-'));

    const v1Path = path.join(tmpDir, 'sse_v1.js');
    const v2Path = path.join(tmpDir, 'sse_v2.js');

    const v1Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        if (req.url === '/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
          let count = 0;
          const timer = setInterval(() => {
            count++;
            res.write('data: v1-event-' + count + '\\n\\n');
          }, 40);
          req.on('close', () => clearInterval(timer));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v1');
      });
      server.listen(port, '127.0.0.1');
    `;

    const v2Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v2');
      });
      server.listen(port, '127.0.0.1');
    `;

    fs.writeFileSync(v1Path, v1Code, 'utf8');
    fs.writeFileSync(v2Path, v2Code, 'utf8');

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

    // 1. Deploy v1
    await deployer.deploy(
      'sseapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    // 2. Open SSE stream
    const eventsReceived = [];
    let sseClientReq = null;

    const sseStarted = new Promise((resolve) => {
      sseClientReq = http.get(`http://127.0.0.1:${publicPort}/events`, (res) => {
        res.on('data', (chunk) => {
          eventsReceived.push(chunk.toString());
          if (eventsReceived.length === 1) resolve();
        });
      });
    });

    await sseStarted;
    assert.strictEqual(router.getInFlightCount(1), 1);

    let sseSwitchedToV2 = false;
    const deployPromise = deployer.deploy(
      'sseapp',
      { command: process.execPath, args: [v2Path] },
      {
        publicPort,
        drainTimeout: 3000,
        stabilizationWindowMs: 50,
        onProgress: (evt) => {
          if (evt.state === 'SWITCHING' || evt.state === 'DRAINING') {
            sseSwitchedToV2 = true;
          }
        }
      }
    );

    // Wait until router switches traffic to v2
    while (!sseSwitchedToV2) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    // New requests reach v2
    const v2Content = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${publicPort}/`, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve(s));
      });
    });
    assert.strictEqual(v2Content, 'v2');

    // Existing SSE stream continued receiving messages from v1
    assert.ok(eventsReceived.length >= 2);
    assert.ok(eventsReceived.some((e) => e.includes('v1-event')));

    // 4. Close SSE stream from client side
    sseClientReq.destroy();

    await deployPromise;
    assert.strictEqual(router.getInFlightCount(1), 0);

    await router.close();
    const active = gm.getActive('sseapp');
    await dm.drain(active, { stopProcess: true, timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Chunked streaming upload completes successfully while deployment takes place', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-upload-test-'));

    const v1Path = path.join(tmpDir, 'up_v1.js');
    const v2Path = path.join(tmpDir, 'up_v2.js');

    const v1Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/upload') {
          let totalBytes = 0;
          req.on('data', (chunk) => {
            totalBytes += chunk.length;
          });
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ version: 'v1', totalBytes }));
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v1');
      });
      server.listen(port, '127.0.0.1');
    `;

    const v2Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v2');
      });
      server.listen(port, '127.0.0.1');
    `;

    fs.writeFileSync(v1Path, v1Code, 'utf8');
    fs.writeFileSync(v2Path, v2Code, 'utf8');

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

    // 1. Deploy v1
    await deployer.deploy(
      'upapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    // 2. Start slow streaming chunked POST to v1
    const totalChunks = 20;
    const chunkSize = 2048; // 2KB per chunk -> 40KB total
    const payloadChunk = Buffer.alloc(chunkSize, 'x');

    let uploadResPromise = null;
    const uploadReq = http.request({
      hostname: '127.0.0.1',
      port: publicPort,
      path: '/upload',
      method: 'POST',
      headers: {
        'Transfer-Encoding': 'chunked',
        'Content-Type': 'application/octet-stream'
      }
    });

    uploadResPromise = new Promise((resolve, reject) => {
      uploadReq.on('response', (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      });
      uploadReq.on('error', reject);
    });

    // Send first 5 chunks
    for (let i = 0; i < 5; i++) {
      uploadReq.write(payloadChunk);
    }

    // Wait a brief tick for TCP packet to be delivered and parsed by router
    await new Promise((r) => setTimeout(r, 50));

    assert.strictEqual(router.getInFlightCount(1), 1);

    // 3. Trigger deploy v2 while upload is in progress!
    const deployPromise = deployer.deploy(
      'upapp',
      { command: process.execPath, args: [v2Path] },
      { publicPort, drainTimeout: 2000, stabilizationWindowMs: 50 }
    );

    // Send remaining chunks with slight delay
    for (let i = 5; i < totalChunks; i++) {
      await new Promise((r) => setTimeout(r, 10));
      uploadReq.write(payloadChunk);
    }
    uploadReq.end();

    // Upload finishes with 200 OK and complete byte count on v1
    const uploadResult = await uploadResPromise;
    assert.strictEqual(uploadResult.version, 'v1');
    assert.strictEqual(uploadResult.totalBytes, totalChunks * chunkSize);

    // Deployment completes successfully
    await deployPromise;
    assert.strictEqual(router.getInFlightCount(1), 0);

    await router.close();
    const active = gm.getActive('upapp');
    await dm.drain(active, { stopProcess: true, timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Drain timeout forcefully stops previous generation if connections hang', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-timeout-test-'));

    const v1Path = path.join(tmpDir, 'hang_v1.js');
    const v2Path = path.join(tmpDir, 'hang_v2.js');

    // v1 hangs requests indefinitely
    const v1Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        // never responds
      });
      server.listen(port, '127.0.0.1');
    `;

    const v2Code = `
      const http = require('http');
      const port = process.env.PORT;
      const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('v2');
      });
      server.listen(port, '127.0.0.1');
    `;

    fs.writeFileSync(v1Path, v1Code, 'utf8');
    fs.writeFileSync(v2Path, v2Code, 'utf8');

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

    // 1. Deploy v1
    await deployer.deploy(
      'hangapp',
      { command: process.execPath, args: [v1Path] },
      { publicPort, stabilizationWindowMs: 50 }
    );

    const gen1 = gm.getActive('hangapp');

    // 2. Open hanging request
    const hangingReq = http.get(`http://127.0.0.1:${publicPort}/hang`);
    hangingReq.on('error', () => {}); // ignore expected termination error

    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(router.getInFlightCount(1), 1);

    // 3. Deploy v2 with short drain timeout (200ms)
    const startTime = Date.now();
    await deployer.deploy(
      'hangapp',
      { command: process.execPath, args: [v2Path] },
      { publicPort, drainTimeout: 200, stabilizationWindowMs: 50 }
    );
    const duration = Date.now() - startTime;

    // Gen 1 process should have been terminated after timeout
    assert.strictEqual(pm.isAlive(gen1.pid), false);
    // Deployment should not have hung indefinitely
    assert.ok(duration < 2000);

    // Public port serves v2
    const v2Res = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${publicPort}/`, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve(data));
      });
    });
    assert.strictEqual(v2Res, 'v2');

    await router.close();
    const active = gm.getActive('hangapp');
    await dm.drain(active, { stopProcess: true, timeout: 500 });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
