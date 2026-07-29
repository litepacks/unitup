import {
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
  runJournalctlLogs,
  setServiceLimits,
  executeJournalctlMaintenance,
  isLinux,
  isSystemctlAvailable,
  isSystemdPID1,
  isUserSystemdAvailable,
  checkUserLinger,
  checkNodeDiagnostics,
  findNodeExecutable,
  setCommandRunner,
  resetCommandRunner
} from './systemd.js';
import { getDoctorInfo } from './doctor.js';
import {
  createSchedule,
  listSchedules,
  getScheduleStatus,
  runSchedule,
  enableSchedule,
  disableSchedule,
  removeSchedule,
  validateCalendar
} from './schedule.js';
import {
  getUserUnitDir,
  getUnitPath,
  getTimerPath,
  unitFileExists,
  timerFileExists,
  parseUnitContent,
  generateTimerContent,
  generateScheduleServiceContent
} from './unit.js';
import {
  sanitizeServiceName,
  getUnitFilename,
  getTimerFilename,
  getServiceNameFromUnit,
  readAppMetadata,
  getAppMetadataPath,
  readScheduleMetadata,
  getScheduleMetadataPath,
  readGlobalConfig,
  saveGlobalConfig,
  getConfigFilepath,
  resolveEffectiveMemoryLimits,
  getSchedulesDir,
  getAppsDir,
  getUnitupDir,
  validateMemorySize,
  validateDuration,
  formatMemoryBytes
} from './utils.js';
import { detectRuntime, resolveRuntimeConfig } from './runtimes/index.js';

export {
  // Main programmatic service management API
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
  executeJournalctlMaintenance as executeJournalctlMaintenance,
  runJournalctlLogs as getServiceLogs,

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
  resetCommandRunner
};
