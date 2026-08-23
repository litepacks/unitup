import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { runCli } from '../src/cli.js';
import {
  createSchedule,
  createService,
  detectRuntime,
  generateTimerContent,
  getAllServicesMemoryUsage,
  getDoctorInfo,
  getScheduleStatus,
  getServiceFailures,
  getServiceMemoryUsage,
  getServiceNameFromUnit,
  getServiceStatus,
  getTimerFilename,
  getUnitFilename,
  getUserUnitDir,
  inspectService,
  listSchedules,
  listServices,
  parseUnitContent,
  readAppMetadata,
  readProjectConfig,
  readScheduleMetadata,
  removeService,
  resetCommandRunner,
  resolveRuntimeConfig,
  sanitizeServiceName,
  saveProjectConfig,
  setCommandRunner,
  setServiceLimits,
  unitFileExists,
  validateDuration,
  validateMemorySize
} from '../src/index.js';

describe('unitup Comprehensive Contract Test Suite', () => {
  let tmpDir;
  let executedCommands = [];
  let originalExitCode;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-contract-test-'));
    process.env.XDG_CONFIG_HOME = tmpDir;
    executedCommands = [];
    originalExitCode = process.exitCode;
    process.exitCode = undefined;

    setCommandRunner(async (cmd, args) => {
      executedCommands.push({ cmd, args });
      if (cmd === 'systemctl' && args.includes('show')) {
        return {
          code: 0,
          stdout:
            [
              'ActiveState=active',
              'SubState=running',
              'MainPID=9999',
              'NRestarts=2',
              'ActiveEnterTimestamp=2026-08-01 12:00:00 UTC',
              'UnitFileState=enabled',
              'Result=success',
              'ExecMainCode=0'
            ].join('\n') + '\n',
          stderr: ''
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
  });

  afterEach(() => {
    delete process.env.XDG_CONFIG_HOME;
    resetCommandRunner();
    process.exitCode = originalExitCode;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('1. Programmatic JS API Return Object Contract', () => {
    test('createService returns object satisfying AddServiceResult contract', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log("contract test");');

      const res = await createService({
        name: 'contract-app',
        script: scriptPath
      });

      assert.equal(typeof res, 'object');
      assert.equal(typeof res.name, 'string');
      assert.equal(res.name, 'contract-app');
      assert.equal(typeof res.unitPath, 'string');
      assert.ok(res.unitPath.endsWith('unitup-contract-app.service'));
    });

    test('getServiceStatus returns object satisfying ServiceStatus contract', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log("contract test");');

      await createService({
        name: 'status-contract',
        script: scriptPath
      });

      const status = await getServiceStatus('status-contract');

      assert.equal(typeof status.name, 'string');
      assert.equal(status.name, 'status-contract');
      assert.equal(typeof status.unitFile, 'string');
      assert.equal(status.unitFile, 'unitup-status-contract.service');
      assert.equal(typeof status.status, 'string');
      assert.equal(typeof status.activeState, 'string');
      assert.equal(typeof status.subState, 'string');
      assert.equal(typeof status.pid, 'string');
      assert.equal(typeof status.restarts, 'string');
      assert.equal(typeof status.started, 'string');
      assert.equal(typeof status.command, 'string');
      assert.equal(typeof status.cwd, 'string');
      assert.ok(Array.isArray(status.args));
    });

    test('listServices returns array satisfying ListServiceItem contract', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log("contract test");');

      await createService({
        name: 'list-contract',
        group: 'web',
        script: scriptPath
      });

      const list = await listServices();
      assert.ok(Array.isArray(list));
      assert.ok(list.length >= 1);

      const item = list.find((s) => s.name === 'list-contract');
      assert.ok(item);
      assert.equal(typeof item.name, 'string');
      assert.equal(typeof item.runtime, 'string');
      assert.equal(typeof item.group, 'string');
      assert.equal(item.group, 'web');
      assert.equal(typeof item.status, 'string');
      assert.equal(typeof item.enabled, 'string');
      assert.equal(typeof item.pid, 'string');
      assert.equal(typeof item.command, 'string');
      assert.equal(typeof item.uptime, 'string');
      assert.equal(typeof item.restarts, 'string');
    });

    test('inspectService returns object satisfying InspectInfo contract', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log("contract test");');

      await createService({
        name: 'inspect-contract',
        script: scriptPath,
        memoryHigh: '256M',
        memoryMax: '512M'
      });

      const info = await inspectService('inspect-contract');

      assert.equal(typeof info.name, 'string');
      assert.equal(info.name, 'inspect-contract');
      assert.equal(typeof info.runtime, 'string');
      assert.equal(typeof info.unit, 'string');
      assert.equal(typeof info.unitPath, 'string');
      assert.equal(typeof info.group, 'string');
      assert.equal(typeof info.status, 'string');
      assert.equal(typeof info.activeState, 'string');
      assert.equal(typeof info.subState, 'string');
      assert.equal(typeof info.command, 'string');
      assert.equal(typeof info.cwd, 'string');
      assert.equal(typeof info.pid, 'string');
      assert.equal(typeof info.restarts, 'string');
      assert.equal(info.memoryHigh, '256 MB');
      assert.equal(info.memoryMax, '512 MB');
    });

    test('createSchedule returns object satisfying CreateScheduleResult contract', async () => {
      const scriptPath = path.join(tmpDir, 'job.js');
      fs.writeFileSync(scriptPath, 'console.log("job");');

      const result = await createSchedule({
        name: 'cron-contract',
        script: scriptPath,
        every: '15m'
      });

      assert.equal(typeof result.name, 'string');
      assert.equal(result.name, 'cron-contract');
      assert.equal(typeof result.group, 'string');
      assert.equal(typeof result.type, 'string');
      assert.equal(typeof result.runtime, 'string');
      assert.equal(typeof result.command, 'string');
      assert.equal(typeof result.cwd, 'string');
      assert.equal(typeof result.serviceUnit, 'string');
      assert.equal(typeof result.timerUnit, 'string');
      assert.equal(typeof result.servicePath, 'string');
      assert.equal(typeof result.timerPath, 'string');
      assert.equal(typeof result.schedule, 'object');
    });

    test('getDoctorInfo returns object satisfying DoctorInfo contract', async () => {
      const doc = await getDoctorInfo();

      assert.equal(typeof doc.linux, 'boolean');
      assert.equal(typeof doc.systemctl, 'boolean');
      assert.equal(typeof doc.systemdRunning, 'boolean');
      assert.equal(typeof doc.userSystemdAvailable, 'boolean');
      assert.equal(typeof doc.nodeDiag, 'object');
      assert.equal(typeof doc.nodePath, 'string');
      assert.equal(typeof doc.nodeVersion, 'string');
      assert.equal(typeof doc.runtimes, 'object');
      assert.equal(typeof doc.unitDir, 'string');
      assert.equal(typeof doc.lingering, 'boolean');
      assert.equal(typeof doc.username, 'string');
    });
  });

  describe('2. Systemd Unit File Specification Contract', () => {
    test('generated .service unit files contain required sections and parameters', async () => {
      const scriptPath = path.join(tmpDir, 'service.js');
      fs.writeFileSync(scriptPath, 'console.log("service");');

      await createService({
        name: 'spec-service',
        script: scriptPath,
        restart: 'on-failure',
        env: { FOO: 'BAR', SENSITIVE: 'hello "world"' }
      });

      const unitPath = path.join(getUserUnitDir(), 'unitup-spec-service.service');
      const content = fs.readFileSync(unitPath, 'utf8');

      // Mandatory systemd sections
      assert.match(content, /^\[Unit\]/m);
      assert.match(content, /^\[Service\]/m);
      assert.match(content, /^\[Install\]/m);

      // Mandatory directives
      assert.match(content, /^Description=unitup service: spec-service/m);
      assert.match(content, /^WorkingDirectory=/m);
      assert.match(content, /^ExecStart=/m);
      assert.match(content, /^Restart=on-failure/m);
      assert.match(content, /^SyslogIdentifier=unitup-spec-service/m);
      assert.match(content, /^WantedBy=default\.target/m);
      assert.match(content, /^Environment=FOO="BAR"/m);
      assert.match(content, /^Environment=SENSITIVE="hello \\"world\\""/m);
    });

    test('generated .timer unit files contain required timer directives and target service', () => {
      const content = generateTimerContent({
        name: 'spec-timer',
        every: '1h',
        persistent: true,
        randomDelay: '5m'
      });

      assert.match(content, /^\[Unit\]/m);
      assert.match(content, /^\[Timer\]/m);
      assert.match(content, /^\[Install\]/m);

      assert.match(content, /^Unit=unitup-spec-timer.service/m);
      assert.match(content, /^OnUnitActiveSec=1h/m);
      assert.match(content, /^Persistent=true/m);
      assert.match(content, /^RandomizedDelaySec=5m/m);
      assert.match(content, /^WantedBy=timers.target/m);
    });

    test('unit file argument escaping prevents shell parameter ambiguity and dollar expansion', async () => {
      const scriptWithSpaces = path.join(tmpDir, 'path with spaces', 'app.js');
      fs.mkdirSync(path.dirname(scriptWithSpaces), { recursive: true });
      fs.writeFileSync(scriptWithSpaces, 'console.log(1);');

      await createService({
        name: 'escape-test',
        script: scriptWithSpaces,
        args: ['--msg="hello world"', 'foo$bar']
      });

      const unitPath = path.join(getUserUnitDir(), 'unitup-escape-test.service');
      const content = fs.readFileSync(unitPath, 'utf8');

      assert.match(content, /ExecStart=.*".*path with spaces.*app\.js" "--msg=\\"hello world\\"" foo\$bar/);
    });
  });

  describe('3. Configuration Schema & Metadata Contracts', () => {
    test('unitup.config.json read and write contract', () => {
      const configPath = saveProjectConfig(tmpDir, {
        name: 'config-contract-app',
        group: 'backend',
        script: './index.js',
        restart: 'always',
        resources: {
          memoryMax: '1G'
        }
      });

      assert.ok(fs.existsSync(configPath));
      const loaded = readProjectConfig(tmpDir);

      assert.equal(loaded.name, 'config-contract-app');
      assert.equal(loaded.group, 'backend');
      assert.equal(loaded.script, './index.js');
      assert.equal(loaded.restart, 'always');
      assert.equal(loaded.resources.memoryMax, '1G');
    });

    test('app metadata JSON contract stored in apps directory', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createService({
        name: 'meta-contract',
        group: 'test-group',
        script: scriptPath
      });

      const meta = readAppMetadata('meta-contract');
      assert.ok(meta);
      assert.equal(meta.name, 'meta-contract');
      assert.equal(meta.group, 'test-group');
      assert.equal(meta.unit, 'unitup-meta-contract.service');
      assert.equal(typeof meta.script, 'string');
      assert.equal(typeof meta.cwd, 'string');
    });

    test('schedule metadata JSON contract stored in schedules directory', async () => {
      const scriptPath = path.join(tmpDir, 'job.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createSchedule({
        name: 'meta-schedule',
        group: 'cron-group',
        script: scriptPath,
        every: '10m'
      });

      const meta = readScheduleMetadata('meta-schedule');
      assert.ok(meta);
      assert.equal(meta.name, 'meta-schedule');
      assert.equal(meta.group, 'cron-group');
      assert.equal(meta.type, 'timer');
      assert.equal(meta.schedule.every, '10m');
      assert.equal(meta.serviceUnit, 'unitup-meta-schedule.service');
      assert.equal(meta.timerUnit, 'unitup-meta-schedule.timer');
    });
  });

  describe('4. CLI Output & Exit Code Contracts', () => {
    test('CLI ls command contract outputs formatted table', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createService({
        name: 'cli-json-app',
        script: scriptPath
      });

      let cliOutput = '';
      const origLog = console.log;
      console.log = (msg) => {
        cliOutput += msg + '\n';
      };

      try {
        await runCli(['ls']);
      } finally {
        console.log = origLog;
      }

      assert.match(cliOutput, /NAME\s+RUNTIME\s+STATUS\s+PID\s+COMMAND/);
      assert.match(cliOutput, /cli-json-app/);
    });

    test('CLI inspect command contract outputs detailed formatted key-values', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createService({
        name: 'cli-inspect-app',
        script: scriptPath
      });

      let cliOutput = '';
      const origLog = console.log;
      console.log = (msg) => {
        cliOutput += msg + '\n';
      };

      try {
        await runCli(['inspect', 'cli-inspect-app']);
      } finally {
        console.log = origLog;
      }

      assert.match(cliOutput, /Name:\s+cli-inspect-app/);
      assert.match(cliOutput, /Unit:\s+unitup-cli-inspect-app\.service/);
    });

    test('Programmatic JSON serialization matches API contracts', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createService({
        name: 'api-serialize-app',
        script: scriptPath
      });

      const list = await listServices();
      const jsonStr = JSON.stringify(list);
      const parsed = JSON.parse(jsonStr);

      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.some((item) => item.name === 'api-serialize-app'));
    });

    test('CLI unknown command sets exitCode to 1', async () => {
      const origError = console.error;
      const origHelp = console.log;
      console.error = () => {};
      console.log = () => {};

      try {
        await runCli(['unknown-invalid-command']);
      } finally {
        console.error = origError;
        console.log = origHelp;
      }

      assert.equal(process.exitCode, 1);
    });
  });

  describe('5. Multi-Runtime Resolution Contracts', () => {
    test('detectRuntime resolves extensions accurately', () => {
      assert.equal(detectRuntime('index.js'), 'node');
      assert.equal(detectRuntime('app.py'), 'python');
      assert.equal(detectRuntime('main.rb'), 'ruby');
      assert.equal(detectRuntime('index.php'), 'php');
      assert.equal(detectRuntime('main.go'), 'go');
      assert.equal(detectRuntime('script.sh'), 'shell');
      assert.equal(detectRuntime('app.exs'), 'elixir');
    });

    test('ambiguous .ts extension contract throws error demanding explicit runtime', async () => {
      const tsPath = path.join(tmpDir, 'app.ts');
      fs.writeFileSync(tsPath, 'console.log("ts");');

      await assert.rejects(
        async () => await resolveRuntimeConfig({ script: tsPath }),
        /Could not determine runtime for app\.ts/
      );
    });

    test('explicit runtime override contract resolves command and args correctly', async () => {
      const pyPath = path.join(tmpDir, 'script.py');
      fs.writeFileSync(pyPath, 'print(1)');

      const resolved = await resolveRuntimeConfig({
        script: pyPath,
        runtime: 'python',
        runtimeArgs: ['-u'],
        args: ['--debug']
      });

      assert.equal(resolved.runtime, 'python');
      assert.ok(resolved.command.toLowerCase().includes('python'));
      assert.deepEqual(resolved.args, ['-u', pyPath, '--debug']);
    });
  });

  describe('6. Precondition & Validation Contracts', () => {
    test('sanitizeServiceName enforces strict naming rules and path traversal protection', () => {
      assert.equal(sanitizeServiceName('My Service App'), 'my-service-app');
      assert.equal(sanitizeServiceName('../../../etc/passwd'), 'etcpasswd');
      assert.equal(sanitizeServiceName('unitup-api.service'), 'api');

      assert.throws(() => sanitizeServiceName(''), /Service name must be a non-empty string/);
      assert.throws(() => sanitizeServiceName('!@#$%'), /Invalid service name/);
    });

    test('validateMemorySize contract accepts valid units and rejects invalid/unsafe strings', () => {
      assert.equal(validateMemorySize('512M'), '512M');
      assert.equal(validateMemorySize('1G'), '1G');
      assert.equal(validateMemorySize('2048K'), '2048K');
      assert.equal(validateMemorySize(1024), '1024');

      assert.throws(() => validateMemorySize('abc'), /Invalid Memory limit format/);
      assert.throws(() => validateMemorySize('-100M'), /cannot be negative/);
      assert.throws(() => validateMemorySize('512M; rm -rf /'), /contains invalid/);
    });

    test('validateDuration contract accepts valid durations and rejects invalid strings', () => {
      assert.equal(validateDuration('30s'), '30s');
      assert.equal(validateDuration('15m'), '15m');
      assert.equal(validateDuration('2h'), '2h');
      assert.equal(validateDuration('1d'), '1d');

      assert.throws(() => validateDuration('invalid'), /Invalid Duration format/);
      assert.throws(() => validateDuration('-5m'), /cannot be negative/);
    });

    test('createSchedule rejects simultaneous --every and --calendar options', async () => {
      const scriptPath = path.join(tmpDir, 'job.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await assert.rejects(
        async () =>
          await createSchedule({
            name: 'invalid-schedule',
            script: scriptPath,
            every: '10m',
            calendar: 'daily'
          }),
        /Cannot use both --every and --calendar/
      );
    });

    test('removeService contract blocks removal of active running service without force flag', async () => {
      const scriptPath = path.join(tmpDir, 'app.js');
      fs.writeFileSync(scriptPath, 'console.log(1);');

      await createService({
        name: 'active-protection',
        script: scriptPath
      });

      await assert.rejects(
        async () => await removeService('active-protection'),
        /Service "active-protection" is currently running/
      );

      // Succeeded when force option is true
      const result = await removeService('active-protection', { force: true });
      assert.equal(result, true);
    });
  });
});
