import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { parseArgs, runCli } from '../src/cli.js';
import { createService, removeService, resetCommandRunner, setCommandRunner, stopService } from '../src/index.js';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function spawnStubbornProcess() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const timer = setTimeout(() => reject(new Error('Stubborn helper did not start')), 3000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

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
        return err.message.includes('currently running') && err.message.includes('Use --force (-f)');
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
        return err.message.includes('currently running') && err.message.includes('Use --force (-f)');
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

  test('Linux stopService, removeService({ force: true }), and addService({ force: true }) ensure old PID exits', async () => {
    const dummyScript = path.join(tmpDir, 'orphan-linux.js');
    fs.writeFileSync(dummyScript, 'console.log("linux");');

    const child = await spawnStubbornProcess();
    let oldAliveAtRestart = null;

    try {
      setCommandRunner(async (cmd, args) => {
        if (cmd === 'systemctl' && args.includes('show')) {
          return {
            stdout: `ActiveState=active\nSubState=running\nMainPID=${child.pid}\n`,
            stderr: '',
            code: 0
          };
        }
        if (cmd === 'systemctl' && args.includes('stop')) {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          return { stdout: '', stderr: '', code: 0 };
        }
        if (cmd === 'systemctl' && args.includes('restart')) {
          oldAliveAtRestart = isPidAlive(child.pid);
          return { stdout: '', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      });

      await createService({ name: 'orphan-linux', script: dummyScript });
      await createService({ name: 'orphan-linux', script: dummyScript, force: true, shutdownTimeout: 250 });

      assert.equal(oldAliveAtRestart, false, 'Old PID must be dead before systemctl restart runs');
      assert.equal(isPidAlive(child.pid), false, 'Old PID must not linger');

      // Also verify removeService({ force: true }) works idempotently even if unit file is already removed
      const child2 = await spawnStubbornProcess();
      try {
        setCommandRunner(async (cmd, args) => {
          if (cmd === 'systemctl' && args.includes('show')) {
            return { stdout: `ActiveState=active\nSubState=running\nMainPID=${child2.pid}\n`, stderr: '', code: 0 };
          }
          return { stdout: '', stderr: '', code: 0 };
        });

        await removeService('nonexistent-orphan-linux', { force: true, shutdownTimeout: 250 });
        assert.equal(
          isPidAlive(child2.pid),
          false,
          'Orphan PID must be force killed on removeService({ force: true })'
        );
      } finally {
        try {
          process.kill(child2.pid, 'SIGKILL');
        } catch {
          // already dead
        }
      }
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
      resetCommandRunner();
    }
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
