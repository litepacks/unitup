import assert from 'node:assert';
import http from 'node:http';
import test, { describe } from 'node:test';
import { findFreePort } from '../src/core/generation-manager.js';
import { ProcessManager } from '../src/core/process-manager.js';
import {
  ProcessStartupError,
  PortMismatchError,
  ReadinessChecker,
  ReadinessTimeoutError
} from '../src/core/readiness.js';

describe('ReadinessChecker Architecture Boundary Suite', () => {
  test('passes TCP readiness check when port is accepting connections', async () => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => res.end('ok'));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));

    const pm = new ProcessManager();
    const readiness = new ReadinessChecker({ processManager: pm });

    const isReady = await readiness.wait({ id: 1, internalPort: port }, { timeout: 2000 });
    assert.strictEqual(isReady, true);

    await new Promise((r) => server.close(r));
  });

  test('validates HTTP 2xx endpoint when path is specified', async () => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('healthy');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));

    const pm = new ProcessManager();
    const readiness = new ReadinessChecker({ processManager: pm });

    const isReady = await readiness.wait(
      { id: 1, internalPort: port },
      { timeout: 2000, path: '/health' }
    );
    assert.strictEqual(isReady, true);

    await new Promise((r) => server.close(r));
  });

  test('times out when HTTP health check returns non-2xx', async () => {
    const port = await findFreePort();
    const server = http.createServer((req, res) => {
      res.writeHead(500);
      res.end('error');
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));

    const pm = new ProcessManager();
    const readiness = new ReadinessChecker({ processManager: pm });

    await assert.rejects(
      () =>
        readiness.wait(
          { id: 1, internalPort: port },
          { timeout: 300, interval: 50, path: '/health' }
        ),
      (err) => err instanceof ReadinessTimeoutError
    );

    await new Promise((r) => server.close(r));
  });

  test('fails immediately with ProcessStartupError if process crashes during startup', async () => {
    const port = await findFreePort();
    const pm = new ProcessManager();
    // Process that exits immediately with code 1
    const proc = pm.start(process.execPath, ['-e', 'process.exit(1)']);
    await proc.exitPromise;

    const readiness = new ReadinessChecker({ processManager: pm });

    await assert.rejects(
      () => readiness.wait({ id: 1, pid: proc.pid, internalPort: port }, { timeout: 5000 }),
      (err) => err instanceof ProcessStartupError
    );
  });

  test('diagnoses EADDRINUSE crash with helpful guidance about process.env.PORT', async () => {
    const port = await findFreePort();
    const pm = new ProcessManager();
    // Simulate process that fails on EADDRINUSE
    const proc = pm.start(process.execPath, [
      '-e',
      'console.error("Error: listen EADDRINUSE: address already in use :::3000"); process.exit(1);'
    ]);
    await proc.exitPromise;

    const readiness = new ReadinessChecker({ processManager: pm });

    await assert.rejects(
      () =>
        readiness.wait(
          { id: 1, pid: proc.pid, internalPort: port },
          { timeout: 5000, configuredPort: 3000 }
        ),
      (err) => {
        assert.ok(err instanceof ProcessStartupError);
        assert.ok(err.message.includes('EADDRINUSE'));
        assert.ok(err.message.includes('process.env.PORT'));
        assert.ok(err.message.includes(':3000'));
        return true;
      }
    );
  });

  test('detects port mismatch immediately when process listens on configuredPort instead of internalPort', async () => {
    const internalPort = await findFreePort();
    const configuredPort = await findFreePort();

    // Spawn server that listens on configuredPort (hardcoded) instead of internalPort
    const server = http.createServer((req, res) => res.end('wrong port'));
    await new Promise((r) => server.listen(configuredPort, '127.0.0.1', r));

    const pm = new ProcessManager();
    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

    const readiness = new ReadinessChecker({ processManager: pm });

    try {
      await assert.rejects(
        () =>
          readiness.wait(
            { id: 1, pid: proc.pid, internalPort },
            { timeout: 5000, configuredPort }
          ),
        (err) => {
          assert.ok(err instanceof PortMismatchError);
          assert.ok(err.message.includes(`configured public port ${configuredPort}`));
          assert.ok(err.message.includes(`process.env.PORT (${internalPort})`));
          assert.strictEqual(err.detectedPort, configuredPort);
          return true;
        }
      );
    } finally {
      await pm.stop(proc.pid);
      await new Promise((r) => server.close(r));
    }
  });

  test('times out with informative message when process is running but not listening on process.env.PORT', async () => {
    const internalPort = await findFreePort();
    const pm = new ProcessManager();
    // Process that stays alive but does not listen on any network port
    const proc = pm.start(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);

    const readiness = new ReadinessChecker({ processManager: pm });

    try {
      await assert.rejects(
        () =>
          readiness.wait(
            { id: 1, pid: proc.pid, internalPort },
            { timeout: 200, interval: 50 }
          ),
        (err) => {
          assert.ok(err instanceof ReadinessTimeoutError);
          assert.ok(err.message.includes('is still running, but did not accept connections on process.env.PORT'));
          return true;
        }
      );
    } finally {
      await pm.stop(proc.pid);
    }
  });
});
