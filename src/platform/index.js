import { UnsupportedPlatformError } from '../errors.js';
import { ServiceAdapter } from './base.js';
import { LinuxAdapter } from './linux.js';
import { MacOSAdapter } from './macos.js';
import { WindowsAdapter } from './windows.js';

export { ServiceAdapter, LinuxAdapter, MacOSAdapter, WindowsAdapter };

/**
 * Returns the appropriate platform service adapter for the given OS.
 *
 * @param {string} [platform]
 * @param {object} [options]
 * @returns {ServiceAdapter}
 */
export function getAdapter(platform, options = {}) {
  const targetPlatform =
    platform || process.env.UNITUP_PLATFORM || (process.env.XDG_CONFIG_HOME ? 'linux' : process.platform);

  switch (targetPlatform) {
    case 'linux':
      return new LinuxAdapter(options);
    case 'darwin':
    case 'macos':
      return new MacOSAdapter(options);
    case 'win32':
    case 'windows':
      return new WindowsAdapter(options);
    default:
      throw new UnsupportedPlatformError(targetPlatform);
  }
}

/**
 * Returns platform capabilities for the target or current OS.
 *
 * @param {string} [platform]
 * @returns {object}
 */
export function getPlatformCapabilities(platform) {
  const adapter = getAdapter(platform);
  return adapter.capabilities;
}
