# Changelog

All notable changes to the `unitup` project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
