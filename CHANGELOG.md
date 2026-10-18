# Changelog

All notable changes to the `unitup` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
