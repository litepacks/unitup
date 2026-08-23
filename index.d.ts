/**
 * unitup - Cross-platform native background service manager (systemd, launchd, Windows Services)
 */

import type { ChildProcess } from 'node:child_process';
import type { EventEmitter } from 'node:events';

/**
 * Options for creating/adding/installing a service.
 */
export interface CreateServiceOptions {
  /**
   * Name of the service (e.g., 'api' or 'worker').
   * Safe characters: lowercase letters, numbers, hyphens, underscores.
   */
  name: string;

  /**
   * Optional display name (used on Windows/macOS where supported).
   */
  displayName?: string;

  /**
   * Optional service description.
   */
  description?: string;

  /**
   * Optional group name (e.g. 'myproject').
   * @default 'default'
   */
  group?: string;

  /**
   * Target runtime name (e.g. 'node', 'python', 'ruby', 'php', 'bun', 'deno', 'shell', 'go', 'elixir', 'native').
   */
  runtime?: string;

  /**
   * Runtime-specific flags/arguments passed before script.
   */
  runtimeArgs?: string[];

  /**
   * Explicit executable command binary path (bypasses runtime auto-detection).
   */
  command?: string;

  /**
   * Absolute or relative path to the target script file.
   */
  script?: string;

  /**
   * Working directory path for the service execution (defaults to script directory).
   */
  cwd?: string;

  /**
   * Absolute path to explicit Node.js executable binary (legacy support).
   */
  nodePath?: string;

  /**
   * Key-value map of environment variables to inject.
   */
  env?: Record<string, string>;

  /**
   * Path to an environment file.
   */
  envFile?: string;

  /**
   * Restart policy string (e.g., 'on-failure', 'always', 'no') or object.
   * @default 'on-failure'
   */
  restart?:
    | string
    | {
        enabled?: boolean;
        policy?: string;
        delay?: number;
        maxRetries?: number | null;
        resetAfter?: number | null;
      };

  /**
   * Positional arguments to pass to the script/command execution line.
   */
  args?: string[];

  /**
   * Automatically enables and starts the service immediately upon creation.
   * @default false
   */
  start?: boolean;

  /**
   * Force overwrite of currently running service.
   * @default false
   */
  force?: boolean;

  /**
   * Install as system-wide daemon (LaunchDaemons on macOS, root systemd on Linux).
   * @default false
   */
  system?: boolean;

  /**
   * Graceful shutdown timeout in milliseconds before force killing child.
   * @default 10000
   */
  shutdownTimeout?: number;

  /**
   * Custom log paths.
   */
  logs?: {
    stdout?: string;
    stderr?: string;
  };

  /**
   * Soft memory limit directive (e.g. '400M').
   */
  memoryHigh?: string;

  /**
   * Hard memory limit directive (e.g. '512M').
   */
  memoryMax?: string;

  /**
   * Swap memory limit directive (e.g. '256M').
   */
  memorySwapMax?: string;

  /**
   * Default memory limit fallback or request marker (defaults to '1G').
   */
  defaultMemory?: string | boolean;
}

export interface InstallServiceOptions extends CreateServiceOptions {}

export interface NormalizedServiceConfig {
  name: string;
  displayName: string;
  description: string;
  runtime: string;
  command: string;
  args: string[];
  script?: string;
  cwd: string;
  env: Record<string, string>;
  envFile?: string;
  autostart: boolean;
  restart: {
    enabled: boolean;
    policy: string;
    delay: number;
    maxRetries?: number | null;
    resetAfter?: number | null;
  };
  logs: {
    stdout: string;
    stderr: string;
  };
  group: string;
  system: boolean;
  shutdownTimeout: number;
  resources: {
    memoryHigh?: string;
    memoryMax?: string;
    memorySwapMax?: string;
  };
  raw?: Record<string, unknown>;
}

export interface PlatformCapabilities {
  serviceManager: 'systemd' | 'launchd' | 'windows' | 'none';
  supports: {
    install: boolean;
    uninstall: boolean;
    start: boolean;
    stop: boolean;
    restart: boolean;
    enable: boolean;
    disable: boolean;
    status: boolean;
    logs: boolean;
    restartPolicy: boolean;
    userServices: boolean;
    systemServices: boolean;
    memoryLimits: boolean;
    schedule: boolean;
  };
}

export interface ServiceStatus {
  name: string;
  installed: boolean;
  state: 'running' | 'stopped' | 'starting' | 'stopping' | 'failed' | 'scheduled' | 'unknown' | string;
  status: string;
  enabled: boolean | string;
  pid: string;
  restarts: string | number;
  started: string;
  startedRaw?: string | null;
  command: string;
  arguments: string;
  args: string[];
  script?: string;
  cwd: string;
  unitFile?: string;
  unitPath?: string;
  platform: 'linux' | 'darwin' | 'win32' | string;
  manager: 'systemd' | 'launchd' | 'windows' | string;
  memory?: string;
  memoryPeak?: string;
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
  details?: Record<string, unknown>;
}

export interface LogOptions {
  follow?: boolean;
  lines?: number;
  cat?: boolean;
  output?: string;
  since?: string;
  until?: string;
  priority?: string;
  grep?: string;
  boot?: boolean;
  json?: boolean;
  diskUsage?: boolean;
  system?: boolean;
}

export interface AppMetadata {
  name: string;
  runtime: string;
  command: string;
  args: string[];
  cwd: string;
  group?: string;
  script?: string;
  pid?: string;
  restarts?: string;
  started?: string;
  logs?: {
    stdout?: string;
    stderr?: string;
  };
  resources?: {
    memoryHigh?: string;
    memoryMax?: string;
    memorySwapMax?: string;
  };
  [key: string]: unknown;
}

export interface DoctorInfo {
  platform: string;
  systemdAvailable: boolean;
  systemctlAvailable: boolean;
  linux: boolean;
  systemdRunning: boolean;
  userSystemdAvailable: boolean;
  lingering: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
  nodeValid: boolean;
  username: string;
  unitDir: string;
  unitDirWritable: boolean;
  [key: string]: unknown;
}

export interface ListServiceItem {
  name: string;
  status: string;
  enabled?: boolean | string;
  pid?: string;
  command?: string;
  [key: string]: unknown;
}

export interface NodeDiagnostics {
  found: boolean;
  path: string | null;
  version: string | null;
  valid: boolean;
  error?: string;
}

export interface ServiceFailure {
  name: string;
  group: string;
  status: string;
  exitCode: string;
  restarts: string;
  uptime: string;
}

// Error Classes
export class UnitupError extends Error {
  code: string;
}
export class UnsupportedPlatformError extends UnitupError {
  platform: string;
}
export class ServiceNotFoundError extends UnitupError {
  serviceName: string;
}
export class ServiceAlreadyExistsError extends UnitupError {
  serviceName: string;
}
export class PermissionRequiredError extends UnitupError {
  action?: string;
}
export class ServiceStartError extends UnitupError {
  serviceName: string;
  reason?: string;
}
export class ServiceStopError extends UnitupError {
  serviceName: string;
  reason?: string;
}
export class InvalidServiceConfigError extends UnitupError {
  field?: string;
}
export class ExecutableNotFoundError extends UnitupError {
  executable: string;
}

// Adapters
export abstract class ServiceAdapter {
  constructor(options?: Record<string, unknown>);
  readonly name: string;
  readonly capabilities: PlatformCapabilities;
  abstract generateService(config: NormalizedServiceConfig): string | Record<string, unknown>;
  abstract install(
    config: NormalizedServiceConfig,
    options?: Record<string, unknown>
  ): Promise<{ name: string; unitPath?: string; serviceName?: string }>;
  abstract uninstall(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract start(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract stop(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract restart(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract enable(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract disable(name: string, options?: Record<string, unknown>): Promise<boolean>;
  abstract status(name: string, options?: Record<string, unknown>): Promise<ServiceStatus>;
  abstract inspect(name: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  abstract logs(name: string, options?: LogOptions): Promise<string | EventEmitter | ChildProcess>;
  abstract list(options?: { group?: string }): Promise<Array<Record<string, unknown>>>;
  abstract isInstalled(name: string, options?: Record<string, unknown>): Promise<boolean> | boolean;
  abstract failures(options?: Record<string, unknown>): Promise<ServiceFailure[]>;
}

export class LinuxAdapter extends ServiceAdapter {}
export class MacOSAdapter extends ServiceAdapter {}
export class WindowsAdapter extends ServiceAdapter {}
export class WindowsServiceHost {
  constructor(config?: Record<string, unknown>);
  start(): void;
  stop(timeout?: number): Promise<void>;
}

export class ServiceManager {
  constructor(opts?: { platform?: string; adapter?: ServiceAdapter });
  readonly capabilities: PlatformCapabilities;
  generate(rawOpts?: CreateServiceOptions): Promise<string | Record<string, unknown>>;
  install(rawOpts: CreateServiceOptions): Promise<{ name: string; unitPath?: string; serviceName?: string }>;
  uninstall(name: string, options?: { force?: boolean; system?: boolean }): Promise<boolean>;
  start(name: string, options?: { enable?: boolean; system?: boolean }): Promise<boolean>;
  stop(name: string, options?: { system?: boolean }): Promise<boolean>;
  restart(name: string, options?: { system?: boolean }): Promise<boolean>;
  enable(name: string, options?: { system?: boolean }): Promise<boolean>;
  disable(name: string, options?: { system?: boolean }): Promise<boolean>;
  status(name: string, options?: { system?: boolean }): Promise<ServiceStatus>;
  inspect(name: string, options?: { system?: boolean }): Promise<Record<string, unknown>>;
  logs(name: string, options?: LogOptions): Promise<string | EventEmitter | ChildProcess>;
  list(options?: { group?: string }): Promise<Array<Record<string, unknown>>>;
  failures(options?: Record<string, unknown>): Promise<ServiceFailure[]>;
  isInstalled(name: string, options?: Record<string, unknown>): Promise<boolean> | boolean;
}

export const defaultManager: ServiceManager;

// Unified API functions
export function install(options: CreateServiceOptions): Promise<{ name: string; unitPath?: string }>;
export function uninstall(name: string, options?: { force?: boolean; system?: boolean }): Promise<boolean>;
export function start(name: string, options?: { enable?: boolean; system?: boolean }): Promise<boolean>;
export function stop(name: string, options?: { system?: boolean }): Promise<boolean>;
export function restart(name: string, options?: { system?: boolean }): Promise<boolean>;
export function status(name: string, options?: { system?: boolean }): Promise<ServiceStatus>;
export function list(options?: { group?: string }): Promise<Array<Record<string, unknown>>>;
export function inspect(name: string, options?: { system?: boolean }): Promise<Record<string, unknown>>;
export function logs(name: string, options?: LogOptions): Promise<string | EventEmitter | ChildProcess>;
export function enable(name: string, options?: { system?: boolean }): Promise<boolean>;
export function disable(name: string, options?: { system?: boolean }): Promise<boolean>;
export function platform(targetPlatform?: string): PlatformCapabilities;

export function getAdapter(platform?: string, options?: Record<string, unknown>): ServiceAdapter;
export function getPlatformCapabilities(platform?: string): PlatformCapabilities;
export function normalizeServiceConfig(rawOpts?: Record<string, unknown>): Promise<NormalizedServiceConfig>;
export function resolveExecutable(binaryName: string, opts?: { cwd?: string; pathEnv?: string }): string | null;
export function readServiceLogs(filePaths: string | string[], options?: LogOptions): Promise<string | EventEmitter>;

// Backward-compatible API
export function createService(options: CreateServiceOptions): Promise<{ name: string; unitPath: string }>;
export function addService(options: CreateServiceOptions): Promise<{ name: string; unitPath: string }>;
export function startService(name: string, enable?: boolean): Promise<boolean>;
export function stopService(name: string): Promise<boolean>;
export function restartService(name: string): Promise<boolean>;
export function removeService(name: string, options?: boolean | { force?: boolean }): Promise<boolean>;
export function getServiceStatus(name: string): Promise<ServiceStatus>;
export function getServiceStatusRaw(name: string): Promise<string>;
export function listServices(filterOpts?: { group?: string }): Promise<ListServiceItem[]>;
export function inspectService(name: string): Promise<Record<string, unknown>>;
export function getServiceFailures(): Promise<ServiceFailure[]>;
export function getServicesByGroup(groupName: string): Promise<string[]>;
export function setServiceLimits(name: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
export function getServiceMemoryUsage(name: string): Promise<Record<string, unknown>>;
export function getAllServicesMemoryUsage(opts?: { group?: string }): Promise<Record<string, unknown>>;
export function executeJournalctlMaintenance(action: string, opts?: Record<string, unknown>): Promise<string>;
export function getServiceLogs(name: string, opts?: LogOptions): Promise<string | ChildProcess>;
export function runJournalctlLogs(name: string, opts?: LogOptions): Promise<string | ChildProcess>;

// Runtimes & Helpers
export function detectRuntime(filepath: string, opts?: Record<string, unknown>): string;
export function resolveRuntimeConfig(
  opts?: Record<string, unknown>
): Promise<{ command: string; args: string[]; runtime: string; version: string }>;
export function sanitizeServiceName(name: string): string;
export function formatTable(
  data: Array<Record<string, unknown>>,
  columns: Array<{ key: string; label: string }>
): string;
export function formatMemoryBytes(bytes: number | string): string;
export function validateMemorySize(val: string | number, paramName?: string): string;
export function validateDuration(val: string | number, paramName?: string): string;

// Config helpers
export function findProjectConfig(dirPath?: string): string | null;
export function readProjectConfig(filePathOrDir?: string): Record<string, unknown> | null;
export function saveProjectConfig(dirPathOrFile?: string, config?: Record<string, unknown>): string;
export function readAppMetadata(name: string): AppMetadata | null;
export function getAppMetadataPath(name: string): string;
export function getAppsDir(): string;
export function getUnitupDir(): string;
export function readGlobalConfig(): Record<string, unknown>;
export function saveGlobalConfig(config: Record<string, unknown>): Record<string, unknown>;
export function getConfigFilepath(): string;
export function resolveEffectiveMemoryLimits(opts?: Record<string, unknown>): {
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
};

// Doctor & Diagnostics
export function isSystemdAvailable(): Promise<boolean>;
export function isSystemctlAvailable(): Promise<boolean>;
export function isLinux(): boolean;
export function isSystemdPID1(): Promise<boolean>;
export function isUserSystemdAvailable(): Promise<boolean>;
export function checkUserLinger(): Promise<boolean>;
export function checkNodeDiagnostics(customNodePath?: string): Promise<NodeDiagnostics>;
export function findNodeExecutable(customPath?: string): Promise<string | null>;
export function getDoctorInfo(): Promise<DoctorInfo>;
export function runDoctor(): Promise<DoctorInfo>;

// Testing runner overrides
export type CommandRunnerFn = (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string; code: number }>;
export function setCommandRunner(runner: CommandRunnerFn): void;
export function resetCommandRunner(): void;
export function runCommand(
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>
): Promise<{ stdout: string; stderr: string; code: number }>;

// Unit / Plist helpers
export function getUserUnitDir(): string;
export function getUnitPath(name: string): string;
export function unitFileExists(name: string): boolean;
export function parseUnitContent(content: string): Record<string, unknown>;
export function getUnitFilename(name: string): string;
export function getTimerFilename(name: string): string;
export function getServiceNameFromUnit(unitFilename: string): string;
export function generateTimerContent(opts: Record<string, unknown>): string;
export function generateScheduleServiceContent(opts: Record<string, unknown>): string;
export function getTimerPath(name: string): string;
export function timerFileExists(name: string): boolean;

// Schedules
export function createSchedule(options: Record<string, unknown>): Promise<Record<string, unknown>>;
export function listSchedules(group?: string): Promise<Array<Record<string, unknown>>>;
export function getScheduleStatus(name: string): Promise<Record<string, unknown>>;
export function runSchedule(name: string): Promise<boolean>;
export function enableSchedule(name: string): Promise<boolean>;
export function disableSchedule(name: string): Promise<boolean>;
export function removeSchedule(name: string, options?: { force?: boolean }): Promise<boolean>;
export function validateCalendar(expression: string): Promise<{ valid: boolean; error?: string; warning?: string }>;
export function readScheduleMetadata(name: string): Record<string, unknown> | null;
export function getScheduleMetadataPath(name: string): string;
export function getSchedulesDir(): string;

export default defaultManager;
