import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  validateMemorySize,
  formatMemoryBytes,
  createService,
  setServiceLimits,
  getServiceStatus,
  inspectService,
  readAppMetadata,
  setCommandRunner,
  resetCommandRunner
} from '../src/index.js';
import { generateUnitContent, parseUnitContent } from '../src/unit.js';

describe('Systemd-Native Memory Limits Suite', () => {
  const tmpDir = path.join(os.tmpdir(), `unitup-limits-test-${Date.now()}`);
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;

  test('setup test environment', () => {
    process.env.XDG_CONFIG_HOME = tmpDir;
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  test('validateMemorySize valid inputs', () => {
    assert.equal(validateMemorySize('128K'), '128K');
    assert.equal(validateMemorySize('256M'), '256M');
    assert.equal(validateMemorySize('1G'), '1G');
    assert.equal(validateMemorySize('2T'), '2T');
    assert.equal(validateMemorySize('infinity'), 'infinity');
    assert.equal(validateMemorySize('max'), 'infinity');
    assert.equal(validateMemorySize('536870912'), '536870912');
  });

  test('validateMemorySize rejects invalid, negative, empty, and shell injection attempts', () => {
    assert.throws(() => validateMemorySize(''), /cannot be empty/);
    assert.throws(() => validateMemorySize('-256M'), /cannot be negative/);
    assert.throws(() => validateMemorySize('256M; rm -rf /'), /shell injection attempt/);
    assert.throws(() => validateMemorySize('512M | cat'), /shell injection attempt/);
    assert.throws(() => validateMemorySize('invalid_unit'), /Invalid Memory limit format/);
  });

  test('formatMemoryBytes formats byte numbers and handles unavailable/infinity markers', () => {
    assert.equal(formatMemoryBytes(297795584), '284 MB');
    assert.equal(formatMemoryBytes(378535936), '361 MB');
    assert.equal(formatMemoryBytes(1073741824), '1 GB');
    assert.equal(formatMemoryBytes('infinity'), 'infinity');
    assert.equal(formatMemoryBytes('18446744073709551615'), 'infinity');
    assert.equal(formatMemoryBytes(null), 'unavailable');
    assert.equal(formatMemoryBytes('unavailable'), 'unavailable');
  });

  test('generateUnitContent includes MemoryAccounting and limits only when provided', () => {
    const withoutLimits = generateUnitContent({
      name: 'no-limits',
      command: '/usr/bin/node',
      args: ['server.js']
    });
    assert.ok(!withoutLimits.includes('MemoryAccounting=yes'));
    assert.ok(!withoutLimits.includes('MemoryHigh='));
    assert.ok(!withoutLimits.includes('MemoryMax='));

    const withLimits = generateUnitContent({
      name: 'with-limits',
      command: '/usr/bin/node',
      args: ['server.js'],
      memoryHigh: '400M',
      memoryMax: '512M',
      memorySwapMax: '256M'
    });
    assert.ok(withLimits.includes('MemoryAccounting=yes'));
    assert.ok(withLimits.includes('MemoryHigh=400M'));
    assert.ok(withLimits.includes('MemoryMax=512M'));
    assert.ok(withLimits.includes('MemorySwapMax=256M'));

    const parsed = parseUnitContent(withLimits);
    assert.equal(parsed.memoryHigh, '400M');
    assert.equal(parsed.memoryMax, '512M');
    assert.equal(parsed.memorySwapMax, '256M');
  });

  test('createService persists resources object in metadata and handles legacy metadata', async () => {
    const dummyScript = path.join(tmpDir, 'app.js');
    fs.writeFileSync(dummyScript, 'console.log("hi");');

    setCommandRunner(async (cmd, args) => {
      return { stdout: '', stderr: '', code: 0 };
    });

    await createService({
      name: 'mem-app',
      script: dummyScript,
      memoryHigh: '400M',
      memoryMax: '512M'
    });

    const meta = readAppMetadata('mem-app');
    assert.ok(meta);
    assert.ok(meta.resources);
    assert.equal(meta.resources.memoryHigh, '400M');
    assert.equal(meta.resources.memoryMax, '512M');

    const status = await getServiceStatus('mem-app');
    assert.equal(status.name, 'mem-app');
    assert.equal(status.memoryHigh, '400 MB');
    assert.equal(status.memoryMax, '512 MB');

    resetCommandRunner();
  });

  test('setServiceLimits updates metadata, unit file, and resets memory', async () => {
    const dummyScript = path.join(tmpDir, 'limits-app.js');
    fs.writeFileSync(dummyScript, 'console.log("hi");');

    let executedCommands = [];
    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          stdout: 'ActiveState=active\nSubState=running\nMainPID=1234\nNRestarts=0\nMemoryCurrent=297795584\nMemoryPeak=378535936\nMemoryHigh=419430400\nMemoryMax=536870912\n',
          stderr: '',
          code: 0
        };
      }
      return { stdout: '', stderr: '', code: 0 };
    });

    await createService({
      name: 'limits-app',
      script: dummyScript
    });

    const inspectUpdated = await setServiceLimits('limits-app', {
      memoryHigh: '400M',
      memoryMax: '512M',
      memorySwapMax: '256M'
    });

    assert.equal(inspectUpdated.memoryHigh, '400 MB');
    assert.equal(inspectUpdated.memoryMax, '512 MB');
    assert.equal(inspectUpdated.memorySwapMax, '256 MB');

    // Reset memory limits
    const inspectReset = await setServiceLimits('limits-app', {
      resetMemory: true
    });

    const metaAfterReset = readAppMetadata('limits-app');
    assert.equal(metaAfterReset.resources, undefined);

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
