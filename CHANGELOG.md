# Changelog

All notable changes to the `unitup` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.2] - 2026-11-23

### Fixed
- **Orphan Process Elimination on Reinstall / Stop / Uninstall (macOS, Linux, Windows)**: `stop()`, `uninstall()`, and `install({ force: true })` now capture the active service PID before stopping, wait for graceful termination within `shutdownTimeout` (default `5000ms`), and escalate to `SIGKILL` (plus `taskkill /T /F` on Windows) if the process lingers.
- **macOS `launchd` `KeepAlive` Respawn Loop on `stop()`**: `MacOSAdapter.stop()` now uses `launchctl bootout` first so `KeepAlive` cannot immediately respawn a stopped service, and `start()` cleanly re-bootstraps booted-out services.
- **macOS `RunAtLoad: true` Double-Start Race**: `MacOSAdapter.install({ force: true, start: true })` guarantees the previous process has completely exited before bootstrapping the new plist and skips redundant `launchctl kickstart -k` calls when `RunAtLoad` has already started the service.
- **Idempotent `--force` Uninstall & Orphan Cleanup**: `uninstall(name, { force: true })` and `removeService(name, { force: true })` now attempt service unload, orphan PID termination, and metadata cleanup even if the plist/unit file was already removed from disk.
- **App Metadata Persistence**: `saveAppMetadata()` now preserves lifecycle and platform fields (`pid`, `shutdownTimeout`, `plistPath`, `label`, `system`, `logs`, `started`, `restarts`) and clears stale `pid` values on `stop()`.

### Added
- **Cross-Platform PID Reuse Guard**: Added `verifyPidCommand()` in `ensureProcessStopped()` (using `ps` on POSIX and `tasklist` on Windows) to prevent terminating an unrelated process if a persisted metadata PID was recycled by the OS.
- **OS-Aligned Shutdown Timeouts & Process Group Cleanup**: Synced `shutdownTimeout` to `ExitTimeOut` in generated macOS `.plist` files and `TimeoutStopSec` + `KillMode=control-group` in generated Linux systemd unit files.
- **Orphaned macOS Job Visibility**: `MacOSAdapter.status()` now queries `launchd` even when the plist file is absent on disk, reporting `installed: false, orphaned: true, state: 'running'`.
- **Linux `--system` Service Support**: Added `/etc/systemd/system` unit path resolution (`getUnitDir(true)`), `WantedBy=multi-user.target`, system-scope `systemctl` commands, and root privilege verification (`PermissionRequiredError`).
- **CLI & Diagnostics Enhancements**: Added `--shutdown-timeout <ms>`, `stop --force`, `logs --truncate` (`truncateServiceLogs()`), and macOS `unitup doctor` checks for `~/Library/LaunchAgents` writability, `gui/<uid>` domain access, and orphaned `dev.unitup.*` jobs.

## [0.4.1] - 2026-10-18

### Added
- **Supervisor Active Generation TCP Health Verification & Self-Healing**: Supervisor now validates TCP connectivity on the internal port (`active.internalPort`) of persisted active generations at startup. If the target generation is dead or refusing connections, supervisor cleans up stale state and automatically triggers a fresh deployment, eliminating stale `502 Bad Gateway (ECONNREFUSED)` loops.
- **Systemd Crash Loop Circuit Breaker (`RestartPreventExitStatus=78`)**: Added `RestartPreventExitStatus=78` (POSIX `EX_CONFIG`) to generated systemd unit files, paired with `StartLimitIntervalSec=30s` and `StartLimitBurst=5`. When supervisor encounters unrecoverable configuration errors (such as public port collision / `EADDRINUSE`), it exits with code 78, preventing systemd from endlessly restarting and spamming journald logs.
- **Enhanced Connection Diagnostics in Router**: Detailed internal port and error context (`connect ECONNREFUSED 127.0.0.1:<port>`) reported on proxy failures to clarify application startup crashes.
- **Exported `IPCClient` Type Definitions**: Exported `IPCClient` class and interface in `index.d.ts` for clean downstream programmatic integration by orchestrators.

### Fixed
- **Systemd Unit Parser & Directives**: Added extraction and preservation of `RestartPreventExitStatus` in `parseUnitContent` to maintain parity across read/write cycles.
- **Router In-Flight Request Timing**: Resolved timing race condition in `test/router.test.js` in-flight request tracking test.

## [0.4.0] - 2026-10-18

### Added
- **Multi-Port Concurrent Routing**: Enhanced `Router` to listen on multiple distinct ports concurrently using an internal server map (`servers: Map<port, { server, port, host }>`), enabling multiple zero-downtime services to operate simultaneously without port collisions or premature listener termination.
- **Port-Scoped Traffic Isolation**: Added strict port-to-service mapping (`portServices: Map<port, Set<serviceName>>`) ensuring requests on port `A` are strictly isolated from services listening on port `B`.
- **Domain Normalization in Router**: Added hostname normalization (`hostNormalized`) to resolve incoming Host headers seamlessly against registered service names (e.g., `supanote.app` accurately resolves to service `supanoteapp`).
- **Automated GitHub Actions Release Pipeline**: Added `.github/workflows/release.yml` using Litepacks reusable release workflow with OIDC Trusted Publishing and provenance.
- **TypeScript Typecheck Script**: Added `npm run typecheck` (`tsc --noEmit`) to scripts for automated type validation in CI.
- **Package Distribution Optimization**: Configured `"files"` in `package.json` to publish only essential production files, reducing package size from 2.4 MB to 85 KB.

### Changed
- **Eliminated Blind Cross-Service Fallback**: Removed indiscriminate fallback to other active backends when a Host header does not match; the router now safely returns `503 Service Unavailable` instead of cross-routing traffic to an unrelated backend.
- **Service Metadata Persistence**: `writeUnitFile` now explicitly preserves `port` and `deploy` configurations in `saveAppMetadata`, allowing systemd supervisors to retain their target public ports across daemon restarts.
- **Supervisor Public Port Resolution**: Updated `Supervisor` to reliably resolve public ports across `options.publicPort`, `config.port`, and `config.deploy?.port`.
- **Connection Draining on Shutdown**: Enhanced `Router.close()` to invoke `server.closeAllConnections()` for immediate and clean termination of idle keep-alive sockets.


## [0.1.5] - 2026-07-31

### Fixed
- Fixed script argument resolution in all runtime adapters (`node`, `python`, `ruby`, `php`, `bun`, `deno`, `shell`, `go`, `elixir`, `native`) to resolve relative script paths against `opts.cwd` instead of `process.cwd()`.

## [0.1.4] - 2026-07-31

### Added
- Local project configuration file support (`unitup.config.json` and `.unitup.json`).
- `unitup init` CLI command to create and initialize `unitup.config.json` in any directory with custom script, runtime, name, env, group, memory limits, and runtime arguments.
- `--config <path>` flag for specifying custom configuration files in `unitup add` and `unitup init`.
- Biome (`@biomejs/biome`) developer tool integration for code linting and formatting (`npm run check`, `npm run format`, `npm run lint`).
- `CHANGELOG.md` tracking project release history and changes.

## [0.1.3] - 2026-07-31

### Added
- Native systemd timer-based task scheduler (`unitup schedule`).
- Systemd-native memory limits per service (`--memory-high`, `--memory-max`, `--memory-swap-max`, `--default-memory`).
- System memory overview command (`unitup memory` / `unitup top`).
- Extended multi-runtime support for Node.js, Python, Ruby, PHP, Bun, Deno, Go, Elixir, Shell scripts, and compiled native executables.
- Advanced `journald` log streaming filters and maintenance commands (`disk-usage`, `rotate`, `vacuum`).
- Readiness diagnostics CLI tool (`unitup doctor`).
- Service grouping support (`@group`).

## [0.1.0] - 2026-07-01

### Added
- Initial release of `unitup` — minimal, zero-dependency systemd user service wrapper.
- Basic CLI commands: `add`, `start`, `stop`, `restart`, `status`, `logs`, `remove`, `list`.
