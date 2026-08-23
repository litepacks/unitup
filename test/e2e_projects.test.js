import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { runCli } from '../src/cli.js';
import {
  addService,
  getUnitPath,
  inspectService,
  listServices,
  parseUnitContent,
  removeService,
  resetCommandRunner,
  setCommandRunner
} from '../src/index.js';
import { readAppMetadata, readProjectConfig, saveProjectConfig } from '../src/utils.js';

describe('Multi-Project End-to-End (E2E) Isolation Suite', () => {
  let tmpRoot;
  let projAlpha;
  let projBeta;
  let projGamma;
  let runnerCalls;
  let origCwd;
  let origXdgConfig;

  beforeEach(() => {
    origCwd = process.cwd();
    origXdgConfig = process.env.XDG_CONFIG_HOME;

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-e2e-root-'));
    process.env.XDG_CONFIG_HOME = tmpRoot;

    // Create 3 distinct simulated generic test project folders
    projAlpha = path.join(tmpRoot, 'alpha_app');
    projBeta = path.join(tmpRoot, 'beta_app');
    projGamma = path.join(tmpRoot, 'gamma_app');

    fs.mkdirSync(projAlpha, { recursive: true });
    fs.mkdirSync(projBeta, { recursive: true });
    fs.mkdirSync(projGamma, { recursive: true });

    fs.writeFileSync(path.join(projAlpha, 'server.js'), 'console.log("Alpha App");');
    fs.writeFileSync(path.join(projBeta, 'server.js'), 'console.log("Beta App");');
    fs.writeFileSync(path.join(projGamma, 'main.py'), 'print("Gamma App")');

    runnerCalls = [];
    setCommandRunner(async (cmd, args) => {
      runnerCalls.push({ cmd, args: args.join(' ') });
      return { code: 0, stdout: 'active', stderr: '' };
    });
  });

  afterEach(() => {
    resetCommandRunner();
    process.chdir(origCwd);
    if (origXdgConfig !== undefined) {
      process.env.XDG_CONFIG_HOME = origXdgConfig;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }
    if (fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('E2E: Programmatic addService from external cwd isolates script path per project', async () => {
    // Change current working directory of Node process to projBeta
    process.chdir(projBeta);

    // Add service for projAlpha while process.cwd() is projBeta
    const resA = await addService({
      name: 'alpha-service',
      script: 'server.js',
      cwd: projAlpha,
      env: { PORT: '3538' }
    });

    assert.equal(resA.name, 'alpha-service');

    // Read generated unit content
    const unitFile = getUnitPath('alpha-service');
    assert.equal(fs.existsSync(unitFile), true);
    const unitContent = fs.readFileSync(unitFile, 'utf8');

    const realProjAlpha = fs.realpathSync(projAlpha);
    const realProjBeta = fs.realpathSync(projBeta);

    // ExecStart MUST point to projAlpha/server.js, NOT process.cwd() (projBeta/server.js)
    assert.ok(unitContent.includes('server.js'), 'Unit file ExecStart should contain server.js');
    assert.ok(
      unitContent.includes(realProjAlpha) || unitContent.includes(projAlpha),
      'Unit file ExecStart should contain projAlpha path'
    );
    assert.ok(
      !unitContent.includes(realProjBeta) && !unitContent.includes(projBeta),
      'Unit file ExecStart should NOT contain projBeta path'
    );

    // WorkingDirectory MUST be projAlpha
    const parsed = parseUnitContent(unitContent);
    assert.equal(fs.realpathSync(parsed.cwd), realProjAlpha);

    // Verify metadata
    const metaA = readAppMetadata('alpha-service');
    assert.equal(fs.realpathSync(metaA.cwd), realProjAlpha);
    assert.equal(fs.realpathSync(metaA.args[0]), path.join(realProjAlpha, 'server.js'));
  });

  test('E2E: Adding multiple projects sequentially preserves individual project paths', async () => {
    // Change process.cwd() to root folder
    process.chdir(tmpRoot);

    // Add projAlpha
    await addService({
      name: 'project-alpha',
      script: 'server.js',
      cwd: projAlpha
    });

    // Add projBeta
    await addService({
      name: 'project-beta',
      script: 'server.js',
      cwd: projBeta
    });

    // Add projGamma
    await addService({
      name: 'project-gamma',
      script: 'main.py',
      cwd: projGamma,
      runtime: 'python'
    });

    const parsedA = parseUnitContent(fs.readFileSync(getUnitPath('project-alpha'), 'utf8'));
    const parsedB = parseUnitContent(fs.readFileSync(getUnitPath('project-beta'), 'utf8'));
    const parsedC = parseUnitContent(fs.readFileSync(getUnitPath('project-gamma'), 'utf8'));

    assert.equal(fs.realpathSync(parsedA.cwd), fs.realpathSync(projAlpha));
    assert.equal(fs.realpathSync(parsedB.cwd), fs.realpathSync(projBeta));
    assert.equal(fs.realpathSync(parsedC.cwd), fs.realpathSync(projGamma));

    assert.ok(parsedA.script.includes('server.js'));
    assert.ok(parsedB.script.includes('server.js'));
    assert.ok(parsedC.script.includes('main.py'));

    assert.equal(fs.realpathSync(path.dirname(parsedA.script)), fs.realpathSync(projAlpha));
    assert.equal(fs.realpathSync(path.dirname(parsedB.script)), fs.realpathSync(projBeta));
    assert.equal(fs.realpathSync(path.dirname(parsedC.script)), fs.realpathSync(projGamma));
  });

  test('E2E: CLI init and add in isolated project folders', async () => {
    // Navigate to projAlpha and init + add
    process.chdir(projAlpha);
    await runCli(['init', 'server.js', '--name', 'proj-alpha-service', '--memory-max', '512M']);
    assert.equal(fs.existsSync(path.join(projAlpha, 'unitup.config.json')), true);

    await runCli(['add']);

    // Navigate to projBeta and init + add
    process.chdir(projBeta);
    await runCli(['init', 'server.js', '--name', 'proj-beta-service', '--memory-max', '1G']);
    assert.equal(fs.existsSync(path.join(projBeta, 'unitup.config.json')), true);

    await runCli(['add']);

    // Inspect services from another directory
    process.chdir(tmpRoot);
    const inspectA = await inspectService('proj-alpha-service');
    const inspectB = await inspectService('proj-beta-service');

    assert.equal(fs.realpathSync(inspectA.cwd), fs.realpathSync(projAlpha));
    assert.ok(
      inspectA.arguments.includes(path.join(fs.realpathSync(projAlpha), 'server.js')) ||
        inspectA.arguments.includes(path.join(projAlpha, 'server.js'))
    );

    assert.equal(fs.realpathSync(inspectB.cwd), fs.realpathSync(projBeta));
    assert.ok(
      inspectB.arguments.includes(path.join(fs.realpathSync(projBeta), 'server.js')) ||
        inspectB.arguments.includes(path.join(projBeta, 'server.js'))
    );
  });
});
