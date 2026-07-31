import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  findProjectConfig,
  readProjectConfig,
  saveProjectConfig
} from '../src/utils.js';
import { parseArgs, runCli } from '../src/cli.js';

describe('Project Configuration (unitup.config.json)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-config-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('findProjectConfig locates unitup.config.json and .unitup.json', () => {
    assert.equal(findProjectConfig(tmpDir), null);

    const configPath = path.join(tmpDir, 'unitup.config.json');
    fs.writeFileSync(configPath, JSON.stringify({ name: 'test-app' }), 'utf8');

    assert.equal(findProjectConfig(tmpDir), configPath);
  });

  test('saveProjectConfig and readProjectConfig work correctly', () => {
    const written = saveProjectConfig(tmpDir, {
      name: 'my-service',
      group: 'backend',
      script: 'index.js',
      runtime: 'node',
      env: { PORT: '8080' },
      resources: { memoryMax: '512M' }
    });

    assert.equal(written, path.join(tmpDir, 'unitup.config.json'));
    assert.equal(fs.existsSync(written), true);

    const read = readProjectConfig(tmpDir);
    assert.notEqual(read, null);
    assert.equal(read.name, 'my-service');
    assert.equal(read.group, 'backend');
    assert.equal(read.script, 'index.js');
    assert.equal(read.env.PORT, '8080');
    assert.equal(read.resources.memoryMax, '512M');
  });

  test('parseArgs parses init command and --config flag', () => {
    const res = parseArgs(['init', 'server.js', '--name', 'api', '--config', 'custom.json']);
    assert.equal(res.command, 'init');
    assert.deepEqual(res.positionals, ['server.js']);
    assert.equal(res.flags.name, 'api');
    assert.equal(res.flags.config, 'custom.json');
  });

  test('cli init creates unitup.config.json in cwd', async () => {
    const scriptPath = path.join(tmpDir, 'app.js');
    fs.writeFileSync(scriptPath, 'console.log("hello");', 'utf8');

    // Run CLI init with --cwd
    await runCli(['init', 'app.js', '--cwd', tmpDir, '--name', 'test-init', '--memory-max', '256M', '--env', 'ENV=test']);

    const configFile = path.join(tmpDir, 'unitup.config.json');
    assert.equal(fs.existsSync(configFile), true);

    const cfg = readProjectConfig(configFile);
    assert.equal(cfg.name, 'test-init');
    assert.equal(cfg.script, 'app.js');
    assert.equal(cfg.env.ENV, 'test');
    assert.equal(cfg.resources.memoryMax, '256M');
  });
});
