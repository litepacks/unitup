import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { runDoctor } from './doctor.js';
import { getAdapter } from './platform/index.js';
import {
  createSchedule,
  disableSchedule,
  enableSchedule,
  getScheduleStatus,
  listSchedules,
  removeSchedule,
  runSchedule
} from './schedule.js';
import { defaultManager } from './service/manager.js';
import {
  addService,
  executeJournalctlMaintenance,
  findNodeExecutable,
  getAllServicesMemoryUsage,
  getServiceFailures,
  getServiceMemoryUsage,
  getServiceStatus,
  getServiceStatusRaw,
  getServicesByGroup,
  inspectService,
  isLinux,
  isSystemctlAvailable,
  listServices,
  removeService,
  restartService,
  runJournalctlLogs,
  setServiceLimits,
  startService,
  stopService
} from './systemd.js';
import {
  findProjectConfig,
  formatTable,
  readGlobalConfig,
  readProjectConfig,
  sanitizeServiceName,
  saveGlobalConfig,
  saveProjectConfig,
  validateMemorySize
} from './utils.js';

/**
 * Custom light CLI argument parser without runtime dependencies.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const result = {
    command: '',
    positionals: [],
    flags: {
      name: '',
      group: '',
      runtime: '',
      runtimeArgs: [],
      command: '',
      node: '',
      cwd: '',
      config: '',
      env: [],
      envFile: '',
      restart: 'on-failure',
      args: [],
      start: false,
      enable: false,
      raw: false,
      follow: false,
      cat: false,
      output: '',
      lines: 100,
      help: false,
      version: false,
      force: false,
      system: false,
      verbose: false,
      memoryHigh: '',
      memoryMax: '',
      memorySwapMax: '',
      resetMemory: false,
      defaultMemory: '',
      resetDefaultMemory: false,
      since: '',
      until: '',
      priority: '',
      grep: '',
      boot: false,
      json: false,
      diskUsage: false,
      size: '',
      time: '',
      files: '',
      yes: false,
      dryRun: false,
      every: '',
      calendar: '',
      onBoot: '',
      onActive: '',
      randomDelay: '',
      persistent: false
    }
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      result.flags.help = true;
      i++;
    } else if (arg === '-v' || arg === '--version') {
      result.flags.version = true;
      i++;
    } else if (arg === '--verbose') {
      result.flags.verbose = true;
      i++;
    } else if (arg === '--system') {
      result.flags.system = true;
      i++;
    } else if (arg === '--runtime') {
      result.flags.runtime = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--runtime=')) {
      result.flags.runtime = arg.slice(10);
      i++;
    } else if (arg === '--runtime-arg' || arg === '--runtime-args') {
      if (argv[i + 1]) result.flags.runtimeArgs.push(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith('--runtime-arg=')) {
      result.flags.runtimeArgs.push(arg.slice(14));
      i++;
    } else if (arg.startsWith('--runtime-args=')) {
      result.flags.runtimeArgs.push(arg.slice(15));
      i++;
    } else if (arg === '--command') {
      result.flags.command = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--command=')) {
      result.flags.command = arg.slice(10);
      i++;
    } else if (arg === '--node') {
      result.flags.node = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--node=')) {
      result.flags.node = arg.slice(7);
      i++;
    } else if (arg === '--name') {
      result.flags.name = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--name=')) {
      result.flags.name = arg.slice(7);
      i++;
    } else if (arg === '--group') {
      result.flags.group = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--group=')) {
      result.flags.group = arg.slice(8);
      i++;
    } else if (arg === '--cwd') {
      result.flags.cwd = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--cwd=')) {
      result.flags.cwd = arg.slice(6);
      i++;
    } else if (arg === '--config') {
      result.flags.config = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--config=')) {
      result.flags.config = arg.slice(9);
      i++;
    } else if (arg === '--env') {
      if (argv[i + 1]) result.flags.env.push(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith('--env=')) {
      result.flags.env.push(arg.slice(6));
      i++;
    } else if (arg === '--env-file') {
      result.flags.envFile = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--env-file=')) {
      result.flags.envFile = arg.slice(11);
      i++;
    } else if (arg === '--restart') {
      result.flags.restart = argv[i + 1] || 'on-failure';
      i += 2;
    } else if (arg.startsWith('--restart=')) {
      result.flags.restart = arg.slice(10);
      i++;
    } else if (arg === '--arg' || arg === '--args') {
      if (argv[i + 1]) result.flags.args.push(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith('--arg=')) {
      result.flags.args.push(arg.slice(6));
      i++;
    } else if (arg.startsWith('--args=')) {
      result.flags.args.push(arg.slice(7));
      i++;
    } else if (arg === '--lines' || arg === '-n') {
      result.flags.lines = Number.parseInt(argv[i + 1] || '100', 10);
      i += 2;
    } else if (arg.startsWith('--lines=')) {
      result.flags.lines = Number.parseInt(arg.slice(8), 10);
      i++;
    } else if (arg === '--start') {
      result.flags.start = true;
      i++;
    } else if (arg === '--enable') {
      result.flags.enable = true;
      i++;
    } else if (arg === '--raw') {
      result.flags.raw = true;
      i++;
    } else if (arg === '-f' || arg === '--follow' || arg === '--force') {
      result.flags.follow = true;
      result.flags.force = true;
      i++;
    } else if (arg === '-c' || arg === '--cat') {
      result.flags.cat = true;
      i++;
    } else if (arg === '--output') {
      result.flags.output = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--output=')) {
      result.flags.output = arg.slice(9);
      i++;
    } else if (arg === '--memory-high') {
      result.flags.memoryHigh = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--memory-high=')) {
      result.flags.memoryHigh = arg.slice(14);
      i++;
    } else if (arg === '--memory-max') {
      result.flags.memoryMax = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--memory-max=')) {
      result.flags.memoryMax = arg.slice(13);
      i++;
    } else if (arg === '--memory-swap-max') {
      result.flags.memorySwapMax = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--memory-swap-max=')) {
      result.flags.memorySwapMax = arg.slice(18);
      i++;
    } else if (arg === '--reset-memory') {
      result.flags.resetMemory = true;
      i++;
    } else if (arg === '--default-memory') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        result.flags.defaultMemory = next;
        i += 2;
      } else {
        result.flags.defaultMemory = '1G';
        i++;
      }
    } else if (arg.startsWith('--default-memory=')) {
      result.flags.defaultMemory = arg.slice(17) || '1G';
      i++;
    } else if (arg === '--reset-default-memory') {
      result.flags.resetDefaultMemory = true;
      i++;
    } else if (arg === '--since') {
      result.flags.since = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--since=')) {
      result.flags.since = arg.slice(8);
      i++;
    } else if (arg === '--until') {
      result.flags.until = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--until=')) {
      result.flags.until = arg.slice(8);
      i++;
    } else if (arg === '--priority') {
      result.flags.priority = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--priority=')) {
      result.flags.priority = arg.slice(11);
      i++;
    } else if (arg === '--grep') {
      result.flags.grep = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--grep=')) {
      result.flags.grep = arg.slice(7);
      i++;
    } else if (arg === '--boot' || arg === '-b') {
      result.flags.boot = true;
      i++;
    } else if (arg === '--json') {
      result.flags.json = true;
      i++;
    } else if (arg === '--disk-usage') {
      result.flags.diskUsage = true;
      i++;
    } else if (arg === '--size') {
      result.flags.size = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--size=')) {
      result.flags.size = arg.slice(7);
      i++;
    } else if (arg === '--time') {
      result.flags.time = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--time=')) {
      result.flags.time = arg.slice(7);
      i++;
    } else if (arg === '--files') {
      result.flags.files = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--files=')) {
      result.flags.files = arg.slice(8);
      i++;
    } else if (arg === '--yes' || arg === '-y') {
      result.flags.yes = true;
      i++;
    } else if (arg === '--dry-run') {
      result.flags.dryRun = true;
      i++;
    } else if (arg === '--every') {
      result.flags.every = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--every=')) {
      result.flags.every = arg.slice(8);
      i++;
    } else if (arg === '--calendar') {
      result.flags.calendar = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--calendar=')) {
      result.flags.calendar = arg.slice(11);
      i++;
    } else if (arg === '--on-boot') {
      result.flags.onBoot = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--on-boot=')) {
      result.flags.onBoot = arg.slice(10);
      i++;
    } else if (arg === '--on-active') {
      result.flags.onActive = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--on-active=')) {
      result.flags.onActive = arg.slice(12);
      i++;
    } else if (arg === '--random-delay') {
      result.flags.randomDelay = argv[i + 1] || '';
      i += 2;
    } else if (arg.startsWith('--random-delay=')) {
      result.flags.randomDelay = arg.slice(15);
      i++;
    } else if (arg === '--persistent') {
      result.flags.persistent = true;
      i++;
    } else if (!arg.startsWith('-')) {
      if (!result.command) {
        result.command = arg;
      } else {
        result.positionals.push(arg);
      }
      i++;
    } else {
      i++;
    }
  }

  return result;
}

export function printHelp() {
  console.log(`
unitup - Minimal systemd user service wrapper & cross-platform service manager (Linux, macOS, Windows)

Usage:
  unitup doctor                 Run system readiness and runtime check
  unitup init [script]          Create local project config file (unitup.config.json)
  unitup install / add <script> Install script or executable as native service (--dry-run)
  unitup start <name|@group>    Start a service (--enable to enable on boot)
  unitup stop <name|@group>     Stop a service
  unitup restart <name|@group>  Restart a service
  unitup status <name|@group>   Show status summary (--raw, --verbose)
  unitup enable <name>          Enable service on startup/boot
  unitup disable <name>         Disable service on startup/boot
  unitup logs <name|@group>     Show service logs (-f/--follow, -n/--lines N, -c/--cat)
  unitup inspect <name>         View detailed app configuration and status
  unitup failures               List all failed services with exit code & restarts
  unitup uninstall / remove     Stop, disable and delete a service (--force)
  unitup list / unitup ls       List all services (--group <group>)
  unitup memory / unitup top    Show memory usage for all apps or a specific app
  unitup config                 Manage global configuration (--default-memory 1G)

Config Options:
  --config <path>        Path to custom project config file (defaults to unitup.config.json)
  --system               Install as system-wide service (LaunchDaemons on macOS / root systemd)
  --dry-run              Display generated service configuration without installing

Schedule Commands (systemd):
  unitup schedule <script> [options] Create a timer schedule
  unitup schedules / unitup timers    List all schedule timers
  unitup schedule-status <name>       Show detailed schedule timer status
  unitup schedule-run <name>          Manually run schedule service unit once
  unitup schedule-enable <name>       Enable and start schedule timer
  unitup schedule-disable <name>      Disable and stop schedule timer
  unitup schedule-remove <name>       Remove schedule timer and service
  unitup schedule-logs <name>         View logs for a scheduled task

Memory Options:
  --memory-high <size>   Soft memory limit (e.g. 400M, 1G)
  --memory-max <size>    Hard memory limit (e.g. 512M, 1G)
  --default-memory [sz]  Apply default memory limit (defaults to 1G)

Examples:
  unitup install server.js --name api --start
  unitup install ./app.js --dry-run
  unitup start api
  unitup status api --verbose
  unitup logs api --follow
  unitup uninstall api
`);
}

async function resolveTargetNames(target) {
  if (target && target.startsWith('@')) {
    const list = await getServicesByGroup(target);
    if (list.length === 0) {
      throw new Error(`No services found in group "${target}".`);
    }
    return list;
  }
  return [target];
}

/**
 * Main CLI runner entrypoint.
 *
 * @param {string[]} argv
 */
export async function runCli(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);

  if (parsed.flags.version) {
    try {
      const pkgPath = new URL('../package.json', import.meta.url);
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      console.log(`unitup v${pkg.version}`);
    } catch {
      console.log('unitup v1.0.0');
    }
    return;
  }

  if (parsed.flags.help || !parsed.command) {
    printHelp();
    return;
  }

  const { command, positionals, flags } = parsed;

  try {
    switch (command) {
      case 'doctor': {
        await runDoctor();
        break;
      }

      case 'init': {
        const targetCwd = flags.cwd ? path.resolve(process.cwd(), flags.cwd) : process.cwd();
        const configFilename = flags.config || 'unitup.config.json';
        const targetConfigPath = path.resolve(targetCwd, configFilename);

        if (fs.existsSync(targetConfigPath) && !flags.force) {
          throw new Error(
            `Configuration file "${path.basename(targetConfigPath)}" already exists at ${targetConfigPath}.\n` +
              `Use --force (-f) to overwrite.`
          );
        }

        const scriptArg = positionals[0];
        const scriptPath = scriptArg || '';
        let name = flags.name;
        if (!name) {
          if (scriptPath) {
            const baseName = path.basename(scriptPath);
            const ext = path.extname(baseName);
            name = ext ? baseName.slice(0, -ext.length) : baseName;
          } else {
            name = path.basename(targetCwd);
          }
        }

        const envObj = {};
        for (const e of flags.env) {
          const idx = e.indexOf('=');
          if (idx !== -1) {
            envObj[e.slice(0, idx)] = e.slice(idx + 1);
          } else {
            envObj[e] = '';
          }
        }

        const projectCfg = {
          name,
          ...(scriptPath ? { script: scriptPath } : {}),
          ...(flags.command ? { command: flags.command } : {}),
          ...(flags.runtime ? { runtime: flags.runtime } : {}),
          ...(flags.runtimeArgs && flags.runtimeArgs.length > 0 ? { runtimeArgs: flags.runtimeArgs } : {}),
          group: flags.group || 'default',
          ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
          ...(flags.envFile ? { envFile: flags.envFile } : {}),
          ...(flags.restart ? { restart: flags.restart } : { restart: 'on-failure' }),
          ...(flags.args && flags.args.length > 0 ? { args: flags.args } : {})
        };

        if (flags.memoryMax || flags.memoryHigh || flags.memorySwapMax) {
          projectCfg.resources = {};
          if (flags.memoryHigh) projectCfg.resources.memoryHigh = flags.memoryHigh;
          if (flags.memoryMax) projectCfg.resources.memoryMax = flags.memoryMax;
          if (flags.memorySwapMax) projectCfg.resources.memorySwapMax = flags.memorySwapMax;
        }

        const writtenPath = saveProjectConfig(targetConfigPath, projectCfg);
        console.log(`✓ Project configuration created at ${writtenPath}`);
        console.log(`Run "unitup add" to register service from configuration.`);
        break;
      }

      case 'install':
      case 'add': {
        const targetCwd = flags.cwd ? path.resolve(process.cwd(), flags.cwd) : process.cwd();
        const configPath = flags.config ? path.resolve(targetCwd, flags.config) : findProjectConfig(targetCwd);
        const projectCfg = configPath ? readProjectConfig(configPath) : null;

        const scriptArg = positionals[0] || (projectCfg ? projectCfg.script : undefined);
        let name = flags.name || (projectCfg ? projectCfg.name : undefined);
        const cmdFlag = flags.command || (projectCfg ? projectCfg.command : undefined);
        const runtimeFlag = flags.runtime || (projectCfg ? projectCfg.runtime : undefined);
        const groupFlag = flags.group || (projectCfg ? projectCfg.group : undefined) || 'default';
        const restartFlag =
          flags.restart !== 'on-failure' ? flags.restart : (projectCfg && projectCfg.restart) || 'on-failure';
        const envFileFlag = flags.envFile || (projectCfg ? projectCfg.envFile : undefined);
        const argsFlag = flags.args && flags.args.length > 0 ? flags.args : (projectCfg && projectCfg.args) || [];
        const runtimeArgsFlag =
          flags.runtimeArgs && flags.runtimeArgs.length > 0
            ? flags.runtimeArgs
            : (projectCfg && projectCfg.runtimeArgs) || [];
        const memoryHighFlag = flags.memoryHigh || projectCfg?.resources?.memoryHigh || projectCfg?.memoryHigh || '';
        const memoryMaxFlag = flags.memoryMax || projectCfg?.resources?.memoryMax || projectCfg?.memoryMax || '';
        const memorySwapMaxFlag =
          flags.memorySwapMax || projectCfg?.resources?.memorySwapMax || projectCfg?.memorySwapMax || '';

        const absScriptPath = scriptArg ? path.resolve(targetCwd, scriptArg) : undefined;

        if (flags.node) {
          const resolvedNode = await findNodeExecutable(flags.node);
          if (!resolvedNode) {
            throw new Error('Node.js is required but not found.\nRun: unitup doctor');
          }
        }

        if (cmdFlag) {
          if (!name) {
            if (scriptArg) {
              const baseName = path.basename(scriptArg);
              const ext = path.extname(baseName);
              name = ext ? baseName.slice(0, -ext.length) : baseName;
            } else {
              const baseCmd = path.basename(cmdFlag);
              name = baseCmd;
            }
          }
        } else {
          if (!scriptArg) {
            throw new Error('Script file path or --command is required.\nExample: unitup add app.py --runtime python');
          }
          if (!fs.existsSync(absScriptPath)) {
            throw new Error(`Script file does not exist: ${absScriptPath}`);
          }
          if (!name) {
            const baseName = path.basename(scriptArg);
            const ext = path.extname(baseName);
            name = ext ? baseName.slice(0, -ext.length) : baseName;
          }
        }

        const envObj = projectCfg && projectCfg.env && typeof projectCfg.env === 'object' ? { ...projectCfg.env } : {};
        for (const e of flags.env) {
          const idx = e.indexOf('=');
          if (idx !== -1) {
            envObj[e.slice(0, idx)] = e.slice(idx + 1);
          } else {
            envObj[e] = '';
          }
        }

        const installOptions = {
          name,
          group: groupFlag,
          script: absScriptPath,
          command: cmdFlag,
          runtime: runtimeFlag,
          runtimeArgs: runtimeArgsFlag,
          nodePath: flags.node,
          cwd: targetCwd,
          env: envObj,
          envFile: envFileFlag ? path.resolve(targetCwd, envFileFlag) : undefined,
          restart: restartFlag,
          args: argsFlag,
          start: flags.start,
          system: flags.system,
          memoryHigh: memoryHighFlag,
          memoryMax: memoryMaxFlag,
          memorySwapMax: memorySwapMaxFlag,
          defaultMemory: flags.defaultMemory,
          force: flags.force
        };

        if (flags.dryRun) {
          const generated = await defaultManager.generate(installOptions);
          if (typeof generated === 'string') {
            console.log(generated);
          } else {
            console.log(JSON.stringify(generated, null, 2));
          }
          break;
        }

        const res = await defaultManager.install(installOptions);

        console.log(`✓ Service "${res.name}" created at ${res.unitPath || res.serviceName || res.name}`);
        if (flags.start) {
          console.log(`✓ Service "${res.name}" enabled and started.`);
        } else {
          console.log(`Run "unitup start ${res.name}" to start it.`);
        }
        break;
      }

      case 'limits': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name is required.\nExample: unitup limits api --memory-high 400M --memory-max 512M');
        }
        const info = await setServiceLimits(nameArg, {
          memoryHigh: flags.memoryHigh,
          memoryMax: flags.memoryMax,
          memorySwapMax: flags.memorySwapMax,
          resetMemory: flags.resetMemory
        });
        console.log(`✓ Service "${info.name}" limits updated.`);
        console.log(`Memory High: ${info.memoryHigh}`);
        console.log(`Memory Max: ${info.memoryMax}`);
        console.log(`Swap Max: ${info.memorySwapMax}`);
        break;
      }

      case 'start': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name or @group is required.\nExample: unitup start api or unitup start @myproject');
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.start(name, { enable: flags.enable, system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" ${flags.enable ? 'enabled & ' : ''}started.`);
        }
        break;
      }

      case 'stop': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name or @group is required.\nExample: unitup stop api or unitup stop @myproject');
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.stop(name, { system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" stopped.`);
        }
        break;
      }

      case 'restart': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error(
            'Service name or @group is required.\nExample: unitup restart api or unitup restart @myproject'
          );
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.restart(name, { system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" restarted.`);
        }
        break;
      }

      case 'enable': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name or @group is required.\nExample: unitup enable api');
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.enable(name, { system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" enabled on startup.`);
        }
        break;
      }

      case 'disable': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name or @group is required.\nExample: unitup disable api');
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.disable(name, { system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" disabled on startup.`);
        }
        break;
      }

      case 'ps':
      case 'status': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error(
            'Service name or @group is required.\nExample: unitup status api or unitup status @myproject'
          );
        }

        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          if (flags.raw) {
            const raw = await getServiceStatusRaw(name);
            console.log(raw);
          } else {
            const status = await defaultManager.status(name, { system: flags.system });
            console.log(`${status.name}\n`);
            console.log(`Status: ${status.status || status.state}`);
            console.log(`PID: ${status.pid}`);
            console.log(`Started: ${status.started}`);
            console.log(`Restarts: ${status.restarts}`);
            console.log(`Command: ${status.command}`);
            console.log(`Arguments: ${status.arguments}`);
            console.log(`Working directory: ${status.cwd}`);
            if (status.memory) console.log(`Memory: ${status.memory}`);
            if (status.memoryPeak) console.log(`Memory Peak: ${status.memoryPeak}`);
            if (status.memoryHigh) console.log(`Memory High: ${status.memoryHigh}`);
            if (status.memoryMax) console.log(`Memory Max: ${status.memoryMax}`);
            if (status.memorySwapMax) console.log(`Swap Max: ${status.memorySwapMax}`);
            if (flags.verbose) {
              console.log(`Platform: ${status.platform}`);
              console.log(`Manager: ${status.manager}`);
              if (status.unitPath) console.log(`Unit Path: ${status.unitPath}`);
            }
          }
        }
        break;
      }

      case 'log':
      case 'logs': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name or @group is required.\nExample: unitup logs api or unitup logs @myproject');
        }

        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          if (targetNames.length > 1) {
            console.log(`=== Logs for ${name} ===`);
          }
          const output = await defaultManager.logs(name, {
            follow: flags.follow,
            lines: flags.lines,
            cat: flags.cat,
            output: flags.output,
            since: flags.since,
            until: flags.until,
            priority: flags.priority,
            grep: flags.grep,
            boot: flags.boot,
            json: flags.json,
            diskUsage: flags.diskUsage,
            system: flags.system
          });
          if (output && typeof output.on === 'function') {
            await new Promise((resolve) => {
              const cleanup = () => {
                if (output.stop) output.stop();
                resolve();
              };
              process.on('SIGINT', cleanup);
              process.on('SIGTERM', cleanup);
              output.on('close', resolve);
              output.on('error', (err) => {
                console.error(err.message);
                cleanup();
              });
            });
          } else if (typeof output === 'string') {
            console.log(output);
          }
        }
        break;
      }

      case 'journal': {
        const action = positionals[0];
        if (!action) {
          throw new Error(
            'Journal action is required (disk-usage, rotate, vacuum).\nExample: unitup journal vacuum --size 500M'
          );
        }

        if (action === 'vacuum' && !flags.yes && !flags.dryRun) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise((resolve) => {
            rl.question(
              'This operation affects archived journal logs system-wide,\nnot only services managed by unitup.\n\nContinue? [y/N] ',
              (ans) => {
                rl.close();
                resolve(ans.trim());
              }
            );
          });
          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('Aborted.');
            break;
          }
        }

        const result = await executeJournalctlMaintenance(action, {
          size: flags.size,
          time: flags.time,
          files: flags.files,
          yes: flags.yes,
          dryRun: flags.dryRun
        });
        console.log(result);
        break;
      }

      case 'uninstall':
      case 'rm':
      case 'delete':
      case 'remove': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error(
            'Service name or @group is required.\nExample: unitup remove api or unitup remove @myproject'
          );
        }
        const targetNames = await resolveTargetNames(nameArg);
        for (const name of targetNames) {
          await defaultManager.uninstall(name, { force: flags.force, system: flags.system });
          console.log(`✓ Service "${sanitizeServiceName(name)}" removed.`);
        }
        break;
      }

      case 'ls':
      case 'list': {
        const services = await defaultManager.list({ group: flags.group });
        if (services.length === 0) {
          if (flags.group) {
            console.log(`No services found in group "${flags.group}".`);
          } else {
            console.log('No unitup user services found.');
          }
          break;
        }

        const table = formatTable(services, [
          { key: 'name', label: 'NAME' },
          { key: 'runtime', label: 'RUNTIME' },
          { key: 'status', label: 'STATUS' },
          { key: 'pid', label: 'PID' },
          { key: 'command', label: 'COMMAND' }
        ]);
        console.log(table);
        break;
      }

      case 'inspect': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Service name is required.\nExample: unitup inspect api');
        }
        const info = await defaultManager.inspect(nameArg, { system: flags.system });
        console.log(`Name: ${info.name}`);
        console.log(`Runtime: ${info.runtime}`);
        console.log(`Group: ${info.group}`);
        console.log(`Status: ${info.status}`);
        console.log(`Command: ${info.command}`);
        console.log(`Arguments: ${info.arguments}`);
        console.log(`Working directory: ${info.cwd}`);
        if (info.unit || info.unitFile) console.log(`Unit: ${info.unit || info.unitFile}`);
        if (info.memory) console.log(`Memory: ${info.memory}`);
        if (info.memoryPeak) console.log(`Memory Peak: ${info.memoryPeak}`);
        if (info.memoryHigh) console.log(`Memory High: ${info.memoryHigh}`);
        if (info.memoryMax) console.log(`Memory Max: ${info.memoryMax}`);
        if (info.memorySwapMax) console.log(`Swap Max: ${info.memorySwapMax}`);
        break;
      }

      case 'failures': {
        const failures = await defaultManager.failures();
        if (failures.length === 0) {
          console.log('✓ No failed services.');
          break;
        }

        const table = formatTable(failures, [
          { key: 'name', label: 'NAME' },
          { key: 'group', label: 'GROUP' },
          { key: 'status', label: 'STATUS' },
          { key: 'exitCode', label: 'EXIT_CODE' },
          { key: 'restarts', label: 'RESTARTS' },
          { key: 'uptime', label: 'UPTIME' }
        ]);
        console.log(table);
        break;
      }

      case 'schedule': {
        const scriptArg = positionals[0];
        const envObj = {};
        for (const e of flags.env) {
          const idx = e.indexOf('=');
          if (idx !== -1) {
            envObj[e.slice(0, idx)] = e.slice(idx + 1);
          } else {
            envObj[e] = '';
          }
        }

        const res = await createSchedule({
          name: flags.name,
          script: scriptArg,
          command: flags.command,
          runtime: flags.runtime,
          runtimeArgs: flags.runtimeArgs,
          args: flags.args,
          cwd: flags.cwd,
          env: envObj,
          envFile: flags.envFile,
          group: flags.group,
          memoryHigh: flags.memoryHigh,
          memoryMax: flags.memoryMax,
          memorySwapMax: flags.memorySwapMax,
          defaultMemory: flags.defaultMemory,
          every: flags.every,
          calendar: flags.calendar,
          onBoot: flags.onBoot,
          onActive: flags.onActive,
          randomDelay: flags.randomDelay,
          persistent: flags.persistent,
          start: flags.start || flags.enable,
          enable: flags.enable
        });

        console.log(`✓ Schedule "${res.name}" created.`);
        console.log(`Service unit: ${res.servicePath}`);
        console.log(`Timer unit: ${res.timerPath}`);
        if (flags.start || flags.enable) {
          console.log(`✓ Timer "${res.name}" enabled and started.`);
        } else {
          console.log(`Run "unitup schedule-enable ${res.name}" to enable and start the timer.`);
        }
        break;
      }

      case 'timers':
      case 'schedules': {
        const schedules = await listSchedules(flags.group);
        if (schedules.length === 0) {
          if (flags.group) {
            console.log(`No schedules found in group "${flags.group}".`);
          } else {
            console.log('No unitup schedule timers found.');
          }
          break;
        }

        const table = formatTable(schedules, [
          { key: 'name', label: 'NAME' },
          { key: 'group', label: 'GROUP' },
          { key: 'schedule', label: 'SCHEDULE' },
          { key: 'nextRun', label: 'NEXT RUN' },
          { key: 'lastRun', label: 'LAST RUN' },
          { key: 'status', label: 'STATUS' }
        ]);
        console.log(table);
        break;
      }

      case 'timer-status':
      case 'schedule-status': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-status cleanup');
        }
        const status = await getScheduleStatus(nameArg);
        console.log(`Name: ${status.name}`);
        console.log(`Group: ${status.group}`);
        console.log(`Schedule: ${status.schedule}`);
        console.log(`Next Run: ${status.nextRun}`);
        console.log(`Last Run: ${status.lastRun}`);
        console.log(`Status: ${status.status}`);
        console.log(`Timer Unit: ${status.timerUnit}`);
        console.log(`Service Unit: ${status.serviceUnit}`);
        break;
      }

      case 'schedule-run': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-run cleanup');
        }
        await runSchedule(nameArg);
        console.log(`✓ Service unit for schedule "${sanitizeServiceName(nameArg)}" triggered.`);
        break;
      }

      case 'schedule-enable': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-enable cleanup');
        }
        await enableSchedule(nameArg);
        console.log(`✓ Schedule timer "${sanitizeServiceName(nameArg)}" enabled and started.`);
        break;
      }

      case 'schedule-disable': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-disable cleanup');
        }
        await disableSchedule(nameArg);
        console.log(`✓ Schedule timer "${sanitizeServiceName(nameArg)}" disabled.`);
        break;
      }

      case 'schedule-remove': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-remove cleanup');
        }
        await removeSchedule(nameArg, { force: flags.force });
        console.log(`✓ Schedule "${sanitizeServiceName(nameArg)}" removed.`);
        break;
      }

      case 'schedule-logs': {
        const nameArg = positionals[0];
        if (!nameArg) {
          throw new Error('Schedule name is required.\nExample: unitup schedule-logs cleanup');
        }
        const output = await runJournalctlLogs(nameArg, {
          follow: flags.follow,
          lines: flags.lines,
          cat: flags.cat,
          output: flags.output,
          since: flags.since,
          until: flags.until,
          priority: flags.priority,
          grep: flags.grep,
          boot: flags.boot,
          json: flags.json,
          diskUsage: flags.diskUsage
        });
        if (typeof output === 'string') {
          console.log(output);
        }
        break;
      }

      case 'config': {
        if (flags.resetDefaultMemory) {
          saveGlobalConfig({ defaultMemory: null });
          console.log('✓ Default memory limit reset.');
        } else if (flags.defaultMemory) {
          const validSize = validateMemorySize(flags.defaultMemory, 'Default memory limit');
          saveGlobalConfig({ defaultMemory: validSize });
          console.log(`✓ Default memory limit set to ${validSize}.`);
        } else {
          const cfg = readGlobalConfig();
          console.log(`Default Memory: ${cfg.defaultMemory || 'not set (1G on demand)'}`);
        }
        break;
      }

      case 'top':
      case 'mem':
      case 'memory': {
        const nameArg = positionals[0];
        if (nameArg) {
          const targetNames = await resolveTargetNames(nameArg);
          for (const name of targetNames) {
            const mem = await getServiceMemoryUsage(name);
            console.log(`=== Memory Overview: ${mem.name} ===`);
            console.log(`Group: ${mem.group}`);
            console.log(`Type: ${mem.type}`);
            console.log(`Status: ${mem.status}`);
            console.log(`PID: ${mem.pid}`);
            console.log(`Current Memory: ${mem.memory}`);
            console.log(`Peak Memory: ${mem.memoryPeak}`);
            console.log(`Soft Limit (High): ${mem.memoryHigh}`);
            console.log(`Hard Limit (Max): ${mem.memoryMax}`);
            console.log(`Swap Limit: ${mem.memorySwapMax}`);
            if (targetNames.length > 1) console.log('');
          }
        } else {
          const overview = await getAllServicesMemoryUsage({ group: flags.group });
          if (overview.items.length === 0) {
            if (flags.group) {
              console.log(`No services or schedules found in group "${flags.group}".`);
            } else {
              console.log('No unitup user services or schedules found.');
            }
            break;
          }

          const table = formatTable(overview.items, [
            { key: 'name', label: 'NAME' },
            { key: 'group', label: 'GROUP' },
            { key: 'type', label: 'TYPE' },
            { key: 'status', label: 'STATUS' },
            { key: 'pid', label: 'PID' },
            { key: 'memory', label: 'MEMORY' },
            { key: 'memoryPeak', label: 'PEAK' },
            { key: 'memoryMax', label: 'LIMIT (MAX)' }
          ]);
          console.log(table);
          console.log(`\nTotal Memory Usage across ${overview.runningCount} active app(s): ${overview.totalMemory}`);
        }
        break;
      }

      default: {
        console.error(`Unknown command: "${command}"\n`);
        printHelp();
        process.exitCode = 1;
        break;
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exitCode = 1;
  }
}
