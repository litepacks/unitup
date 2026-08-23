import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { PermissionRequiredError, ServiceAlreadyExistsError, ServiceNotFoundError } from '../src/errors.js';
import { MacOSAdapter } from '../src/platform/macos.js';
import { normalizeServiceConfig } from '../src/service/normalize.js';
import { resetCommandRunner, setCommandRunner } from '../src/systemd.js';

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
    assert.equal(systemPath, '/Library/LaunchDaemons/dev.unitup.api-worker.plist');
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
    assert.ok(executedCommands.some((c) => c.cmd === 'launchctl' && c.args.includes('kill')));

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
});
