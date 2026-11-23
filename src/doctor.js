import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRuntimeExecutable } from './runtimes/common.js';
import {
  checkNodeDiagnostics,
  checkUserLinger,
  isLinux,
  isSystemctlAvailable,
  isSystemdPID1,
  isUserSystemdAvailable,
  isUserUnitDirWritable,
  runCommand
} from './systemd.js';
import { getUserUnitDir } from './unit.js';
import { getUnitupDir } from './utils.js';

/**
 * Runs system diagnostic checks and returns structured data.
 *
 * @returns {Promise<Object>}
 */
export async function getDoctorInfo() {
  const platform = process.platform;
  const linux = isLinux();
  const systemctl = await isSystemctlAvailable();
  const pid1 = await isSystemdPID1();
  const userSystemd = await isUserSystemdAvailable();
  const unitDirWritable = await isUserUnitDirWritable();
  const lingering = await checkUserLinger();
  const nodeDiag = await checkNodeDiagnostics();

  // macOS specific checks
  let launchctlAvailable = false;
  let launchAgentsDirWritable = false;
  let launchdDomainAccessible = false;
  const orphanedLaunchdJobs = [];
  if (platform === 'darwin') {
    try {
      const res = await runCommand('launchctl', ['version']);
      launchctlAvailable = res.code === 0 || (res.stdout && res.stdout.length > 0) || !res.stderr.includes('not found');
    } catch {
      launchctlAvailable = false;
    }

    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    try {
      if (fs.existsSync(launchAgentsDir)) {
        fs.accessSync(launchAgentsDir, fs.constants.W_OK);
        launchAgentsDirWritable = true;
      } else {
        // Check if parent ~/Library is writable so LaunchAgents can be created
        fs.accessSync(path.dirname(launchAgentsDir), fs.constants.W_OK);
        launchAgentsDirWritable = true;
      }
    } catch {
      launchAgentsDirWritable = false;
    }

    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    try {
      const domRes = await runCommand('launchctl', ['print', `gui/${uid}`]);
      launchdDomainAccessible = domRes.code === 0;
    } catch {
      launchdDomainAccessible = false;
    }

    try {
      const listRes = await runCommand('launchctl', ['list']);
      if (listRes.code === 0 && listRes.stdout) {
        const lines = listRes.stdout.split('\n');
        for (const line of lines) {
          const match = line.match(/\b(dev\.unitup\.[a-zA-Z0-9._-]+)\b/);
          if (match) {
            const label = match[1];
            const plistPath = path.join(launchAgentsDir, `${label}.plist`);
            if (!fs.existsSync(plistPath)) {
              orphanedLaunchdJobs.push(label);
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Windows specific checks
  let windowsScmAvailable = false;
  let isAdmin = false;
  if (platform === 'win32') {
    try {
      const res = await runCommand('sc.exe', ['query']);
      windowsScmAvailable = res.code === 0 || !res.stderr.includes('not found');
      // Simple admin check: net session or whoami /priv
      const adminRes = await runCommand('net', ['session']);
      isAdmin = adminRes.code === 0;
    } catch {
      windowsScmAvailable = false;
    }
  }

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
    Python: pythonPath,
    Ruby: rubyPath,
    PHP: phpPath,
    Bun: bunPath,
    Deno: denoPath,
    Go: goPath,
    Elixir: elixirPath
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

  let serviceManager = 'systemd';
  if (platform === 'darwin') serviceManager = 'launchd';
  else if (platform === 'win32') serviceManager = 'Windows Service Manager';

  return {
    platform,
    serviceManager,
    linux,
    systemctl,
    systemdRunning: pid1,
    userSystemdAvailable: userSystemd,
    launchctlAvailable,
    launchAgentsDirWritable,
    launchdDomainAccessible,
    orphanedLaunchdJobs,
    windowsScmAvailable,
    isAdmin,
    cgroupV2,
    memoryController,
    memoryMaxSupported,
    memorySwapMaxSupported,
    nodeDiag,
    nodePath: nodePath || process.execPath,
    nodeVersion: nodeDiag.version,
    runtimes,
    unitDir: getUserUnitDir(),
    unitupDataDir: getUnitupDir(),
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
    console.log('Platform: Linux');
    console.log('Service manager: systemd');
    console.log(`Node: ${info.nodePath} ${info.nodeVersion ? `(${info.nodeVersion})` : ''}`);
    console.log(`Unitup data: ${info.unitupDataDir}`);
    console.log('✓ Linux detected');

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
  } else if (info.platform === 'darwin') {
    console.log('Platform: macOS');
    console.log('Service manager: launchd');
    console.log(`Node: ${info.nodePath} ${info.nodeVersion ? `(${info.nodeVersion})` : ''}`);
    console.log(`Unitup data: ${info.unitupDataDir}`);
    console.log('! Non-Linux OS detected (macOS uses launchd)');
    console.log(
      `${info.launchctlAvailable ? '✓' : '✗'} launchctl: ${info.launchctlAvailable ? 'available' : 'unavailable'}`
    );
    console.log(
      `${info.launchAgentsDirWritable ? '✓' : '✗'} LaunchAgents directory: ${info.launchAgentsDirWritable ? 'writable' : 'not writable'}`
    );
    console.log(
      `${info.launchdDomainAccessible ? '✓' : '!'} launchd GUI domain: ${info.launchdDomainAccessible ? 'accessible' : 'unavailable (headless/SSH session)'}`
    );
    if (info.orphanedLaunchdJobs && info.orphanedLaunchdJobs.length > 0) {
      console.log(`! Orphaned launchd jobs detected (missing plist): ${info.orphanedLaunchdJobs.join(', ')}`);
      console.log('  Clean up with: unitup remove <name> --force');
    }
    console.log('✓ Permissions: user services supported');
  } else if (info.platform === 'win32') {
    console.log('Platform: Windows');
    console.log('Service manager: Windows Service Manager');
    console.log(`Node: ${info.nodePath} ${info.nodeVersion ? `(${info.nodeVersion})` : ''}`);
    console.log(`Unitup data: ${info.unitupDataDir}`);
    console.log('! Non-Linux OS detected (Windows uses Windows Services)');
    console.log(`Administrator: ${info.isAdmin ? 'yes' : 'no'}`);
    if (!info.isAdmin) {
      console.log('! Service installation requires Administrator privileges');
    }
  } else {
    console.log(`✗ Non-Linux OS detected (${info.platform})`);
  }

  console.log('\nDetected runtimes:');
  for (const [name, path] of Object.entries(info.runtimes)) {
    if (path) {
      console.log(`✓ ${name}: ${path}`);
    } else {
      console.log(`- ${name}: not found`);
    }
  }

  if (info.linux) {
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
  }

  if (info.lingering) {
    console.log('✓ User lingering is enabled');
  } else {
    console.log('! User lingering is disabled');
    if (info.linux) {
      console.log('\nUser lingering is disabled.');
      console.log('The service may stop after logout.');
      console.log('\nEnable it manually:');
      console.log(`  loginctl enable-linger ${info.username}\n`);
    }
  }

  console.log('\n✓ Unitup can manage services on this machine');
  return info;
}
