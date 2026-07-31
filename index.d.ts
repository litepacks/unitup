/**
 * unitup - Systemd user service manager for any executable & runtime
 */

import { ChildProcess } from 'node:child_process';

/**
 * Options for creating/adding a systemd user service.
 */
export interface CreateServiceOptions {
  /**
   * Name of the service (e.g., 'api' or 'worker').
   * Safe characters: lowercase letters, numbers, hyphens, underscores.
   */
  name: string;

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
   * Runtime-specific flags/arguments passed before script (e.g. ['--allow-net'] for Deno or ['-S', '0.0.0.0:8080'] for PHP).
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
   * Key-value map of environment variables to inject into the systemd unit.
   */
  env?: Record<string, string>;

  /**
   * Path to an environment file (adds EnvironmentFile=... directive).
   */
  envFile?: string;

  /**
   * Systemd restart policy directive (e.g., 'on-failure', 'always', 'no', 'on-abnormal').
   * @default 'on-failure'
   */
  restart?: string;

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

/**
 * Options for setting or resetting service memory limits.
 */
export interface ServiceLimitsOptions {
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
   * Resets all memory limits back to defaults/infinity.
   * @default false
   */
  resetMemory?: boolean;
}

/**
 * Options for retrieving journalctl log output.
 */
export interface LogOptions {
  /**
   * Live streaming follow mode (-f).
   * @default false
   */
  follow?: boolean;

  /**
   * Number of journal log lines to return (-n).
   * @default 100
   */
  lines?: number;

  /**
   * Raw unformatted console output (-o cat) without systemd metadata prefix.
   * @default false
   */
  cat?: boolean;

  /**
   * Journalctl output mode (e.g. 'cat', 'short', 'json').
   */
  output?: string;
}

/**
 * Parsed compact service status summary.
 */
export interface ServiceStatus {
  /**
   * Clean service name (e.g. 'api').
   */
  name: string;

  /**
   * Full systemd unit filename (e.g. 'unitup-api.service').
   */
  unitFile: string;

  /**
   * Status overview ('running', 'stopped', 'failed', 'exited', etc.).
   */
  status: string;

  /**
   * Raw ActiveState string from systemctl show.
   */
  activeState: string;

  /**
   * Raw SubState string from systemctl show.
   */
  subState: string;

  /**
   * Main Process ID (PID) of the service, or '-' if stopped.
   */
  pid: string;

  /**
   * Total number of restarts recorded by systemd.
   */
  restarts: string;

  /**
   * Relative formatted uptime/started string (e.g. '12 minutes ago').
   */
  started: string;

  /**
   * Raw timestamp from systemctl show.
   */
  startedRaw?: string;

  /**
   * Executable command path.
   */
  command: string;

  /**
   * Command arguments string.
   */
  arguments: string;

  /**
   * Array of command arguments.
   */
  args: string[];

  /**
   * Path to target script parsed from unit file.
   */
  script: string;

  /**
   * Working directory parsed from unit file.
   */
  cwd: string;
}

/**
 * Service item in list overview.
 */
export interface ListServiceItem {
  /**
   * Service name.
   */
  name: string;

  /**
   * Runtime name.
   */
  runtime: string;

  /**
   * Group name.
   */
  group: string;

  /**
   * Status overview ('running', 'stopped', 'failed', etc.).
   */
  status: string;

  /**
   * Enabled status ('yes' or 'no').
   */
  enabled: string;

  /**
   * Main PID or '-'.
   */
  pid: string;

  /**
   * Command summary (e.g. 'node server.js' or 'python3 worker.py').
   */
  command: string;

  /**
   * Formatted uptime string.
   */
  uptime: string;

  /**
   * Restart count.
   */
  restarts: string;
}

/**
 * App metadata saved in ~/.config/unitup/apps/<name>.json.
 */
export interface AppMetadata {
  name: string;
  unit: string;
  runtime?: string;
  command?: string;
  args?: string[];
  group: string;
  script: string;
  cwd: string;
  node: string;
}

/**
 * Detailed application inspection summary (unitup inspect).
 */
export interface InspectInfo {
  name: string;
  runtime: string;
  unit: string;
  unitPath: string;
  group: string;
  status: string;
  activeState: string;
  subState: string;
  command: string;
  arguments: string;
  args: string[];
  cwd: string;
  pid: string;
  restarts: string;
  started: string;

  memory?: string;
  memoryPeak?: string;
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;

  // Legacy compatibility fields
  script?: string;
  node?: string;
}

/**
 * Failed service failure report item (unitup failures).
 */
export interface FailureItem {
  name: string;
  group: string;
  status: string;
  exitCode: string;
  restarts: string;
  uptime: string;
}

/**
 * Diagnostic results for Node.js runtime environment.
 */
export interface NodeDiagnostics {
  found: boolean;
  executable: boolean;
  execPath: string;
  whichPath: string;
  version: string;
  inPath: boolean;
  error: string | null;
  solution: string | null;
}

/**
 * Diagnostic report object from unitup doctor.
 */
export interface DoctorInfo {
  linux: boolean;
  systemctl: boolean;
  systemdRunning: boolean;
  userSystemdAvailable: boolean;
  cgroupV2?: boolean;
  memoryController?: boolean;
  memoryMaxSupported?: boolean;
  memorySwapMaxSupported?: boolean;
  nodeDiag: NodeDiagnostics;
  nodePath: string;
  nodeVersion: string;
  runtimes: Record<string, string | null>;
  unitDir: string;
  unitDirWritable: boolean;
  lingering: boolean;
  username: string;
}

/**
 * Result returned when creating/adding a new unitup service.
 */
export interface AddServiceResult {
  name: string;
  unitPath: string;
}

/**
 * Parsed systemd unit file content metadata.
 */
export interface ParsedUnitContent {
  command?: string;
  args?: string[];
  script?: string;
  cwd?: string;
  restart?: string;
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
}

/**
 * Command runner function definition used for internal mocking.
 */
export type CommandRunnerFn = (
  cmd: string,
  args: string[],
  opts?: Record<string, unknown>
) => Promise<{ stdout: string; stderr: string; code: number }>;

// ---------------------------------------------------------------------------
// Programmatic API Function Declarations
// ---------------------------------------------------------------------------

export function createService(options: CreateServiceOptions): Promise<AddServiceResult>;
export function addService(options: CreateServiceOptions): Promise<AddServiceResult>;
export function startService(name: string, enable?: boolean): Promise<boolean>;
export function stopService(name: string): Promise<boolean>;
export function restartService(name: string): Promise<boolean>;
export function removeService(name: string, options?: { force?: boolean } | boolean): Promise<boolean>;
export function getServiceStatus(name: string): Promise<ServiceStatus>;
export function getServiceStatusRaw(name: string): Promise<string>;
export function listServices(options?: { group?: string }): Promise<ListServiceItem[]>;
export function inspectService(name: string): Promise<InspectInfo>;
export function getServiceFailures(): Promise<FailureItem[]>;
export function getServicesByGroup(groupName: string): Promise<string[]>;
export function setServiceLimits(name: string, options?: ServiceLimitsOptions): Promise<InspectInfo>;
export function getServiceMemoryUsage(name: string): Promise<{
  name: string;
  group: string;
  type: string;
  status: string;
  pid: string;
  memoryBytes: number;
  memory: string;
  memoryPeak: string;
  memoryHigh: string;
  memoryMax: string;
  memorySwapMax: string;
}>;
export function getAllServicesMemoryUsage(options?: { group?: string }): Promise<{
  items: Array<{
    name: string;
    group: string;
    type: string;
    status: string;
    pid: string;
    memory: string;
    memoryPeak: string;
    memoryMax: string;
    memoryHigh: string;
    memoryBytes: number;
  }>;
  totalBytes: number;
  totalMemory: string;
  runningCount: number;
}>;
export function executeJournalctlMaintenance(action: string, options?: Record<string, unknown>): Promise<string>;
export function getServiceLogs(name: string, options?: LogOptions): Promise<string | ChildProcess>;

// Validation & Formatting Helpers
export function validateMemorySize(val: string | number, paramName?: string): string;
export function formatMemoryBytes(bytes: number | string): string;

// Runtime Helpers
export function detectRuntime(filepath: string): string;
export function resolveRuntimeConfig(options: CreateServiceOptions): Promise<{
  command: string;
  args: string[];
  runtime: string;
  version: string;
}>;

// Diagnostics & Doctor
export function isSystemdAvailable(): Promise<boolean>;
export function isSystemctlAvailable(): Promise<boolean>;
export function isLinux(): boolean;
export function isSystemdPID1(): Promise<boolean>;
export function isUserSystemdAvailable(): Promise<boolean>;
export function checkUserLinger(): Promise<boolean>;
export function checkNodeDiagnostics(customNodePath?: string): Promise<NodeDiagnostics>;
export function findNodeExecutable(customPath?: string): Promise<string | null>;
export function getDoctorInfo(): Promise<DoctorInfo>;

export interface ProjectConfig {
  name?: string;
  group?: string;
  script?: string;
  command?: string;
  runtime?: string;
  runtimeArgs?: string[];
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  restart?: string;
  resources?: {
    memoryHigh?: string;
    memoryMax?: string;
    memorySwapMax?: string;
  };
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
}

export function findProjectConfig(dirPath?: string): string | null;
export function readProjectConfig(filePathOrDir?: string): ProjectConfig | null;
export function saveProjectConfig(dirPathOrFile?: string, config?: ProjectConfig): string;

// Path & Unit Helpers
export function getUserUnitDir(): string;
export function getUnitPath(name: string): string;
export function unitFileExists(name: string): boolean;
export function parseUnitContent(content: string): ParsedUnitContent;
export function sanitizeServiceName(name: string): string;
export function getUnitFilename(name: string): string;
export function getServiceNameFromUnit(unitFilename: string): string;
export function readAppMetadata(name: string): AppMetadata | null;
export function getAppMetadataPath(name: string): string;
export function getAppsDir(): string;
export function getUnitupDir(): string;

// Testing Mock Helpers
export function setCommandRunner(runner: CommandRunnerFn): void;
export function resetCommandRunner(): void;

// ---------------------------------------------------------------------------
// Schedule Management API
// ---------------------------------------------------------------------------

export interface CreateScheduleOptions {
  name?: string;
  script?: string;
  command?: string;
  runtime?: string;
  args?: string[];
  runtimeArgs?: string[];
  cwd?: string;
  env?: Record<string, string> | string[];
  envFile?: string;
  group?: string;
  memoryHigh?: string;
  memoryMax?: string;
  memorySwapMax?: string;
  defaultMemory?: string | boolean;
  every?: string;
  calendar?: string;
  onBoot?: string;
  onActive?: string;
  randomDelay?: string;
  persistent?: boolean;
  start?: boolean;
  enable?: boolean;
}

export interface ScheduleMetadata {
  name: string;
  group: string;
  type: string;
  runtime: string;
  command: string;
  args: string[];
  cwd: string;
  schedule: {
    every: string | null;
    calendar: string | null;
    onBoot: string | null;
    onActive: string | null;
    persistent: boolean;
    randomDelay: string | null;
  };
  serviceUnit: string;
  timerUnit: string;
}

export interface ScheduleStatus {
  name: string;
  group: string;
  schedule: string;
  nextRun: string;
  lastRun: string;
  status: string;
  activeState: string;
  subState: string;
  unitFileState: string;
  serviceActiveState: string;
  metadata?: ScheduleMetadata | null;
  serviceUnit: string;
  timerUnit: string;
}

export interface CreateScheduleResult {
  name: string;
  group: string;
  type: string;
  runtime: string;
  command: string;
  args: string[];
  cwd: string;
  schedule: Record<string, unknown>;
  serviceUnit: string;
  timerUnit: string;
  servicePath: string;
  timerPath: string;
}

export function createSchedule(options: CreateScheduleOptions): Promise<CreateScheduleResult>;
export function listSchedules(group?: string): Promise<ScheduleStatus[]>;
export function getScheduleStatus(name: string): Promise<ScheduleStatus>;
export function runSchedule(name: string): Promise<boolean>;
export function enableSchedule(name: string): Promise<boolean>;
export function disableSchedule(name: string): Promise<boolean>;
export function removeSchedule(name: string, options?: { force?: boolean }): Promise<boolean>;
export function validateCalendar(expression: string): Promise<{ valid: boolean; error?: string; warning?: string }>;
export function validateDuration(val: string | number, paramName?: string): string;
export function getTimerFilename(name: string): string;
export function getTimerPath(name: string): string;
export function timerFileExists(name: string): boolean;
export function readScheduleMetadata(name: string): ScheduleMetadata | null;
export function getScheduleMetadataPath(name: string): string;
export function getSchedulesDir(): string;
export function readGlobalConfig(): Record<string, unknown>;
export function saveGlobalConfig(config: Record<string, unknown>): Record<string, unknown>;
export function getConfigFilepath(): string;
export function resolveEffectiveMemoryLimits(opts?: Record<string, unknown>): { memoryHigh?: string; memoryMax?: string; memorySwapMax?: string };


