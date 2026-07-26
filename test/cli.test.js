import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/cli.js';

describe('cli.js argument parser', () => {
  test('parses basic add command and positional script path', () => {
    const res = parseArgs(['add', 'server.js']);
    assert.equal(res.command, 'add');
    assert.deepEqual(res.positionals, ['server.js']);
  });

  test('parses add command with full flags', () => {
    const res = parseArgs([
      'add',
      'server.js',
      '--name', 'api',
      '--node', '/usr/bin/node',
      '--cwd', './backend',
      '--env', 'NODE_ENV=production',
      '--env', 'PORT=3000',
      '--env-file', '.env',
      '--restart', 'always',
      '--arg', '--port',
      '--arg', '3000',
      '--start'
    ]);

    assert.equal(res.command, 'add');
    assert.deepEqual(res.positionals, ['server.js']);
    assert.equal(res.flags.name, 'api');
    assert.equal(res.flags.node, '/usr/bin/node');
    assert.equal(res.flags.cwd, './backend');
    assert.deepEqual(res.flags.env, ['NODE_ENV=production', 'PORT=3000']);
    assert.equal(res.flags.envFile, '.env');
    assert.equal(res.flags.restart, 'always');
    assert.deepEqual(res.flags.args, ['--port', '3000']);
    assert.equal(res.flags.start, true);
  });

  test('parses equal-sign syntax flags e.g. --name=api', () => {
    const res = parseArgs(['add', 'app.js', '--name=my-app', '--env=KEY=VAL']);
    assert.equal(res.flags.name, 'my-app');
    assert.deepEqual(res.flags.env, ['KEY=VAL']);
  });

  test('parses status flags e.g. --raw', () => {
    const res = parseArgs(['status', 'api', '--raw']);
    assert.equal(res.command, 'status');
    assert.deepEqual(res.positionals, ['api']);
    assert.equal(res.flags.raw, true);
  });

  test('parses start flags e.g. --enable', () => {
    const res = parseArgs(['start', 'api', '--enable']);
    assert.equal(res.command, 'start');
    assert.deepEqual(res.positionals, ['api']);
    assert.equal(res.flags.enable, true);
  });

  test('parses logs flags e.g. --follow, --lines, --cat, --output', () => {
    const res = parseArgs(['logs', 'api', '-f', '-n', '50', '-c', '--output=cat']);
    assert.equal(res.command, 'logs');
    assert.deepEqual(res.positionals, ['api']);
    assert.equal(res.flags.follow, true);
    assert.equal(res.flags.lines, 50);
    assert.equal(res.flags.cat, true);
    assert.equal(res.flags.output, 'cat');
  });

  test('parses doctor command', () => {
    const res = parseArgs(['doctor']);
    assert.equal(res.command, 'doctor');
  });
});
