import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ensureProcessStopped } from '../src/core/process-manager.js';
import { getDoctorInfo } from '../src/doctor.js';
import { PermissionRequiredError, ServiceAlreadyExistsError, ServiceNotFoundError } from '../src/errors.js';
import { MacOSAdapter } from '../src/platform/macos.js';
import { normalizeServiceConfig } from '../src/service/normalize.js';
import { resetCommandRunner, setCommandRunner } from '../src/systemd.js';
import { readAppMetadata, saveAppMetadata } from '../src/utils.js';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function spawnHelperProcess(code) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('Helper process did not signal ready in time')), 3000);
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

describe('macOS (launchd) Adapter Suite', () => {
  let tmpDir;
  let adapter;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-macos-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    adapter = new MacOSAdapter();
  });

  afterEach(() => {
    resetCommandRunner();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('macOS adapter exposes correct capabilities', () => {
    assert.equal(adapter.name, 'macos');
    assert.equal(adapter.capabilities.serviceManager, 'launchd');
    assert.equal(adapter.capabilities.supports.install, true);
    assert.equal(adapter.capabilities.supports.userServices, true);
    assert.equal(adapter.capabilities.supports.systemServices, true);
  });

  test('generates valid launchd plist XML with ProgramArguments, WorkingDirectory, KeepAlive, and Env', async () => {
    const dummyScript = path.join(tmpDir, 'server.js');
    fs.writeFileSync(dummyScript, 'console.log("hello");');

    const config = await normalizeServiceConfig({
      name: 'my-app',
      script: dummyScript,
      cwd: tmpDir,
      env: {
        NODE_ENV: 'production',
        PORT: '4000'
      },
      restart: {
        enabled: true,
        delay: 5000
      },
      autostart: true
    });

    const plist = adapter.generateService(config);

    assert.ok(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.match(plist, /<key>Label<\/key>\s*<string>dev\.unitup\.my-app<\/string>/);
    assert.match(plist, /<key>ProgramArguments<\/key>/);
    assert.match(plist, /<string>.*node.*<\/string>/);
    assert.match(plist, /<string>.*server\.js<\/string>/);
    assert.match(plist, /<key>WorkingDirectory<\/key>/);
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>KeepAlive<\/key>/);
    assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>5<\/integer>/);
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>NODE_ENV<\/key>\s*<string>production<\/string>/);
    assert.match(plist, /<key>PORT<\/key>\s*<string>4000<\/string>/);
    assert.match(plist, /<key>StandardOutPath<\/key>/);
    assert.match(plist, /<key>StandardErrorPath<\/key>/);
  });

  test('generates plist with KeepAlive=false when restart is disabled', async () => {
    const dummyScript = path.join(tmpDir, 'once.js');
    fs.writeFileSync(dummyScript, '');

    const config = await normalizeServiceConfig({
      name: 'once-task',
      script: dummyScript,
      cwd: tmpDir,
      restart: 'no'
    });

    const plist = adapter.generateService(config);
    assert.match(plist, /<key>KeepAlive<\/key>\s*<false\/>/);
  });

  test('getLabel and plist paths for user and system scopes', () => {
    assert.equal(adapter.getLabel('api-worker'), 'dev.unitup.api-worker');
    const userPath = adapter.getPlistPath('api-worker', false);
    assert.ok(userPath.includes('LaunchAgents'));
    assert.ok(userPath.endsWith('dev.unitup.api-worker.plist'));

    const systemPath = adapter.getPlistPath('api-worker', true);
    assert.equal(path.normalize(systemPath), path.normalize('/Library/LaunchDaemons/dev.unitup.api-worker.plist'));
  });

  test('getDomain returns gui/<uid> for user and system for daemons', () => {
    const userDomain = adapter.getDomain(false);
    assert.match(userDomain, /^gui\/\d+$/);
    const sysDomain = adapter.getDomain(true);
    assert.equal(sysDomain, 'system');
  });

  test('install writes plist and bootstraps launchd service', async () => {
    const executedCommands = [];
    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    });

    const dummyScript = path.join(tmpDir, 'web.js');
    fs.writeFileSync(dummyScript, 'console.log("web");');

    const config = await normalizeServiceConfig({
      name: 'web-service',
      script: dummyScript,
      cwd: tmpDir
    });

    // Mock plist directory to tmpDir for write test
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const res = await adapter.install(config);
    assert.equal(res.name, 'web-service');
    assert.equal(res.label, 'dev.unitup.web-service');
    assert.ok(fs.existsSync(res.unitPath));

    const plistXml = fs.readFileSync(res.unitPath, 'utf8');
    assert.match(plistXml, /<string>dev\.unitup\.web-service<\/string>/);

    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('bootstrap')));
  });

  test('install throws PermissionRequiredError when installing system service as non-root', async () => {
    const dummyScript = path.join(tmpDir, 'sys.js');
    fs.writeFileSync(dummyScript, '');
    const config = await normalizeServiceConfig({ name: 'sys-daemon', script: dummyScript, system: true });

    const origGetUid = process.getuid;
    process.getuid = () => 501; // Non-root user

    try {
      await assert.rejects(async () => adapter.install(config, { system: true }), PermissionRequiredError);
    } finally {
      process.getuid = origGetUid;
    }
  });

  test('start, stop, restart, enable, disable launchctl commands', async () => {
    const executedCommands = [];
    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    });

    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('control-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    await adapter.start('control-app');
    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('kickstart')));

    await adapter.stop('control-app');
    assert.ok(
      executedCommands.some((c) => c.cmd === 'launchctl' && (c.args.includes('bootout') || c.args.includes('kill')))
    );

    await adapter.restart('control-app');
    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('kickstart')));

    await adapter.enable('control-app');
    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('enable')));

    await adapter.disable('control-app');
    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('disable')));
  });

  test('status parses launchctl print output accurately', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('status-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'launchctl' && args.includes('print')) {
        return {
          code: 0,
          stdout: `
            gui/501/dev.unitup.status-app = {
              active count = 1
              path = ${plistPath}
              state = running
              pid = 49201
              last exit code = 0
            }
          `,
          stderr: ''
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const stat = await adapter.status('status-app');
    assert.equal(stat.name, 'status-app');
    assert.equal(stat.state, 'running');
    assert.equal(stat.pid, '49201');
    assert.equal(stat.platform, 'darwin');
    assert.equal(stat.manager, 'launchd');
  });

  test('uninstall removes plist file and cleans metadata', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('uninst-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    setCommandRunner(async () => ({ code: 0, stdout: 'state = stopped\n', stderr: '' }));

    const uninstalled = await adapter.uninstall('uninst-app');
    assert.equal(uninstalled, true);
    assert.equal(fs.existsSync(plistPath), false);
  });

  test('stop waits for a process that delays SIGTERM exit', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('delayed-stop-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    const child = await spawnHelperProcess(
      'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 200)); console.log("READY"); setInterval(() => {}, 1000);'
    );

    try {
      setCommandRunner(async (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'print') {
          return {
            code: 0,
            stdout: `state = running\npid = ${child.pid}\n`,
            stderr: ''
          };
        }
        if (cmd === 'launchctl' && args[0] === 'kill' && args[1] === 'SIGTERM') {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await adapter.stop('delayed-stop-app', { shutdownTimeout: 2000 });
      assert.equal(isPidAlive(child.pid), false, 'Process should have exited before stop() resolved');
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  test('stop escalates to SIGKILL when process ignores SIGTERM', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('stubborn-stop-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    const child = await spawnHelperProcess(
      'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'
    );

    try {
      setCommandRunner(async (cmd, args) => {
        if (cmd === 'launchctl' && args[0] === 'print') {
          return {
            code: 0,
            stdout: `state = running\npid = ${child.pid}\n`,
            stderr: ''
          };
        }
        if (cmd === 'launchctl' && args[0] === 'kill' && args[1] === 'SIGTERM') {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await adapter.stop('stubborn-stop-app', { shutdownTimeout: 250 });
      assert.equal(isPidAlive(child.pid), false, 'SIGTERM-ignoring process should be force killed');
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  test('uninstall with force: true cleans up orphan process and metadata even when plist is missing', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const child = await spawnHelperProcess(
      'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'
    );
    const executedCommands = [];

    try {
      // Save metadata with PID, but do NOT create plist file on disk
      saveAppMetadata({
        name: 'orphan-app',
        command: process.execPath,
        args: ['-e', ''],
        cwd: tmpDir,
        pid: String(child.pid)
      });

      setCommandRunner(async (cmd, args) => {
        executedCommands.push({ cmd, args });
        if (cmd === 'launchctl' && args[0] === 'print') {
          return {
            code: 0,
            stdout: `state = running\npid = ${child.pid}\n`,
            stderr: ''
          };
        }
        if (cmd === 'launchctl' && args[0] === 'bootout') {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      // Without force, missing plist still throws ServiceNotFoundError
      await assert.rejects(async () => adapter.uninstall('orphan-app'), ServiceNotFoundError);

      // With force, bootout runs, orphan PID is killed, and metadata is removed
      const removed = await adapter.uninstall('orphan-app', { force: true, shutdownTimeout: 250 });
      assert.equal(removed, true);
      assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootout'));
      assert.equal(isPidAlive(child.pid), false, 'Orphan process must be terminated');
      assert.equal(readAppMetadata('orphan-app'), null, 'Metadata must be cleaned up');
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  test('install with force: true and start: true kills old SIGTERM-ignoring PID before bootstrap and avoids double-start', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const dummyScript = path.join(tmpDir, 'reinstall-app.js');
    fs.writeFileSync(dummyScript, 'console.log("v2");');

    const plistPath = adapter.getPlistPath('reinstall-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    const oldChild = await spawnHelperProcess(
      'process.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);'
    );
    let newChild = null;
    let currentPid = oldChild.pid;
    let oldAliveAtBootstrap = null;
    const spawnedPids = [oldChild.pid];
    const executedCommands = [];

    try {
      setCommandRunner(async (cmd, args) => {
        executedCommands.push({ cmd, args });
        if (cmd === 'launchctl' && args[0] === 'print') {
          if (currentPid && isPidAlive(currentPid)) {
            return {
              code: 0,
              stdout: `state = running\npid = ${currentPid}\n`,
              stderr: ''
            };
          }
          return { code: 113, stdout: '', stderr: 'Could not find service' };
        }
        if (cmd === 'launchctl' && args[0] === 'bootout') {
          // Real launchd sends SIGTERM and returns immediately without waiting for exit
          try {
            process.kill(oldChild.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          currentPid = null;
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'launchctl' && args[0] === 'bootstrap') {
          // Verify old process is ALREADY completely dead before new instance starts
          oldAliveAtBootstrap = isPidAlive(oldChild.pid);
          // Simulate RunAtLoad: true spawning the new process on bootstrap
          newChild = await spawnHelperProcess('console.log("READY"); setInterval(() => {}, 1000);');
          currentPid = newChild.pid;
          spawnedPids.push(newChild.pid);
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      const config = await normalizeServiceConfig({
        name: 'reinstall-app',
        script: dummyScript,
        cwd: tmpDir,
        autostart: true
      });

      await adapter.install(config, { force: true, start: true, shutdownTimeout: 250 });

      assert.equal(oldAliveAtBootstrap, false, 'Old process must be completely dead before bootstrap starts new one');
      assert.equal(isPidAlive(oldChild.pid), false, 'Old PID must not remain as an orphan');
      assert.ok(newChild && isPidAlive(newChild.pid), 'New PID must be alive');

      const alivePids = spawnedPids.filter((pid) => isPidAlive(pid));
      assert.equal(alivePids.length, 1, 'Exactly one active PID must remain after reinstall');
      assert.equal(alivePids[0], newChild.pid);

      const kickstartCalls = executedCommands.filter((c) => c.cmd === 'launchctl' && c.args[0] === 'kickstart');
      assert.equal(
        kickstartCalls.length,
        0,
        'Must not double-start via kickstart -k when RunAtLoad already started it'
      );
    } finally {
      for (const pid of spawnedPids) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already dead
        }
      }
    }
  });

  test('generateService writes ExitTimeOut synced with shutdownTimeout', async () => {
    const dummyScript = path.join(tmpDir, 'grace.js');
    fs.writeFileSync(dummyScript, '');

    const config = await normalizeServiceConfig({
      name: 'grace-app',
      script: dummyScript,
      cwd: tmpDir,
      shutdownTimeout: 7500
    });

    const plist = adapter.generateService(config);
    assert.match(plist, /<key>ExitTimeOut<\/key>\s*<integer>8<\/integer>/);
  });

  test('stop boots out job to prevent KeepAlive respawn, clears stale meta.pid, and start re-bootstraps', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    const plistPath = adapter.getPlistPath('keepalive-app');
    fs.writeFileSync(plistPath, '<plist></plist>');

    const child = await spawnHelperProcess(
      'process.on("SIGTERM", () => process.exit(0)); console.log("READY"); setInterval(() => {}, 1000);'
    );
    let loaded = true;
    const executedCommands = [];

    try {
      saveAppMetadata({
        name: 'keepalive-app',
        command: process.execPath,
        args: ['-e', ''],
        cwd: tmpDir,
        pid: String(child.pid)
      });

      setCommandRunner(async (cmd, args) => {
        executedCommands.push({ cmd, args });
        if (cmd === 'launchctl' && args[0] === 'print') {
          if (loaded) {
            return { code: 0, stdout: `state = running\npid = ${child.pid}\n`, stderr: '' };
          }
          return { code: 113, stdout: '', stderr: 'Could not find service' };
        }
        if (cmd === 'launchctl' && args[0] === 'bootout') {
          loaded = false;
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // ignore
          }
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd === 'launchctl' && args[0] === 'kickstart') {
          return loaded ? { code: 0, stdout: '', stderr: '' } : { code: 113, stdout: '', stderr: 'Not loaded' };
        }
        if (cmd === 'launchctl' && args[0] === 'bootstrap') {
          loaded = true;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      });

      await adapter.stop('keepalive-app', { shutdownTimeout: 1000 });
      assert.equal(isPidAlive(child.pid), false);
      assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootout'));
      assert.equal(readAppMetadata('keepalive-app')?.pid, undefined, 'Stale PID must be cleared from metadata');

      // Starting after bootout should cleanly re-bootstrap
      await adapter.start('keepalive-app');
      assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args[0] === 'bootstrap'));
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  test('status reports orphaned running launchd job when plist is missing on disk', async () => {
    adapter.getPlistDir = () => tmpDir;
    adapter.getPlistPath = (name) => path.join(tmpDir, `dev.unitup.${name}.plist`);

    setCommandRunner(async (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'print') {
        return { code: 0, stdout: 'state = running\npid = 77777\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const stat = await adapter.status('ghost-orphan');
    assert.equal(stat.installed, false);
    assert.equal(stat.orphaned, true);
    assert.equal(stat.state, 'running');
    assert.equal(stat.pid, '77777');
  });

  test('ensureProcessStopped skips killing when expectedCommand mismatches (PID reuse guard)', async () => {
    const child = await spawnHelperProcess('console.log("READY"); setInterval(() => {}, 1000);');
    try {
      const result = await ensureProcessStopped(child.pid, {
        shutdownTimeout: 100,
        sendTerm: true,
        expectedCommand: '/usr/bin/completely-unrelated-binary-xyz'
      });
      assert.equal(result, true);
      assert.equal(isPidAlive(child.pid), true, 'Unrelated process must not be killed on PID mismatch');
    } finally {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {
        // already dead
      }
    }
  });

  test('getDoctorInfo detects orphaned dev.unitup.* launchd jobs on macOS', async () => {
    if (process.platform !== 'darwin') return;
    setCommandRunner(async (cmd, args) => {
      if (cmd === 'launchctl' && args[0] === 'version') {
        return { code: 0, stdout: 'launchd', stderr: '' };
      }
      if (cmd === 'launchctl' && args[0] === 'print') {
        return { code: 0, stdout: 'gui/501 = {}', stderr: '' };
      }
      if (cmd === 'launchctl' && args[0] === 'list') {
        return { code: 0, stdout: '12345\t0\tdev.unitup.nonexistent-orphan-doctor-test\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    const info = await getDoctorInfo();
    assert.equal(info.launchctlAvailable, true);
    assert.equal(info.launchdDomainAccessible, true);
    assert.ok(info.orphanedLaunchdJobs.includes('dev.unitup.nonexistent-orphan-doctor-test'));
  });
});
