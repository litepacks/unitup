import type {
  AppMetadata,
  CreateServiceOptions,
  DoctorInfo,
  InstallServiceOptions,
  ListServiceItem,
  LogOptions,
  NodeDiagnostics,
  NormalizedServiceConfig,
  PlatformCapabilities,
  ServiceFailure,
  ServiceStatus
} from '../index.d.ts';

// Compile-time type assertion checks for all exported interfaces
function typeCheckTest() {
  const options: CreateServiceOptions = {
    name: 'test-app',
    script: './server.js',
    runtime: 'python',
    runtimeArgs: ['-u'],
    command: '/usr/bin/python3',
    cwd: '/path/to/cwd',
    nodePath: '/usr/bin/node',
    env: { NODE_ENV: 'production' },
    envFile: '.env',
    restart: 'always',
    args: ['--port', '3000'],
    start: true,
    memoryMax: '512M',
    memoryHigh: '256M'
  };

  const installOpts: InstallServiceOptions = {
    ...options,
    system: false,
    force: true
  };

  const status: ServiceStatus = {
    name: 'test-app',
    installed: true,
    state: 'running',
    status: 'active (running)',
    enabled: true,
    pid: '1234',
    restarts: '0',
    started: '2026-08-23T12:00:00Z',
    command: '/usr/bin/node',
    arguments: 'server.js',
    args: ['server.js'],
    cwd: '/path/to/cwd',
    platform: 'darwin',
    manager: 'launchd'
  };

  const doctor: DoctorInfo = {
    platform: 'darwin',
    systemdAvailable: false,
    systemctlAvailable: false,
    linux: false,
    systemdRunning: false,
    userSystemdAvailable: false,
    lingering: false,
    nodePath: '/usr/bin/node',
    nodeVersion: 'v20.0.0',
    nodeValid: true,
    username: 'user',
    unitDir: '/tmp',
    unitDirWritable: true
  };

  const nodeDiag: NodeDiagnostics = {
    found: true,
    path: '/usr/bin/node',
    version: '20.0.0',
    valid: true
  };

  const list: ListServiceItem[] = [{ name: 'test-app', status: 'running', pid: '1234' }];

  const failures: ServiceFailure[] = [
    {
      name: 'api',
      group: 'default',
      status: 'failed',
      exitCode: '1',
      restarts: '3',
      uptime: '10s'
    }
  ];

  const caps: PlatformCapabilities = {
    serviceManager: 'launchd',
    supports: {
      install: true,
      uninstall: true,
      start: true,
      stop: true,
      restart: true,
      enable: true,
      disable: true,
      status: true,
      logs: true,
      restartPolicy: true,
      userServices: true,
      systemServices: true,
      memoryLimits: false,
      schedule: false
    }
  };

  const logs: LogOptions = {
    follow: true,
    lines: 50,
    grep: 'ERROR',
    json: true
  };

  const meta: AppMetadata = {
    name: 'test-app',
    runtime: 'node',
    command: '/usr/bin/node',
    args: ['app.js'],
    cwd: '/tmp'
  };

  const norm: NormalizedServiceConfig = {
    name: 'test-app',
    displayName: 'Test App',
    description: 'Unitup test',
    runtime: 'node',
    command: '/usr/bin/node',
    args: ['app.js'],
    cwd: '/tmp',
    env: { FOO: 'bar' },
    autostart: true,
    restart: {
      enabled: true,
      policy: 'on-failure',
      delay: 3000
    },
    logs: {
      stdout: '/tmp/test.log',
      stderr: '/tmp/test-error.log'
    },
    group: 'default',
    system: false,
    shutdownTimeout: 10000,
    resources: {
      memoryMax: '512M'
    }
  };

  console.log(options, installOpts, status, doctor, nodeDiag, list, failures, caps, logs, meta, norm);
}

typeCheckTest();
