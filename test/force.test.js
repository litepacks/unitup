import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createService,
  removeService,
  setCommandRunner,
  resetCommandRunner
} from '../src/index.js';
import { parseArgs, runCli } from '../src/cli.js';

describe('Active Service Protection & --force Flag Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `unitup-force-test-${Date.now()}`);
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;

  test('setup test environment', () => {
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  test('parseArgs parses -f and --force flags', () => {
    const res1 = parseArgs(['remove', 'api', '-f']);
    assert.equal(res1.flags.force, true);

    const res2 = parseArgs(['remove', 'api', '--force']);
    assert.equal(res2.flags.force, true);

    const res3 = parseArgs(['add', 'server.js', '--force']);
    assert.equal(res3.flags.force, true);
  });

  test('removeService blocks removal of active service without force', async () => {
    const dummyScript = path.join(tmpDir, 'active-app.js');
    fs.writeFileSync(dummyScript, 'console.log("active");');

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          stdout: 'ActiveState=active\nSubState=running\nMainPID=1234\n',
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await createService({
      name: 'active-app',
      script: dummyScript
    });

    // Attempting remove without force must fail with helpful message
    await assert.rejects(
      async () => {
        await removeService('active-app');
      },
      (err) => {
        return (
          err.message.includes('currently running') &&
          err.message.includes('Use --force (-f)')
        );
      }
    );

    // Attempting remove with force must succeed
    const removed = await removeService('active-app', { force: true });
    assert.equal(removed, true);

    resetCommandRunner();
  });

  test('addService blocks overwriting active service without force', async () => {
    const dummyScript = path.join(tmpDir, 'overwrite-app.js');
    fs.writeFileSync(dummyScript, 'console.log("v1");');

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          stdout: 'ActiveState=active\nSubState=running\nMainPID=5678\n',
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await createService({
      name: 'overwrite-app',
      script: dummyScript
    });

    // Overwriting active service without force must fail
    await assert.rejects(
      async () => {
        await createService({
          name: 'overwrite-app',
          script: dummyScript
        });
      },
      (err) => {
        return (
          err.message.includes('currently running') &&
          err.message.includes('Use --force (-f)')
        );
      }
    );

    // Overwriting with force must succeed
    const res = await createService({
      name: 'overwrite-app',
      script: dummyScript,
      force: true
    });
    assert.ok(res.unitPath);

    resetCommandRunner();
  });

  test('teardown test environment', () => {
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
