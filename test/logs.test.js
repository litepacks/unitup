import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { readServiceLogs } from '../src/logs.js';

describe('Cross-Platform Logs Reader Suite', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitup-logs-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('returns "No logs found." when log files do not exist', async () => {
    const res = await readServiceLogs(path.join(tmpDir, 'non-existent.log'));
    assert.equal(res, 'No logs found.');
  });

  test('reads and combines stdout and stderr logs, returning last N lines', async () => {
    const stdout = path.join(tmpDir, 'app.log');
    const stderr = path.join(tmpDir, 'app-error.log');

    fs.writeFileSync(stdout, 'line 1\nline 2\nline 3\nline 4\nline 5\n');
    fs.writeFileSync(stderr, 'err 1\nerr 2\n');

    const allLogs = await readServiceLogs([stdout, stderr], { lines: 4 });
    const lines = allLogs.split('\n');
    assert.equal(lines.length, 4);
    assert.equal(lines[lines.length - 1], 'err 2');
  });

  test('filters lines matching grep regex', async () => {
    const stdout = path.join(tmpDir, 'filter.log');
    fs.writeFileSync(stdout, 'INFO: server started\nDEBUG: cache warm\nERROR: db timeout\nINFO: ready\n');

    const errorLogs = await readServiceLogs(stdout, { grep: 'ERROR' });
    assert.equal(errorLogs, 'ERROR: db timeout');
  });

  test('formats logs as JSON when json: true', async () => {
    const stdout = path.join(tmpDir, 'json.log');
    fs.writeFileSync(stdout, 'Hello\nWorld\n');

    const jsonLogs = await readServiceLogs(stdout, { json: true });
    const parsed = JSON.parse(jsonLogs);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].message, 'Hello');
  });
});
