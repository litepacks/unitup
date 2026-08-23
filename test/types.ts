import {
  type CreateServiceOptions,
  type DoctorInfo,
  type ListServiceItem,
  type NodeDiagnostics,
  type ServiceStatus,
  checkNodeDiagnostics,
  checkUserLinger,
  createService,
  findNodeExecutable,
  getDoctorInfo,
  getServiceLogs,
  getServiceNameFromUnit,
  getServiceStatus,
  getUnitFilename,
  getUnitPath,
  getUserUnitDir,
  isLinux,
  isSystemdAvailable,
  isSystemdPID1,
  isUserSystemdAvailable,
  listServices,
  parseUnitContent,
  removeService,
  resetCommandRunner,
  restartService,
  sanitizeServiceName,
  setCommandRunner,
  startService,
  stopService,
  unitFileExists
} from '../index.js';

// Compile-time type assertion checks
async function typeCheckTest() {
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
    start: true
  };

  const isAvailable: boolean = await isSystemdAvailable();
  const linux: boolean = isLinux();
  const pid1: boolean = await isSystemdPID1();
  const userSys: boolean = await isUserSystemdAvailable();
  const linger: boolean = await checkUserLinger();

  const nodeDiag: NodeDiagnostics = await checkNodeDiagnostics();
  const nodePathStr: string | null = await findNodeExecutable();

  const doctor: DoctorInfo = await getDoctorInfo();

  if (isAvailable && linux) {
    await createService(options);
    await startService('test-app', true);
    await restartService('test-app');

    const status: ServiceStatus = await getServiceStatus('test-app');
    console.log(status.name, status.pid, status.status);

    const list: ListServiceItem[] = await listServices();
    console.log(list.length);

    await stopService('test-app');
    await removeService('test-app');
  }

  const dir: string = getUserUnitDir();
  const pathStr: string = getUnitPath('test');
  const exists: boolean = unitFileExists('test');
  const clean: string = sanitizeServiceName('My Service');
  const unitFile: string = getUnitFilename('test');
  const serviceName: string = getServiceNameFromUnit('unitup-test.service');

  console.log(
    dir,
    pathStr,
    exists,
    clean,
    unitFile,
    serviceName,
    pid1,
    userSys,
    linger,
    doctor.username,
    nodeDiag.found,
    nodePathStr
  );
}

typeCheckTest().catch(() => {});
