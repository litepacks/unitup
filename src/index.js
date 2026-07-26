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
  getUserUnitDir,
  getUnitPath,
  unitFileExists,
  parseUnitContent
} from './unit.js';
import {
  sanitizeServiceName,
  getUnitFilename,
  getServiceNameFromUnit,
  readAppMetadata,
  getAppMetadataPath,
  getAppsDir,
  getUnitupDir,
  validateMemorySize,
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

  // Memory & Validation helpers
  validateMemorySize,
  formatMemoryBytes,

  // Runtime detection & resolution
  detectRuntime,
  resolveRuntimeConfig,

  // Metadata helpers
  readAppMetadata,
  getAppMetadataPath,
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
  unitFileExists,
  parseUnitContent,
  sanitizeServiceName,
  getUnitFilename,
  getServiceNameFromUnit,

  // Runner override for testing
  setCommandRunner,
  resetCommandRunner
};
