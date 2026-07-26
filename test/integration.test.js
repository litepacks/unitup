import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createService,
  startService,
  stopService,
  restartService,
  removeService,
  getServiceStatus,
  listServices,
  isLinux,
  isSystemdAvailable
} from '../src/index.js';

const isIntegration = process.env.UNITUP_INTEGRATION_TEST === '1';

describe('Real Systemd Integration Test Suite', { skip: !isIntegration }, () => {
  let scriptPath;

  test('setup test script', (t) => {
    if (!isIntegration) {
      t.skip('Skipped real systemd integration test (requires UNITUP_INTEGRATION_TEST=1 on Linux)');
      return;
    }
    assert.equal(isLinux(), true, 'Integration test requires Linux');
    scriptPath = path.join(os.tmpdir(), 'unitup-integration-script.js');
    fs.writeFileSync(scriptPath, 'console.log("integration service running"); setInterval(() => {}, 1000);');
  });

  test('add, start, status, stop, remove lifecycle on real systemd user service', async (t) => {
    if (!isIntegration) {
      t.skip('Skipped real systemd integration test');
      return;
    }
    const serviceName = 'integration-test';

    // Add service
    await createService({
      name: serviceName,
      script: scriptPath,
      start: true
    });

    // Verify status
    const status1 = await getServiceStatus(serviceName);
    assert.equal(status1.name, serviceName);

    // List services
    const services = await listServices();
    const found = services.find(s => s.name === serviceName);
    assert.ok(found, 'Service should appear in listServices()');

    // Restart service
    await restartService(serviceName);

    // Stop service
    await stopService(serviceName);

    // Remove service
    await removeService(serviceName);

    // Verify removed
    const servicesAfter = await listServices();
    const foundAfter = servicesAfter.find(s => s.name === serviceName);
    assert.equal(foundAfter, undefined, 'Service should no longer be listed after removal');

    // Clean test script file
    if (fs.existsSync(scriptPath)) {
      fs.unlinkSync(scriptPath);
    }
  });
});
