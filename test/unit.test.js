import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeServiceName,
  getUnitFilename,
  getServiceNameFromUnit,
  resolveAbsolutePath,
  formatSystemdEnv,
  escapeExecArg,
  formatRelativeTime,
  formatTable
} from '../src/utils.js';
import {
  generateUnitContent,
  parseUnitContent
} from '../src/unit.js';

describe('utils.js', () => {
  describe('sanitizeServiceName', () => {
    test('converts to lowercase and replaces spaces with hyphens', () => {
      assert.equal(sanitizeServiceName('My App Service'), 'my-app-service');
    });

    test('strips invalid characters and path traversal sequences', () => {
      assert.equal(sanitizeServiceName('../../../etc/passwd!@#$'), 'etcpasswd');
      assert.equal(sanitizeServiceName('api_service_123'), 'api_service_123');
    });

    test('handles unitup- prefix and .service suffix', () => {
      assert.equal(sanitizeServiceName('unitup-api.service'), 'api');
      assert.equal(sanitizeServiceName('unitup-worker'), 'worker');
    });

    test('throws error for empty or invalid service names', () => {
      assert.throws(() => sanitizeServiceName(''), /Service name must be a non-empty string/);
      assert.throws(() => sanitizeServiceName('!@#$%'), /Invalid service name/);
    });
  });

  describe('getUnitFilename and getServiceNameFromUnit', () => {
    test('constructs unitup-<name>.service filename', () => {
      assert.equal(getUnitFilename('API Server'), 'unitup-api-server.service');
    });

    test('extracts clean service name from unit filename', () => {
      assert.equal(getServiceNameFromUnit('unitup-api-server.service'), 'api-server');
      assert.equal(getServiceNameFromUnit('/path/to/unitup-worker.service'), 'worker');
    });
  });

  describe('resolveAbsolutePath', () => {
    test('resolves relative path to absolute', () => {
      const abs = resolveAbsolutePath('./app.js', '/tmp');
      assert.equal(abs, '/tmp/app.js');
    });
  });

  describe('systemd escaping helpers', () => {
    test('formatSystemdEnv formats key=value with systemd quotes', () => {
      assert.equal(formatSystemdEnv('NODE_ENV', 'production'), 'NODE_ENV="production"');
      assert.equal(formatSystemdEnv('SECRET', 'hello "world"'), 'SECRET="hello \\"world\\""');
      assert.equal(formatSystemdEnv('VAR', 'a $b'), 'VAR="a $$b"');
    });

    test('formatSystemdEnv rejects invalid keys', () => {
      assert.throws(() => formatSystemdEnv('INVALID-KEY', 'val'), /Invalid environment variable key/);
      assert.throws(() => formatSystemdEnv('123NUM', 'val'), /Invalid environment variable key/);
    });

    test('escapeExecArg wraps arguments with whitespace or quotes', () => {
      assert.equal(escapeExecArg('/usr/bin/node'), '/usr/bin/node');
      assert.equal(escapeExecArg('/path to/app.js'), '"/path to/app.js"');
      assert.equal(escapeExecArg('--msg="hello"'), '"--msg=\\"hello\\""');
    });
  });

  describe('formatRelativeTime', () => {
    test('formats relative time strings', () => {
      const now = new Date();
      const tenMinsAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
      assert.match(formatRelativeTime(tenMinsAgo), /10 minutes ago/);
    });
  });

  describe('formatTable', () => {
    test('formats data into aligned table output', () => {
      const data = [
        { name: 'api', status: 'running', enabled: 'yes' },
        { name: 'worker', status: 'stopped', enabled: 'no' }
      ];
      const cols = [
        { key: 'name', label: 'NAME' },
        { key: 'status', label: 'STATUS' },
        { key: 'enabled', label: 'ENABLED' }
      ];
      const table = formatTable(data, cols);
      assert.match(table, /NAME\s+STATUS\s+ENABLED/);
      assert.match(table, /api\s+running\s+yes/);
      assert.match(table, /worker\s+stopped\s+no/);
    });
  });
});

describe('unit.js', () => {
  test('generateUnitContent creates standard systemd unit file content', () => {
    const content = generateUnitContent({
      name: 'api',
      script: '/home/user/app/server.js',
      cwd: '/home/user/app',
      nodePath: '/usr/bin/node',
      env: { NODE_ENV: 'production', PORT: '3000' },
      envFile: '/home/user/app/.env',
      restart: 'on-failure',
      args: ['--port', '3000']
    });

    assert.match(content, /\[Unit\]/);
    assert.match(content, /Description=unitup service: api/);
    assert.match(content, /\[Service\]/);
    assert.match(content, /WorkingDirectory=\/home\/user\/app/);
    assert.match(content, /ExecStart=\/usr\/bin\/node \/home\/user\/app\/server\.js --port 3000/);
    assert.match(content, /Restart=on-failure/);
    assert.match(content, /SyslogIdentifier=unitup-api/);
    assert.match(content, /StandardOutput=journal/);
    assert.match(content, /StandardError=journal/);
    assert.match(content, /EnvironmentFile=\/home\/user\/app\/\.env/);
    assert.match(content, /Environment=PATH="/);
    assert.match(content, /Environment=NODE_ENV="production"/);
    assert.match(content, /Environment=PORT="3000"/);
    assert.match(content, /\[Install\]/);
    assert.match(content, /WantedBy=default\.target/);
  });

  test('parseUnitContent extracts metadata from unit content', () => {
    const content = `
[Service]
WorkingDirectory=/home/user/app
ExecStart=/usr/bin/node /home/user/app/server.js
Restart=always
`;
    const parsed = parseUnitContent(content);
    assert.equal(parsed.cwd, '/home/user/app');
    assert.equal(parsed.script, '/home/user/app/server.js');
    assert.equal(parsed.restart, 'always');
  });
});
