import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseArgs, runCli } from '../src/cli.js';
import {
  addService,
  detectRuntime,
  getDoctorInfo,
  getUnitPath,
  getUserUnitDir,
  inspectService,
  listServices,
  parseUnitContent,
  resetCommandRunner,
  resolveRuntimeConfig,
  setCommandRunner
} from '../src/index.js';
import { readAppMetadata, saveAppMetadata } from '../src/utils.js';

test('Multi-Runtime & Generic Executable Systemd Manager Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-runtimes-test-'));
  const originalXdgConfig = process.env.XDG_CONFIG_HOME;
  const originalPath = process.env.PATH;

  process.env.XDG_CONFIG_HOME = tmpDir;

  // Create mock PATH binaries so adapter resolution passes
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const mockBinaries = ['node', 'python3', 'python', 'ruby', 'php', 'bun', 'deno', 'bash', 'sh', 'go', 'elixir'];
  for (const b of mockBinaries) {
    const p = path.join(binDir, b);
    fs.writeFileSync(p, '#!/bin/sh\necho "v1.0.0"');
    fs.chmodSync(p, 0o755);
  }

  process.env.PATH = `${binDir}${path.delimiter}${originalPath || ''}`;

  t.after(() => {
    if (originalXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    } else {
      delete process.env.PATH;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetCommandRunner();
  });

  // Mock systemctl commands
  setCommandRunner(async (cmd, args) => {
    if (cmd === 'systemctl') {
      if (args.includes('show')) {
        return {
          code: 0,
          stdout:
            'ActiveState=active\nSubState=running\nMainPID=14220\nNRestarts=0\nActiveEnterTimestamp=Mon 2026-07-26 12:00:00 UTC',
          stderr: ''
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'which' || cmd === 'where') {
      return { code: 0, stdout: path.join(binDir, args[0]) + '\n', stderr: '' };
    }
    return { code: 0, stdout: 'v1.0.0\n', stderr: '' };
  });

  await t.test('Node.js backward compatibility and legacy metadata normalization', async () => {
    const script = path.join(tmpDir, 'server.js');
    fs.writeFileSync(script, 'console.log("hello node");');

    const res = await addService({
      name: 'node-app',
      script,
      group: 'backend'
    });

    assert.equal(res.name, 'node-app');
    const unitContent = fs.readFileSync(res.unitPath, 'utf8');
    assert.ok(unitContent.includes('ExecStart='));
    assert.ok(unitContent.includes(script));

    // Save legacy metadata manually: { node, script }
    const appsDir = path.join(tmpDir, 'unitup', 'apps');
    fs.mkdirSync(appsDir, { recursive: true });
    const legacyPath = path.join(appsDir, 'legacy-app.json');
    fs.writeFileSync(
      legacyPath,
      JSON.stringify({
        name: 'legacy-app',
        unit: 'unitup-legacy-app.service',
        node: '/usr/bin/node',
        script: '/home/user/server.js',
        group: 'default'
      })
    );

    const normalized = readAppMetadata('legacy-app');
    assert.equal(normalized.runtime, 'node');
    assert.equal(normalized.command, '/usr/bin/node');
    assert.deepEqual(normalized.args, ['/home/user/server.js']);
    assert.equal(normalized.script, '/home/user/server.js');
    assert.equal(normalized.node, '/usr/bin/node');
  });

  await t.test('Python runtime auto-detection by .py extension', async () => {
    const script = path.join(tmpDir, 'worker.py');
    fs.writeFileSync(script, 'print("worker")');

    const detected = detectRuntime(script);
    assert.equal(detected, 'python');

    const res = await addService({
      name: 'py-worker',
      script,
      runtime: 'python'
    });

    const meta = readAppMetadata('py-worker');
    assert.equal(meta.runtime, 'python');
    assert.ok(meta.command.includes('python'));
    assert.equal(meta.args[0], script);
  });

  await t.test('Shebang header runtime detection', async () => {
    const pyShebangScript = path.join(tmpDir, 'task_py');
    fs.writeFileSync(pyShebangScript, '#!/usr/bin/env python3\nprint("hi")');

    const rubyShebangScript = path.join(tmpDir, 'task_rb');
    fs.writeFileSync(rubyShebangScript, '#!/usr/bin/env ruby\nputs "hi"');

    const bashShebangScript = path.join(tmpDir, 'task_sh');
    fs.writeFileSync(bashShebangScript, '#!/bin/bash\necho "hi"');

    assert.equal(detectRuntime(pyShebangScript), 'python');
    assert.equal(detectRuntime(rubyShebangScript), 'ruby');
    assert.equal(detectRuntime(bashShebangScript), 'shell');
  });

  await t.test('Ruby, PHP, Shell, Go, and Elixir extensions auto-detection', async () => {
    assert.equal(detectRuntime('/tmp/app.rb'), 'ruby');
    assert.equal(detectRuntime('/tmp/index.php'), 'php');
    assert.equal(detectRuntime('/tmp/run.sh'), 'shell');
    assert.equal(detectRuntime('/tmp/main.go'), 'go');
    assert.equal(detectRuntime('/tmp/app.ex'), 'elixir');
    assert.equal(detectRuntime('/tmp/app.exs'), 'elixir');
  });

  await t.test('Go and Elixir runtime adapter creation', async () => {
    const goFile = path.join(tmpDir, 'main.go');
    fs.writeFileSync(goFile, 'package main');
    const goRes = await addService({ name: 'go-app', script: goFile });
    const goMeta = readAppMetadata('go-app');
    assert.equal(goMeta.runtime, 'go');
    assert.deepEqual(goMeta.args, ['run', goFile]);

    const exFile = path.join(tmpDir, 'app.exs');
    fs.writeFileSync(exFile, 'IO.puts "hi"');
    const exRes = await addService({ name: 'ex-app', script: exFile });
    const exMeta = readAppMetadata('ex-app');
    assert.equal(exMeta.runtime, 'elixir');
    assert.deepEqual(exMeta.args, [exFile]);
  });

  await t.test('Ambiguous .ts file throws error requiring explicit runtime', async () => {
    const tsFile = path.join(tmpDir, 'server.ts');
    fs.writeFileSync(tsFile, 'console.log("ts");');

    assert.throws(
      () => detectRuntime(tsFile),
      (err) => {
        return (
          err.message.includes('Could not determine runtime for server.ts') &&
          err.message.includes('--runtime bun') &&
          err.message.includes('--runtime deno') &&
          err.message.includes('--runtime node')
        );
      }
    );
  });

  await t.test('Bun and Deno selection for TypeScript files', async () => {
    const tsFile = path.join(tmpDir, 'server.ts');
    fs.writeFileSync(tsFile, 'console.log("ts");');

    const bunRes = await addService({
      name: 'ts-bun',
      script: tsFile,
      runtime: 'bun'
    });
    const bunMeta = readAppMetadata('ts-bun');
    assert.equal(bunMeta.runtime, 'bun');

    const denoRes = await addService({
      name: 'ts-deno',
      script: tsFile,
      runtime: 'deno'
    });
    const denoMeta = readAppMetadata('ts-deno');
    assert.equal(denoMeta.runtime, 'deno');
    assert.equal(denoMeta.args[0], 'run');
  });

  await t.test('Deno runtime arguments ordering: deno run --allow-net --allow-env script.ts', async () => {
    const tsFile = path.join(tmpDir, 'server.ts');
    fs.writeFileSync(tsFile, 'console.log("ts");');

    const res = await addService({
      name: 'deno-server',
      script: tsFile,
      runtime: 'deno',
      runtimeArgs: ['--allow-net', '--allow-env']
    });

    const meta = readAppMetadata('deno-server');
    assert.equal(meta.runtime, 'deno');
    assert.deepEqual(meta.args, ['run', '--allow-net', '--allow-env', tsFile]);

    const unitContent = fs.readFileSync(res.unitPath, 'utf8');
    assert.ok(unitContent.includes('ExecStart='));
    assert.ok(unitContent.includes('run --allow-net --allow-env'));
  });

  await t.test('PHP runtime arguments: php -S 0.0.0.0:8080 index.php', async () => {
    const phpFile = path.join(tmpDir, 'index.php');
    fs.writeFileSync(phpFile, '<?php echo "hi";');

    const res = await addService({
      name: 'php-server',
      script: phpFile,
      runtime: 'php',
      runtimeArgs: ['-S', '0.0.0.0:8080']
    });

    const meta = readAppMetadata('php-server');
    assert.equal(meta.runtime, 'php');
    assert.deepEqual(meta.args, ['-S', '0.0.0.0:8080', phpFile]);
  });

  await t.test('Native executable permission check and error handling', async () => {
    const binFile = path.join(tmpDir, 'native-app');
    fs.writeFileSync(binFile, '#!/bin/sh\necho "native"');

    // Make executable
    fs.chmodSync(binFile, 0o755);

    const res = await addService({
      name: 'native-api',
      script: binFile,
      runtime: 'native'
    });

    const meta = readAppMetadata('native-api');
    assert.equal(meta.runtime, 'native');
    assert.equal(meta.command, binFile);

    // Make non-executable
    fs.chmodSync(binFile, 0o644);

    await assert.rejects(
      async () => {
        await addService({
          name: 'native-fail',
          script: binFile,
          runtime: 'native'
        });
      },
      (err) => {
        return err.message.includes('The executable is not runnable') && err.message.includes('chmod +x');
      }
    );
  });

  await t.test('Generic --command usage without runtime auto-detection', async () => {
    const pyScript = path.join(tmpDir, 'worker.py');
    fs.writeFileSync(pyScript, 'print("generic")');

    const res = await addService({
      name: 'generic-worker',
      command: path.join(binDir, 'python3'),
      args: [pyScript, '--port', '3000']
    });

    const meta = readAppMetadata('generic-worker');
    assert.equal(meta.command, path.join(binDir, 'python3'));
    assert.deepEqual(meta.args, [pyScript, '--port', '3000']);

    const unitContent = fs.readFileSync(res.unitPath, 'utf8');
    assert.ok(unitContent.includes('ExecStart=' + path.join(binDir, 'python3') + ' ' + pyScript + ' --port 3000'));
  });

  await t.test('CLI add command with generic flags', async () => {
    const pyScript = path.join(tmpDir, 'cli_worker.py');
    fs.writeFileSync(pyScript, 'print("cli")');

    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    try {
      await runCli([
        'add',
        '--name',
        'worker-cli',
        '--command',
        path.join(binDir, 'python3'),
        '--arg',
        pyScript,
        '--arg',
        '--port',
        '--arg',
        '3000'
      ]);
    } finally {
      console.log = origLog;
    }

    assert.ok(logs.some((l) => l.includes('Service "worker-cli" created')));
    const meta = readAppMetadata('worker-cli');
    assert.equal(meta.command, path.join(binDir, 'python3'));
    assert.deepEqual(meta.args, [pyScript, '--port', '3000']);
  });

  await t.test('CLI list and inspect outputs', async () => {
    const listRes = await listServices();
    assert.ok(listRes.length > 0);
    assert.ok(listRes.every((item) => 'runtime' in item && 'command' in item));

    const pyWorkerInspect = await inspectService('generic-worker');
    assert.equal(pyWorkerInspect.name, 'generic-worker');
    assert.equal(pyWorkerInspect.command, path.join(binDir, 'python3'));
    assert.ok(pyWorkerInspect.arguments.includes('worker.py'));
  });

  await t.test('Doctor command lists detected runtimes', async () => {
    const info = await getDoctorInfo();
    assert.ok('runtimes' in info);
    assert.ok('Node.js' in info.runtimes);
    assert.ok('Python' in info.runtimes);
    assert.ok('Ruby' in info.runtimes);
    assert.ok('PHP' in info.runtimes);
    assert.ok('Bun' in info.runtimes);
    assert.ok('Go' in info.runtimes);
    assert.ok('Elixir' in info.runtimes);
  });

  await t.test('resolves relative script path against opts.cwd instead of process.cwd()', async () => {
    const projectSubdir = path.join(tmpDir, 'my_isolated_project');
    fs.mkdirSync(projectSubdir, { recursive: true });
    const targetScript = path.join(projectSubdir, 'server.js');
    fs.writeFileSync(targetScript, 'console.log("isolated");');

    const res = await resolveRuntimeConfig({
      script: 'server.js',
      cwd: projectSubdir,
      runtime: 'node'
    });

    assert.equal(res.args[0], targetScript);
    assert.notEqual(res.args[0], path.resolve(process.cwd(), 'server.js'));
  });
});
