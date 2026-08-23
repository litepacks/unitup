import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  ExecutableNotFoundError,
  InvalidServiceConfigError,
  PermissionRequiredError,
  ServiceAlreadyExistsError,
  ServiceNotFoundError,
  ServiceStartError,
  ServiceStopError,
  UnitupError,
  UnsupportedPlatformError
} from '../src/errors.js';
import {
  LinuxAdapter,
  MacOSAdapter,
  ServiceManager,
  WindowsAdapter,
  getAdapter,
  getPlatformCapabilities,
  normalizeServiceConfig,
  resolveExecutable
} from '../src/index.js';

describe('Platform Adapter Factory & Normalization Suite', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-plat-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('getAdapter resolves correct adapter classes for linux, darwin, and win32', () => {
    const linux = getAdapter('linux');
    assert.ok(linux instanceof LinuxAdapter);
    assert.equal(linux.name, 'linux');

    const macos = getAdapter('darwin');
    assert.ok(macos instanceof MacOSAdapter);
    assert.equal(macos.name, 'macos');

    const macosAlias = getAdapter('macos');
    assert.ok(macosAlias instanceof MacOSAdapter);

    const win = getAdapter('win32');
    assert.ok(win instanceof WindowsAdapter);
    assert.equal(win.name, 'windows');

    const winAlias = getAdapter('windows');
    assert.ok(winAlias instanceof WindowsAdapter);

    assert.throws(() => getAdapter('freebsd'), UnsupportedPlatformError);
  });

  test('getPlatformCapabilities returns correct metadata per OS', () => {
    const linuxCaps = getPlatformCapabilities('linux');
    assert.equal(linuxCaps.serviceManager, 'systemd');
    assert.equal(linuxCaps.supports.memoryLimits, true);

    const macCaps = getPlatformCapabilities('darwin');
    assert.equal(macCaps.serviceManager, 'launchd');
    assert.equal(macCaps.supports.userServices, true);

    const winCaps = getPlatformCapabilities('win32');
    assert.equal(winCaps.serviceManager, 'windows');
  });

  test('resolveExecutable locates binaries in custom directory or system path', () => {
    // 1. Direct node executable
    const resolvedNode = resolveExecutable('node');
    assert.ok(resolvedNode !== null);
    assert.ok(path.isAbsolute(resolvedNode));

    // 2. Custom script in directory
    const customBin = path.join(tmpDir, 'custom-tool');
    fs.writeFileSync(customBin, '#!/bin/sh\necho "tool"');
    fs.chmodSync(customBin, 0o755);

    const found = resolveExecutable('./custom-tool', { cwd: tmpDir });
    assert.equal(found, fs.realpathSync(customBin));

    // 3. Non-existent binary
    assert.equal(resolveExecutable('completely-non-existent-binary-12345'), null);
  });

  test('normalizeServiceConfig validates inputs and normalizes fields', async () => {
    const script = path.join(tmpDir, 'app.js');
    fs.writeFileSync(script, '');

    const norm = await normalizeServiceConfig({
      name: 'My Service App',
      script: script,
      cwd: tmpDir,
      env: { FOO: 'bar' },
      restart: { enabled: true, delay: 2000 },
      memoryMax: '512M'
    });

    assert.equal(norm.name, 'my-service-app');
    assert.equal(norm.displayName, 'My Service App');
    assert.equal(norm.runtime, 'node');
    assert.ok(norm.command.includes('node'));
    assert.deepEqual(norm.args, [script]);
    assert.equal(norm.cwd, tmpDir);
    assert.equal(norm.env.FOO, 'bar');
    assert.equal(norm.restart.delay, 2000);
    assert.equal(norm.resources.memoryMax, '512M');
  });

  test('normalizeServiceConfig throws InvalidServiceConfigError on empty or invalid name', async () => {
    await assert.rejects(async () => normalizeServiceConfig({}), InvalidServiceConfigError);
  });

  test('ServiceManager dry-run generate returns formatted service definitions for all platforms', async () => {
    const script = path.join(tmpDir, 'service.js');
    fs.writeFileSync(script, 'console.log("dry run");');

    const linuxMgr = new ServiceManager({ platform: 'linux' });
    const linuxUnit = await linuxMgr.generate({ name: 'dry-app', script });
    assert.ok(typeof linuxUnit === 'string');
    assert.match(linuxUnit, /\[Unit\]/);
    assert.match(linuxUnit, /\[Service\]/);

    const macMgr = new ServiceManager({ platform: 'darwin' });
    const macPlist = await macMgr.generate({ name: 'dry-app', script });
    assert.ok(typeof macPlist === 'string');
    assert.match(macPlist, /<plist/);
    assert.match(macPlist, /dev\.unitup\.dry-app/);

    const winMgr = new ServiceManager({ platform: 'win32' });
    const winConfig = await winMgr.generate({ name: 'dry-app', script });
    assert.equal(typeof winConfig, 'object');
    assert.equal(winConfig.serviceName, 'unitup-dry-app');
  });

  test('Error hierarchy instances and properties', () => {
    const err1 = new UnsupportedPlatformError('sunos');
    assert.ok(err1 instanceof UnitupError);
    assert.equal(err1.code, 'ERR_UNSUPPORTED_PLATFORM');
    assert.equal(err1.platform, 'sunos');

    const err2 = new ServiceNotFoundError('ghost');
    assert.ok(err2 instanceof UnitupError);
    assert.equal(err2.serviceName, 'ghost');

    const err3 = new ServiceAlreadyExistsError('taken');
    assert.ok(err3 instanceof UnitupError);
    assert.equal(err3.serviceName, 'taken');

    const err4 = new PermissionRequiredError('Must be root', 'install');
    assert.ok(err4 instanceof UnitupError);
    assert.equal(err4.action, 'install');

    const err5 = new ServiceStartError('worker', 'Crash loop');
    assert.ok(err5 instanceof UnitupError);
    assert.equal(err5.reason, 'Crash loop');

    const err6 = new ExecutableNotFoundError('ruby');
    assert.ok(err6 instanceof UnitupError);
    assert.equal(err6.executable, 'ruby');
  });
});
