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

  test('Config Change Reflection: updating unitup.config.json and re-adding updates unit file and app metadata', async () => {
    const executedCommands = [];
    const { setCommandRunner, resetCommandRunner, addService, getUserUnitDir, readAppMetadata } = await import('../src/index.js');

    process.env.XDG_CONFIG_HOME = tmpDir;

    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return { code: 0, stdout: 'ActiveState=inactive\nSubState=dead\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    try {
      const scriptPath = path.join(tmpDir, 'server.js');
      fs.writeFileSync(scriptPath, 'console.log("v1");', 'utf8');

      // 1. Initial config v1
      saveProjectConfig(tmpDir, {
        name: 'reflect-service',
        script: 'server.js',
        restart: 'always',
        env: { PORT: '3000', DB_HOST: 'localhost' }
      });

      await addService({ cwd: tmpDir });

      const unitPath = path.join(getUserUnitDir(), 'unitup-reflect-service.service');
      assert.equal(fs.existsSync(unitPath), true);

      let content = fs.readFileSync(unitPath, 'utf8');
      assert.match(content, /Restart=always/);
      assert.match(content, /Environment=PORT="3000"/);
      assert.match(content, /Environment=DB_HOST="localhost"/);

      let meta = readAppMetadata('reflect-service');
      assert.equal(meta.name, 'reflect-service');

      // 2. Modify config to v2
      saveProjectConfig(tmpDir, {
        name: 'reflect-service',
        script: 'server.js',
        restart: 'on-failure',
        env: { PORT: '8080', DB_HOST: 'localhost', NODE_ENV: 'production' },
        resources: { memoryMax: '512M' }
      });

      // Re-add service with force
      await addService({ cwd: tmpDir, force: true });

      content = fs.readFileSync(unitPath, 'utf8');
      assert.match(content, /Restart=on-failure/);
      assert.match(content, /Environment=PORT="8080"/);
      assert.match(content, /Environment=NODE_ENV="production"/);
      assert.match(content, /MemoryMax=512M/);

      meta = readAppMetadata('reflect-service');
      assert.equal(meta.resources?.memoryMax || meta.memoryMax, '512M');
      assert.ok(executedCommands.some(c => c.cmd === 'systemctl' && c.args.includes('daemon-reload')));
    } finally {
      resetCommandRunner();
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  test('CLI Flag Precedence: explicit CLI flags override unitup.config.json fields', async () => {
    const executedCommands = [];
    const { setCommandRunner, resetCommandRunner, getUserUnitDir } = await import('../src/index.js');

    process.env.XDG_CONFIG_HOME = tmpDir;

    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return { code: 0, stdout: 'ActiveState=inactive\nSubState=dead\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    try {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log("override");', 'utf8');

      saveProjectConfig(tmpDir, {
        name: 'override-service',
        script: 'app.js',
        restart: 'on-failure',
        env: { PORT: '3000', DB: 'postgres' }
      });

      // Run CLI add with explicit --env PORT=9090 and --restart always
      await runCli(['add', '--cwd', tmpDir, '--env', 'PORT=9090', '--restart', 'always', '--memory-max', '1G']);

      const unitPath = path.join(getUserUnitDir(), 'unitup-override-service.service');
      assert.equal(fs.existsSync(unitPath), true);

      const content = fs.readFileSync(unitPath, 'utf8');
      assert.match(content, /Environment=PORT="9090"/); // CLI overridden
      assert.match(content, /Environment=DB="postgres"/); // Config retained
      assert.match(content, /Restart=always/); // CLI overridden
      assert.match(content, /MemoryMax=1G/); // CLI overridden
    } finally {
      resetCommandRunner();
      delete process.env.XDG_CONFIG_HOME;
    }
  });

  test('Active Service Config Update: force re-adding active service restarts it to apply new unit config', async () => {
    const executedCommands = [];
    const { setCommandRunner, resetCommandRunner, addService } = await import('../src/index.js');

    process.env.XDG_CONFIG_HOME = tmpDir;

    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return { code: 0, stdout: 'ActiveState=active\nSubState=running\nMainPID=1234\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    try {
      const scriptPath = path.join(tmpDir, 'worker.js');
      fs.writeFileSync(scriptPath, 'console.log("worker");', 'utf8');

      saveProjectConfig(tmpDir, {
        name: 'active-worker',
        script: 'worker.js',
        env: { WORKERS: '2' }
      });

      // Initial add
      await addService({ cwd: tmpDir, force: true });

      executedCommands.length = 0;

      // Update config and force re-add while service is active
      saveProjectConfig(tmpDir, {
        name: 'active-worker',
        script: 'worker.js',
        env: { WORKERS: '8' }
      });

      await addService({ cwd: tmpDir, force: true });

      // Verify daemon-reload was executed AND systemctl restart unitup-active-worker.service was invoked
      assert.ok(executedCommands.some(c => c.cmd === 'systemctl' && c.args.includes('daemon-reload')));
      assert.ok(executedCommands.some(c => c.cmd === 'systemctl' && c.args.includes('restart') && c.args.includes('unitup-active-worker.service')));
    } finally {
      resetCommandRunner();
      delete process.env.XDG_CONFIG_HOME;
    }
  });
});
