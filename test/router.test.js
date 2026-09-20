import assert from 'node:assert';
import http from 'node:http';
import test, { describe } from 'node:test';
import { findFreePort } from '../src/core/generation-manager.js';
import { Router } from '../src/core/router.js';

describe('Router Architecture Boundary Suite', () => {
  test('routes HTTP requests and switches backend atomically', async () => {
    const publicPort = await findFreePort();
    const backendPort1 = await findFreePort();
    const backendPort2 = await findFreePort();

    // Backend 1
    const server1 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('backend-1-response');
    });
    await new Promise((r) => server1.listen(backendPort1, '127.0.0.1', r));

    // Backend 2
    const server2 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('backend-2-response');
    });
    await new Promise((r) => server2.listen(backendPort2, '127.0.0.1', r));

    const router = new Router();
    await router.listen(publicPort, '127.0.0.1');

    // Helper to send request to public port
    const requestPublic = () =>
      new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${publicPort}/test`, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          })
          .on('error', reject);
      });

    // When no backend is set, returns 503
    const noBackendRes = await requestPublic();
    assert.strictEqual(noBackendRes.status, 503);

    // Point to backend 1
    router.switchBackend('api', { id: 1, internalPort: backendPort1 });
    const res1 = await requestPublic();
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body, 'backend-1-response');

    // Switch to backend 2
    router.switchBackend('api', { id: 2, internalPort: backendPort2 });
    const res2 = await requestPublic();
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body, 'backend-2-response');

    // Clean up
    await router.close();
    await new Promise((r) => server1.close(r));
    await new Promise((r) => server2.close(r));
  });

  test('tracks in-flight requests accurately', async () => {
    const publicPort = await findFreePort();
    const backendPort = await findFreePort();

    let completeRequest = null;
    const backendServer = http.createServer((req, res) => {
      completeRequest = () => {
        res.writeHead(200);
        res.end('ok');
      };
    });
    await new Promise((r) => backendServer.listen(backendPort, '127.0.0.1', r));

    const router = new Router();
    await router.listen(publicPort, '127.0.0.1');
    router.switchBackend('api', { id: 10, internalPort: backendPort });

    assert.strictEqual(router.getInFlightCount(10), 0);

    // Send async request that pauses
    const reqPromise = new Promise((resolve) => {
      http.get(`http://127.0.0.1:${publicPort}/pause`, (res) => {
        res.resume();
        res.on('end', resolve);
      });
    });

    // Wait short delay for request to reach backend
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(router.getInFlightCount(10), 1);

    // Complete backend response
    completeRequest();
    await reqPromise;

    // In-flight should decrement to 0
    assert.strictEqual(router.getInFlightCount(10), 0);

    await router.close();
    await new Promise((r) => backendServer.close(r));
  });

  test('rejects when public port is already occupied', async () => {
    const busyPort = await findFreePort();
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(busyPort, '127.0.0.1', r));

    const router = new Router();
    await assert.rejects(
      () => router.listen(busyPort, '127.0.0.1'),
      /already occupied/
    );

    await new Promise((r) => blocker.close(r));
  });
});
