import os from 'node:os';
import {
  isLinux,
  isSystemctlAvailable,
  isSystemdPID1,
  isUserSystemdAvailable,
  isUserUnitDirWritable,
  checkUserLinger,
  checkNodeDiagnostics
} from './systemd.js';
import { getUserUnitDir } from './unit.js';
import { findRuntimeExecutable } from './runtimes/common.js';

/**
 * Runs system diagnostic checks and returns structured data.
 *
 * @returns {Promise<Object>}
 */
export async function getDoctorInfo() {
  const linux = isLinux();
  const systemctl = await isSystemctlAvailable();
  const pid1 = await isSystemdPID1();
  const userSystemd = await isUserSystemdAvailable();
  const unitDirWritable = await isUserUnitDirWritable();
  const lingering = await checkUserLinger();
  const nodeDiag = await checkNodeDiagnostics();

  const nodePath = nodeDiag.execPath || (await findRuntimeExecutable(['node']));
  const pythonPath = await findRuntimeExecutable(['python3', 'python']);
  const rubyPath = await findRuntimeExecutable(['ruby']);
  const phpPath = await findRuntimeExecutable(['php']);
  const bunPath = await findRuntimeExecutable(['bun']);
  const denoPath = await findRuntimeExecutable(['deno']);
  const goPath = await findRuntimeExecutable(['go']);
  const elixirPath = await findRuntimeExecutable(['elixir']);

  const runtimes = {
    'Node.js': nodePath,
    'Python': pythonPath,
    'Ruby': rubyPath,
    'PHP': phpPath,
    'Bun': bunPath,
    'Deno': denoPath,
    'Go': goPath,
    'Elixir': elixirPath
  };

  let cgroupV2 = false;
  let memoryController = false;
  try {
    if (fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) {
      cgroupV2 = true;
      const controllers = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8');
      memoryController = controllers.includes('memory');
    }
  } catch {
    // ignore
  }

  const memoryMaxSupported = linux && (cgroupV2 || userSystemd);
  const memorySwapMaxSupported = linux && cgroupV2 && memoryController;

  return {
    linux,
    systemctl,
    systemdRunning: pid1,
    userSystemdAvailable: userSystemd,
    cgroupV2,
    memoryController,
    memoryMaxSupported,
    memorySwapMaxSupported,
    nodeDiag,
    nodePath: nodePath || process.execPath,
    nodeVersion: nodeDiag.version,
    runtimes,
    unitDir: getUserUnitDir(),
    unitDirWritable,
    lingering,
    username: os.userInfo().username
  };
}

/**
 * Executes doctor check and prints human-readable output to terminal.
 */
export async function runDoctor() {
  console.log('unitup doctor\n');

  const info = await getDoctorInfo();

  if (info.linux) {
    console.log('✓ Linux detected');
  } else {
    console.log('✗ Non-Linux OS detected (systemd requires Linux)');
  }

  if (info.systemctl) {
    console.log('✓ systemctl available');
  } else {
    console.log('✗ systemctl command not found');
  }

  if (info.systemdRunning) {
    console.log('✓ systemd is running');
  } else {
    console.log('! systemd is not running as PID 1');
  }

  if (info.userSystemdAvailable) {
    console.log('✓ systemd user services available');
  } else {
    console.log('! systemd user services unavailable');
  }

  console.log('\nDetected runtimes:');
  for (const [name, path] of Object.entries(info.runtimes)) {
    if (path) {
      console.log(`✓ ${name}: ${path}`);
    } else {
      console.log(`- ${name}: not found`);
    }
  }

  console.log('\nMemory Controller Diagnostics:');
  if (info.cgroupV2) {
    console.log('✓ cgroup v2 detected');
  } else {
    console.log('- cgroup v2 unavailable');
  }

  if (info.memoryController) {
    console.log('✓ Memory controller available');
  } else {
    console.log('- Memory controller unavailable');
  }

  if (info.memoryMaxSupported) {
    console.log('✓ MemoryMax supported');
  } else {
    console.log('- MemoryMax unavailable');
  }

  if (info.memorySwapMaxSupported) {
    console.log('✓ MemorySwapMax supported');
  } else {
    console.log('- MemorySwapMax unavailable');
  }

  console.log('');

  if (info.unitDirWritable) {
    console.log('✓ Unit directory writable');
  } else {
    console.log(`! Unit directory not writable (${info.unitDir})`);
  }

  if (info.lingering) {
    console.log('✓ User lingering is enabled');
  } else {
    console.log('! User lingering is disabled');
    console.log('\nUser lingering is disabled.');
    console.log('The service may stop after logout.');
    console.log('\nEnable it manually:');
    console.log(`  loginctl enable-linger ${info.username}\n`);
  }

  return info;
}
