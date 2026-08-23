import { getDoctorInfo, runDoctor } from './doctor.js';
import {
  ExecutableNotFoundError,
  InvalidServiceConfigError,
  PermissionRequiredError,
  ServiceAlreadyExistsError,
  ServiceNotFoundError,
  ServiceStartError,
  ServiceStopError,
  UnitupError,
  UnsupportedPlatformError
} from './errors.js';
import { readServiceLogs } from './logs.js';
import {
  LinuxAdapter,
  MacOSAdapter,
  ServiceAdapter,
  WindowsAdapter,
  getAdapter,
  getPlatformCapabilities
} from './platform/index.js';
import { WindowsServiceHost } from './platform/windows-host.js';
import { detectRuntime, resolveRuntimeConfig } from './runtimes/index.js';
import {
  createSchedule,
  disableSchedule,
  enableSchedule,
  getScheduleStatus,
  listSchedules,
  removeSchedule,
  runSchedule,
  validateCalendar
} from './schedule.js';
import { ServiceManager, defaultManager } from './service/manager.js';
import { normalizeServiceConfig, resolveExecutable } from './service/normalize.js';
import {
  addService,
  checkNodeDiagnostics,
  checkUserLinger,
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
  isSystemdPID1,
  isUserSystemdAvailable,
  listServices,
  removeService,
  resetCommandRunner,
  restartService,
  runCommand,
  runJournalctlLogs,
  setCommandRunner,
  setServiceLimits,
  startService,
  stopService
} from './systemd.js';
import {
  generateScheduleServiceContent,
  generateTimerContent,
  getTimerPath,
  getUnitPath,
  getUserUnitDir,
  parseUnitContent,
  timerFileExists,
  unitFileExists
} from './unit.js';
import {
  findProjectConfig,
  formatMemoryBytes,
  getAppMetadataPath,
  getAppsDir,
  getConfigFilepath,
  getScheduleMetadataPath,
  getSchedulesDir,
  getServiceNameFromUnit,
  getTimerFilename,
  getUnitFilename,
  getUnitupDir,
  readAppMetadata,
  readGlobalConfig,
  readProjectConfig,
  readScheduleMetadata,
  resolveEffectiveMemoryLimits,
  sanitizeServiceName,
  saveGlobalConfig,
  saveProjectConfig,
  validateDuration,
  validateMemorySize
} from './utils.js';

// Aliases for unified cross-platform API
const install = (opts) => defaultManager.install(opts);
const uninstall = (name, opts) => defaultManager.uninstall(name, opts);
const start = (name, opts) => defaultManager.start(name, opts);
const stop = (name, opts) => defaultManager.stop(name, opts);
const restart = (name, opts) => defaultManager.restart(name, opts);
const status = (name, opts) => defaultManager.status(name, opts);
const list = (opts) => defaultManager.list(opts);
const inspect = (name, opts) => defaultManager.inspect(name, opts);
const logs = (name, opts) => defaultManager.logs(name, opts);
const enable = (name, opts) => defaultManager.enable(name, opts);
const disable = (name, opts) => defaultManager.disable(name, opts);
const platform = (targetPlatform) => getPlatformCapabilities(targetPlatform);

export {
  // Unified cross-platform API
  install,
  uninstall,
  start,
  stop,
  restart,
  status,
  list,
  inspect,
  logs,
  enable,
  disable,
  platform,
  ServiceManager,
  defaultManager,
  // Platform Adapters & Factory
  ServiceAdapter,
  LinuxAdapter,
  MacOSAdapter,
  WindowsAdapter,
  WindowsServiceHost,
  getAdapter,
  getPlatformCapabilities,
  // Normalization & Resolution
  normalizeServiceConfig,
  resolveExecutable,
  readServiceLogs,
  // Error hierarchy
  UnitupError,
  UnsupportedPlatformError,
  ServiceNotFoundError,
  ServiceAlreadyExistsError,
  PermissionRequiredError,
  ServiceStartError,
  ServiceStopError,
  InvalidServiceConfigError,
  ExecutableNotFoundError,
  // Main programmatic service management API (backward compatible)
  addService as createService,
  addService,
  startService,
  stopService,
  restartService,
  removeService,
  getServiceStatus,
  getServiceStatusRaw,
  listServices,
  inspectService,
  getServiceFailures,
  getServicesByGroup,
  setServiceLimits,
  getServiceMemoryUsage,
  getAllServicesMemoryUsage,
  executeJournalctlMaintenance,
  runJournalctlLogs as getServiceLogs,
  runJournalctlLogs,
  // Programmatic schedule management API
  createSchedule,
  listSchedules,
  getScheduleStatus,
  runSchedule,
  enableSchedule,
  disableSchedule,
  removeSchedule,
  validateCalendar,
  // Duration & Validation helpers
  validateMemorySize,
  validateDuration,
  formatMemoryBytes,
  // Runtime detection & resolution
  detectRuntime,
  resolveRuntimeConfig,
  // Metadata & Config helpers
  readAppMetadata,
  getAppMetadataPath,
  readScheduleMetadata,
  getScheduleMetadataPath,
  readGlobalConfig,
  saveGlobalConfig,
  getConfigFilepath,
  findProjectConfig,
  readProjectConfig,
  saveProjectConfig,
  resolveEffectiveMemoryLimits,
  getSchedulesDir,
  getAppsDir,
  getUnitupDir,
  // System & Doctor checks
  isSystemctlAvailable as isSystemdAvailable,
  isSystemctlAvailable,
  isLinux,
  isSystemdPID1,
  isUserSystemdAvailable,
  checkUserLinger,
  checkNodeDiagnostics,
  findNodeExecutable,
  getDoctorInfo,
  runDoctor,
  // Unit file & path helpers
  getUserUnitDir,
  getUnitPath,
  getTimerPath,
  unitFileExists,
  timerFileExists,
  parseUnitContent,
  generateTimerContent,
  generateScheduleServiceContent,
  sanitizeServiceName,
  getUnitFilename,
  getTimerFilename,
  getServiceNameFromUnit,
  // Runner override for testing
  setCommandRunner,
  resetCommandRunner,
  runCommand
};

export default defaultManager;
