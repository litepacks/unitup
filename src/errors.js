/**
 * Base error class for all Unitup errors.
 */
export class UnitupError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'UNITUP_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Thrown when an unsupported platform is encountered.
 */
export class UnsupportedPlatformError extends UnitupError {
  /**
   * @param {string} [platform]
   */
  constructor(platform = process.platform) {
    super(`Platform "${platform}" is not supported by Unitup.`, 'ERR_UNSUPPORTED_PLATFORM');
    this.platform = platform;
  }
}

/**
 * Thrown when a specified service is not found.
 */
export class ServiceNotFoundError extends UnitupError {
  /**
   * @param {string} name
   */
  constructor(name) {
    super(`Service "${name}" does not exist.`, 'ERR_SERVICE_NOT_FOUND');
    this.serviceName = name;
  }
}

/**
 * Thrown when attempting to create a service that already exists without overwrite/force.
 */
export class ServiceAlreadyExistsError extends UnitupError {
  /**
   * @param {string} name
   */
  constructor(name) {
    super(`Service "${name}" already exists. Use --force to overwrite.`, 'ERR_SERVICE_ALREADY_EXISTS');
    this.serviceName = name;
  }
}

/**
 * Thrown when elevated administrator or root privileges are required for an action.
 */
export class PermissionRequiredError extends UnitupError {
  /**
   * @param {string} message
   * @param {string} [action]
   */
  constructor(message = 'Administrator/root privileges are required to perform this action.', action) {
    super(message, 'ERR_PERMISSION_REQUIRED');
    this.action = action;
  }
}

/**
 * Thrown when a service fails to start.
 */
export class ServiceStartError extends UnitupError {
  /**
   * @param {string} name
   * @param {string} [reason]
   */
  constructor(name, reason) {
    super(`Failed to start service "${name}"${reason ? `: ${reason}` : ''}`, 'ERR_SERVICE_START');
    this.serviceName = name;
    this.reason = reason;
  }
}

/**
 * Thrown when a service fails to stop.
 */
export class ServiceStopError extends UnitupError {
  /**
   * @param {string} name
   * @param {string} [reason]
   */
  constructor(name, reason) {
    super(`Failed to stop service "${name}"${reason ? `: ${reason}` : ''}`, 'ERR_SERVICE_STOP');
    this.serviceName = name;
    this.reason = reason;
  }
}

/**
 * Thrown when service configuration is invalid.
 */
export class InvalidServiceConfigError extends UnitupError {
  /**
   * @param {string} message
   * @param {string} [field]
   */
  constructor(message, field) {
    super(message, 'ERR_INVALID_CONFIG');
    this.field = field;
  }
}

/**
 * Thrown when a required binary executable cannot be resolved.
 */
export class ExecutableNotFoundError extends UnitupError {
  /**
   * @param {string} executable
   * @param {string} [message]
   */
  constructor(executable, message) {
    super(
      message || `Executable "${executable}" could not be found in PATH or at specified path.`,
      'ERR_EXECUTABLE_NOT_FOUND'
    );
    this.executable = executable;
  }
}
