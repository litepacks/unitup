import fs from 'node:fs';
import path from 'node:path';
import { getUnitupDir, sanitizeServiceName } from '../utils.js';

export class DeploymentLockError extends Error {
  constructor(message, service, lockedPid) {
    super(message);
    this.name = 'DeploymentLockError';
    this.service = service;
    this.lockedPid = lockedPid;
  }
}

/**
 * Manages per-service deployment locks to prevent concurrent deployments.
 */
export class DeploymentLock {
  /**
   * @param {object} [options]
   * @param {string} [options.lockDir]
   * @param {import('./process-manager.js').ProcessManager} [options.processManager]
   */
  constructor(options = {}) {
    this.lockDir = options.lockDir || path.join(getUnitupDir(), 'locks');
    this.processManager = options.processManager;
    this._heldLocks = new Set();
  }

  getLockFilePath(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    return path.join(this.lockDir, `${safeName}.deploy.lock`);
  }

  /**
   * Acquires the deployment lock for a service.
   * Throws DeploymentLockError if already locked by an active process.
   *
   * @param {string} serviceName
   * @returns {Promise<boolean>}
   */
  async acquire(serviceName) {
    const safeName = sanitizeServiceName(serviceName);

    if (this._heldLocks.has(safeName)) {
      throw new DeploymentLockError(
        `Deployment already in progress for service "${safeName}" (PID ${process.pid}).`,
        safeName,
        process.pid
      );
    }

    const lockPath = this.getLockFilePath(safeName);

    if (!fs.existsSync(this.lockDir)) {
      fs.mkdirSync(this.lockDir, { recursive: true });
    }

    if (fs.existsSync(lockPath)) {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const info = JSON.parse(raw);
        const lockedPid = Number(info.pid);

        // Check if the holding process is still alive
        let isAlive = false;
        if (this.processManager) {
          isAlive = this.processManager.isAlive(lockedPid);
        } else if (lockedPid > 0) {
          try {
            process.kill(lockedPid, 0);
            isAlive = true;
          } catch (err) {
            isAlive = err.code === 'EPERM';
          }
        }

        if (isAlive) {
          throw new DeploymentLockError(
            `Deployment already in progress for service "${safeName}" (PID ${lockedPid}).`,
            safeName,
            lockedPid
          );
        }

        // Process is dead: break stale lock
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      } catch (err) {
        if (err instanceof DeploymentLockError) {
          throw err;
        }
        // Stale or corrupted lock file, overwrite
      }
    }

    const payload = {
      service: safeName,
      pid: process.pid,
      timestamp: new Date().toISOString()
    };

    fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
    this._heldLocks.add(safeName);
    return true;
  }

  /**
   * Releases the deployment lock for a service.
   *
   * @param {string} serviceName
   * @returns {Promise<boolean>}
   */
  async release(serviceName) {
    const safeName = sanitizeServiceName(serviceName);
    const lockPath = this.getLockFilePath(safeName);

    this._heldLocks.delete(safeName);

    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }

    return true;
  }
}
