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
          .get(`http://127.0.0.1:${publicPort}/test`, { agent: false }, (res) => {
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
    if (server1.closeAllConnections) server1.closeAllConnections();
    if (server2.closeAllConnections) server2.closeAllConnections();
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
    if (backendServer.closeAllConnections) backendServer.closeAllConnections();
    await new Promise((r) => backendServer.close(r));
  });

  test('rejects when public port is already occupied', async () => {
    const busyPort = await findFreePort();
    const blocker = http.createServer();
    await new Promise((r) => blocker.listen(busyPort, '127.0.0.1', r));

    const router = new Router();
    await assert.rejects(() => router.listen(busyPort, '127.0.0.1'), /already occupied/);

    await new Promise((r) => blocker.close(r));
  });
  test('strictly isolates multi-port routing and never mixes backends across ports', async () => {
    const portA = await findFreePort();
    const portB = await findFreePort();
    const backendPortA = await findFreePort();
    const backendPortB = await findFreePort();

    // Backend A
    const serverA = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('response-from-app-A');
    });
    await new Promise((r) => serverA.listen(backendPortA, '127.0.0.1', r));

    // Backend B
    const serverB = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('response-from-app-B');
    });
    await new Promise((r) => serverB.listen(backendPortB, '127.0.0.1', r));

    const router = new Router();

    // Start Port A for appA
    await router.listen(portA, '127.0.0.1', 'appA');
    router.switchBackend('appA', { id: 1, internalPort: backendPortA }, portA);

    // Start Port B for appB - CRITICAL: must NOT close Port A!
    await router.listen(portB, '127.0.0.1', 'appB');
    router.switchBackend('appB', { id: 2, internalPort: backendPortB }, portB);

    const fetchText = (url, headers = {}) =>
      new Promise((resolve, reject) => {
        http
          .get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          })
          .on('error', reject);
      });

    // 1. Port A must respond with appA
    const resA = await fetchText(`http://127.0.0.1:${portA}/`);
    assert.strictEqual(resA.status, 200);
    assert.strictEqual(resA.body, 'response-from-app-A');

    // 2. Port B must respond with appB
    const resB = await fetchText(`http://127.0.0.1:${portB}/`);
    assert.strictEqual(resB.status, 200);
    assert.strictEqual(resB.body, 'response-from-app-B');

    // 3. Port A with Host: "appB.com" MUST NOT return appB!
    // Since port A only hosts appA, it should resolve to appA or return 503, NEVER appB!
    const resAWithHostB = await fetchText(`http://127.0.0.1:${portA}/`, { Host: 'appb.com' });
    assert.notStrictEqual(resAWithHostB.body, 'response-from-app-B');

    // 4. Closing Port A must NOT close Port B
    await router.close(portA);
    const resBAfterCloseA = await fetchText(`http://127.0.0.1:${portB}/`);
    assert.strictEqual(resBAfterCloseA.status, 200);
    assert.strictEqual(resBAfterCloseA.body, 'response-from-app-B');

    // Clean up
    await router.close();
    if (serverA.closeAllConnections) serverA.closeAllConnections();
    if (serverB.closeAllConnections) serverB.closeAllConnections();
    await new Promise((r) => serverA.close(r));
    await new Promise((r) => serverB.close(r));
  });

  test('does not blindly fall back across services when host does not match', async () => {
    const publicPort = await findFreePort();
    const backendPort1 = await findFreePort();
    const backendPort2 = await findFreePort();

    const server1 = http.createServer((req, res) => res.end('app1'));
    const server2 = http.createServer((req, res) => res.end('app2'));
    await new Promise((r) => server1.listen(backendPort1, '127.0.0.1', r));
    await new Promise((r) => server2.listen(backendPort2, '127.0.0.1', r));

    const router = new Router();
    await router.listen(publicPort, '127.0.0.1');

    // Two services on the same port
    router.switchBackend('myservice1', { id: 1, internalPort: backendPort1 }, publicPort);
    router.switchBackend('myservice2', { id: 2, internalPort: backendPort2 }, publicPort);

    const fetchText = (url, headers = {}) =>
      new Promise((resolve, reject) => {
        http
          .get(url, { headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          })
          .on('error', reject);
      });

    // Unmatched host must return 503, NEVER randomly choose myservice1
    const resUnknown = await fetchText(`http://127.0.0.1:${publicPort}/`, {
      Host: 'completelyunknown.com',
    });
    assert.strictEqual(resUnknown.status, 503);

    // Matching host returns correct service
    const resMatched = await fetchText(`http://127.0.0.1:${publicPort}/`, {
      Host: 'myservice2.com',
    });
    assert.strictEqual(resMatched.status, 200);
    assert.strictEqual(resMatched.body, 'app2');

    await router.close();
    await new Promise((r) => server1.close(r));
    await new Promise((r) => server2.close(r));
  });
});
