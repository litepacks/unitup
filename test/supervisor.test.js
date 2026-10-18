import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Supervisor } from '../src/core/supervisor.js';

describe('Supervisor Self-Healing & Defensive Architecture Suite', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-sup-test-'));
  });

  after(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects dead internal port on persisted active generation and self-heals by fresh deploy', async () => {
    const serviceName = 'self-healing-app';
    const stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Simulate stale state file with a dead internal port (e.g. 59999) and current process PID
    const stateFile = path.join(stateDir, `${serviceName}.json`);
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        service: serviceName,
        activeGeneration: 1,
        generations: {
          1: {
            id: 1,
            service: serviceName,
            pid: process.pid, // alive PID
            internalPort: 59999, // port is NOT listening!
            status: 'active'
          }
        }
      })
    );

    let deployCalled = false;
    const supervisor = new Supervisor(
      serviceName,
      {
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        cwd: tmpDir
      },
      {
        stateDir,
        ipcDir: tmpDir
      }
    );

    // Mock deploymentManager.deploy to verify self-healing fallback triggers
    supervisor.deploymentManager.deploy = async () => {
      deployCalled = true;
      return { service: serviceName, currentGeneration: 2, status: 'active' };
    };

    await supervisor.start();
    await supervisor.stop();

    assert.equal(
      deployCalled,
      true,
      'Supervisor should have triggered fresh deploy when active internal port was dead'
    );
  });

  it('router reports detailed error on connection refused without crash', async () => {
    const serviceName = 'router-refused-app';
    const supervisor = new Supervisor(serviceName, { port: 0 }, { stateDir: tmpDir, ipcDir: tmpDir });

    // Set backend to a closed internal port
    const dummyBackend = { id: 1, internalPort: 59998 };
    supervisor.router.switchBackend(serviceName, dummyBackend, 0);

    const srv = await supervisor.router.listen(0, '127.0.0.1', serviceName);
    const clientPort = srv.port;

    const res = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${clientPort}/`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      });
    });

    await supervisor.router.close();

    assert.equal(res.statusCode, 502);
    assert.match(res.body, /502 Bad Gateway/);
    assert.match(res.body, /Connection refused at 127.0.0.1:59998/);
    assert.match(res.body, /process.env.PORT/);
  });
});
