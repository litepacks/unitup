import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSchedule,
  disableSchedule,
  enableSchedule,
  generateScheduleServiceContent,
  generateTimerContent,
  getScheduleStatus,
  getTimerPath,
  getUnitPath,
  getUserUnitDir,
  listSchedules,
  readScheduleMetadata,
  removeSchedule,
  resetCommandRunner,
  runSchedule,
  setCommandRunner,
  validateCalendar,
  validateDuration
} from '../src/index.js';

const testDir = path.join(os.tmpdir(), `unitup-schedule-test-${Date.now()}`);
const mockUnitDir = path.join(testDir, 'systemd', 'user');
const mockConfigDir = path.join(testDir, 'unitup');

test.before(() => {
  process.env.XDG_CONFIG_HOME = testDir;
  fs.mkdirSync(mockUnitDir, { recursive: true });
  fs.mkdirSync(mockConfigDir, { recursive: true });
});

test.after(() => {
  resetCommandRunner();
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

test('Duration validation rules', () => {
  assert.equal(validateDuration('30s'), '30s');
  assert.equal(validateDuration('10m'), '10m');
  assert.equal(validateDuration('2h'), '2h');
  assert.equal(validateDuration('1d'), '1d');

  assert.throws(() => validateDuration('-5m'), /cannot be negative/);
  assert.throws(() => validateDuration(''), /cannot be empty/);
  assert.throws(() => validateDuration('30s; rm -rf /'), /invalid characters or shell injection/);
  assert.throws(() => validateDuration('invalid'), /Invalid Duration format/);
});

test('--every timer generation', () => {
  const timerContent = generateTimerContent({
    name: 'cleanup',
    every: '30m'
  });

  assert.match(timerContent, /\[Timer\]/);
  assert.match(timerContent, /OnActiveSec=30m/);
  assert.match(timerContent, /OnUnitActiveSec=30m/);
  assert.match(timerContent, /Unit=unitup-cleanup\.service/);
  assert.match(timerContent, /WantedBy=timers\.target/);
});

test('--calendar timer generation', () => {
  const timerContent = generateTimerContent({
    name: 'backup',
    calendar: 'daily'
  });

  assert.match(timerContent, /OnCalendar=daily/);
  assert.match(timerContent, /Unit=unitup-backup\.service/);
});

test('Persistent=true, RandomizedDelaySec, OnBootSec support', () => {
  const timerContent = generateTimerContent({
    name: 'report',
    calendar: 'Mon..Fri 09:00',
    randomDelay: '10m',
    onBoot: '5m',
    persistent: true
  });

  assert.match(timerContent, /OnCalendar=Mon\.\.Fri 09:00/);
  assert.match(timerContent, /RandomizedDelaySec=10m/);
  assert.match(timerContent, /OnBootSec=5m/);
  assert.match(timerContent, /Persistent=true/);
});

test('Rejects both --every and --calendar in the same schedule', async () => {
  await assert.rejects(
    createSchedule({
      name: 'invalid-sched',
      script: './cleanup.js',
      every: '30m',
      calendar: 'daily'
    }),
    /Cannot use both --every and --calendar/
  );
});

test('Rejects schedule without any timing options', async () => {
  await assert.rejects(
    createSchedule({
      name: 'no-time-sched',
      script: './cleanup.js'
    }),
    /At least one scheduling option/
  );
});

test('Oneshot service unit generation', () => {
  const cwd = path.resolve('/home/user/apps');
  const script = path.resolve('/home/user/apps/cleanup.js');
  const command = path.resolve('/usr/bin/node');

  const serviceContent = generateScheduleServiceContent({
    name: 'cleanup',
    command,
    args: [script],
    cwd
  });

  assert.match(serviceContent, /Description=unitup scheduled task: cleanup/);
  assert.match(serviceContent, /Type=oneshot/);
  assert.ok(serviceContent.includes(`WorkingDirectory=${cwd}`));
  assert.doesNotMatch(serviceContent, /Restart=/);
});

test('createSchedule lifecycle and metadata storage', async () => {
  const executedCmds = [];
  setCommandRunner(async (cmd, args) => {
    executedCmds.push({ cmd, args });
    return { stdout: 'ActiveState=active\nSubState=waiting\n', stderr: '', code: 0 };
  });

  const dummyScript = path.join(testDir, 'cleanup.js');
  fs.writeFileSync(dummyScript, 'console.log("cleanup")', 'utf8');

  const res = await createSchedule({
    name: 'cleanup',
    script: dummyScript,
    every: '30m',
    persistent: true,
    group: 'backend',
    start: true
  });

  assert.equal(res.name, 'cleanup');
  assert.equal(res.group, 'backend');
  assert.equal(res.schedule.every, '30m');
  assert.equal(res.schedule.persistent, true);

  const serviceFile = getUnitPath('cleanup');
  const timerFile = getTimerPath('cleanup');

  assert.equal(fs.existsSync(serviceFile), true);
  assert.equal(fs.existsSync(timerFile), true);

  const meta = readScheduleMetadata('cleanup');
  assert.equal(meta.name, 'cleanup');
  assert.equal(meta.group, 'backend');
  assert.equal(meta.schedule.every, '30m');
  assert.equal(meta.serviceUnit, 'unitup-cleanup.service');
  assert.equal(meta.timerUnit, 'unitup-cleanup.timer');

  // Verify systemctl commands run on start
  assert.ok(executedCmds.some((c) => c.args.includes('daemon-reload')));
  assert.ok(executedCmds.some((c) => c.args.includes('enable') && c.args.includes('unitup-cleanup.timer')));
  assert.ok(executedCmds.some((c) => c.args.includes('start') && c.args.includes('unitup-cleanup.timer')));
});

test('Manual schedule-run only starts service unit', async () => {
  const executedCmds = [];
  setCommandRunner(async (cmd, args) => {
    executedCmds.push({ cmd, args });
    return { stdout: '', stderr: '', code: 0 };
  });

  await runSchedule('cleanup');

  assert.equal(executedCmds.length, 1);
  assert.equal(executedCmds[0].cmd, 'systemctl');
  assert.deepEqual(executedCmds[0].args, ['--user', 'start', 'unitup-cleanup.service']);
});

test('enableSchedule and disableSchedule', async () => {
  const executedCmds = [];
  setCommandRunner(async (cmd, args) => {
    executedCmds.push({ cmd, args });
    return { stdout: '', stderr: '', code: 0 };
  });

  await enableSchedule('cleanup');
  assert.ok(executedCmds.some((c) => c.args.includes('enable') && c.args.includes('--now')));

  await disableSchedule('cleanup');
  assert.ok(executedCmds.some((c) => c.args.includes('disable') && c.args.includes('--now')));
});

test('listSchedules and getScheduleStatus', async () => {
  setCommandRunner(async (cmd, args) => {
    if (args.includes('show') && args.includes('unitup-cleanup.timer')) {
      return {
        stdout:
          'ActiveState=active\nSubState=waiting\nNextElapseUSecRealtime=1700000000000000\nLastTriggerUSec=1699990000000000\n',
        stderr: '',
        code: 0
      };
    }
    if (args.includes('show') && args.includes('unitup-cleanup.service')) {
      return { stdout: 'ActiveState=inactive\nSubState=dead\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });

  const status = await getScheduleStatus('cleanup');
  assert.equal(status.name, 'cleanup');
  assert.equal(status.group, 'backend');
  assert.equal(status.schedule, 'every 30m');

  const list = await listSchedules();
  assert.ok(list.some((s) => s.name === 'cleanup'));
});

test('removeSchedule lifecycle with force flag check', async () => {
  const isServiceRunning = true;
  const executedCmds = [];

  setCommandRunner(async (cmd, args) => {
    executedCmds.push({ cmd, args });
    if (args.includes('is-active')) {
      return { stdout: isServiceRunning ? 'active' : 'inactive', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  });

  // Attempt remove without force when running should throw
  await assert.rejects(removeSchedule('cleanup', { force: false }), /currently running/);

  // Remove with force should succeed and delete files
  await removeSchedule('cleanup', { force: true });

  const serviceFile = getUnitPath('cleanup');
  const timerFile = getTimerPath('cleanup');

  assert.equal(fs.existsSync(serviceFile), false);
  assert.equal(fs.existsSync(timerFile), false);
  assert.equal(readScheduleMetadata('cleanup'), null);
});

test('Shell injection prevention in schedule arguments and names', async () => {
  assert.throws(() => validateDuration('10m; rm -rf /'), /invalid characters or shell injection/);

  await assert.rejects(validateCalendar('daily; reboot'), /invalid characters or shell injection/);
});

test('createSchedule with memory limits', async () => {
  const dummyScript = path.join(testDir, 'mem_job.js');
  fs.writeFileSync(dummyScript, 'console.log("mem")', 'utf8');

  await createSchedule({
    name: 'mem-job',
    script: dummyScript,
    every: '1h',
    memoryHigh: '256M',
    memoryMax: '512M'
  });

  const serviceContent = fs.readFileSync(getUnitPath('mem-job'), 'utf8');
  assert.match(serviceContent, /MemoryAccounting=yes/);
  assert.match(serviceContent, /MemoryHigh=256M/);
  assert.match(serviceContent, /MemoryMax=512M/);

  const meta = readScheduleMetadata('mem-job');
  assert.equal(meta.resources.memoryHigh, '256M');
  assert.equal(meta.resources.memoryMax, '512M');
});

test('createSchedule with command uses process.cwd as WorkingDirectory fallback', async () => {
  await createSchedule({
    name: 'cmd-job',
    command: '/bin/bash',
    args: ['-c', 'echo hello'],
    every: '5m'
  });

  const serviceContent = fs.readFileSync(getUnitPath('cmd-job'), 'utf8');
  assert.match(serviceContent, new RegExp(`WorkingDirectory=${process.cwd().replace(/\\/g, '\\\\')}`));

  const meta = readScheduleMetadata('cmd-job');
  assert.equal(meta.runtime, 'custom');
});

test('readScheduleMetadata normalizes legacy metadata with node runtime for custom command', async () => {
  const schedulesDir = path.join(mockConfigDir, 'schedules');
  if (!fs.existsSync(schedulesDir)) {
    fs.mkdirSync(schedulesDir, { recursive: true });
  }
  const legacyMetaPath = path.join(schedulesDir, 'legacy-cmd.json');
  fs.writeFileSync(
    legacyMetaPath,
    JSON.stringify({
      name: 'legacy-cmd',
      command: '/bin/bash',
      runtime: 'node'
    }),
    'utf8'
  );

  const meta = readScheduleMetadata('legacy-cmd');
  assert.ok(meta);
  assert.equal(meta.runtime, 'custom');
});
