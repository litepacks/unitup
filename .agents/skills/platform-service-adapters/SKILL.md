---
name: platform-service-adapters
description: >-
  Implement, test, and debug cross-platform OS service adapters in Unitup: systemd (Linux),
  launchd (macOS), and Windows Services (Windows). Use when working with service definition generators,
  system commands (systemctl, launchctl, sc.exe), user vs. system scopes, linger, or timer units.
---

# Cross-Platform Service Adapters in Unitup

This skill covers the implementation patterns, escaping rules, permission boundaries, and testing practices for Unitup's native OS service adapters.

---

## 1. Adapter Architecture

Unitup implements a unified interface across operating systems via [ServiceAdapter](file:///Users/ahmet/projects/unitup/src/platform/base.js):

```text
src/platform/
├── base.js           # Base ServiceAdapter abstract class with standard contract
├── linux.js          # LinuxAdapter: systemd user & system units via systemctl
├── macos.js          # MacOSAdapter: launchd launchd.plist via launchctl
├── windows.js        # WindowsAdapter: Windows Service via sc.exe
├── windows-host.js   # WindowsServiceHost child process manager for Windows
└── index.js          # getAdapter(platform), getPlatformCapabilities()
```

### Standard Adapter Methods:
Each adapter implements:
- `getCapabilities()`: `{ systemd, launchd, windowsService, userUnits, systemUnits, timers, memoryLimits }`
- `generateService(config)`: Returns formatted service definition string
- `install(config, opts)`: Writes service file and registers with OS daemon
- `uninstall(name, opts)`: Unregisters service and deletes service file
- `start(name, opts)`, `stop(name, opts)`, `restart(name, opts)`
- `status(name, opts)`: Queries native service state (running, stopped, PID, uptime)
- `enable(name, opts)`, `disable(name, opts)`

---

## 2. Platform Specifics & Service Formats

### A. Linux (systemd)
- **User scope (default)**: `~/.config/systemd/user/unitup-<name>.service`
  - Requires user lingering for persistence across logout: `loginctl enable-linger <user>` (verified via `checkUserLinger()`).
  - Controlled with `systemctl --user`.
- **System scope**: `/etc/systemd/system/unitup-<name>.service`
  - Requires root privileges; throws `PermissionRequiredError` if unprivileged.
- **Unit Content Structure**:
  ```ini
  [Unit]
  Description=Unitup Service - <name>
  After=network.target

  [Service]
  Type=simple
  WorkingDirectory=/path/to/app
  ExecStart=/path/to/executable ...
  Restart=always
  RestartSec=3
  MemoryMax=512M

  [Install]
  WantedBy=default.target
  ```
- **Escaping**: Always use `formatSystemdEnv()` and `escapeExecArg()` from [src/utils.js](file:///Users/ahmet/projects/unitup/src/utils.js).

### B. macOS (launchd)
- **User scope (default)**: `~/Library/LaunchAgents/com.unitup.<name>.plist`
  - Domain target: `gui/<uid>` (for logged-in user) or `user/<uid>`.
  - Bootstrapping: `launchctl bootstrap gui/<uid> <plistPath>`
  - Kickstarting: `launchctl kickstart -k gui/<uid>/com.unitup.<name>`
- **System scope**: `/Library/LaunchDaemons/com.unitup.<name>.plist`
  - Domain target: `system` (requires root).
- **XML Plist Generation**: Generated cleanly with standard XML elements (`ProgramArguments`, `WorkingDirectory`, `KeepAlive`, `EnvironmentVariables`, `StandardOutPath`, `StandardErrorPath`).

### C. Windows (Windows Services)
- **Tooling**: Uses `sc.exe create <name> binPath= ... start= auto`.
- **WindowsServiceHost**: Because standard node scripts cannot run directly as Windows Services without a service wrapper, Unitup uses [WindowsServiceHost](file:///Users/ahmet/projects/unitup/src/platform/windows-host.js) to bridge process signals, log redirection, and Windows shutdown events.

---

## 3. Testing Platform Adapters Safely

Native system commands (`systemctl`, `launchctl`, `sc.exe`) cannot and should not be executed directly in unit tests.

Unitup provides runner injection via [src/utils.js](file:///Users/ahmet/projects/unitup/src/utils.js):

```javascript
import { setCommandRunner, resetCommandRunner } from '../src/utils.js';

// Mock commands in tests:
setCommandRunner(async (cmd, args) => {
  if (cmd === 'systemctl' && args.includes('is-active')) {
    return { stdout: 'active\n', stderr: '', code: 0 };
  }
  return { stdout: '', stderr: '', code: 0 };
});

// Always reset runner in afterEach / finally:
resetCommandRunner();
```

### Verification Commands:
```bash
# Test all platform adapters
node --test test/platform.test.js test/macos.test.js test/windows.test.js test/unit.test.js
```
