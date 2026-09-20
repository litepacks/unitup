---
name: multi-runtime-management
description: >-
  Manage, extend, and test multi-runtime support in Unitup: Node.js, Python, Bun, Deno, Go, Ruby,
  PHP, Elixir, and generic executables. Use when modifying runtime detection, shebang parsing,
  argument building, environment variable normalization, or memory limits.
---

# Multi-Runtime Management in Unitup

This skill details how Unitup automatically detects, configures, and executes services across different programming runtimes without requiring external dependencies or containers.

---

## 1. Runtime Architecture

Runtime logic resides in:
```text
src/runtimes/
├── base.js         # BaseRuntime contract: detect(), getExecutable(), getArgs()
├── node.js         # NodeRuntime (.js, .mjs, .cjs)
├── python.js       # PythonRuntime (.py, python shebang, unbuffered -u flag)
├── bun.js          # BunRuntime (.js, .ts with bun)
├── deno.js         # DenoRuntime (.ts with deno, auto permission flags)
├── go.js           # GoRuntime (.go -> go run, or compiled binaries)
├── ruby.js         # RubyRuntime (.rb)
├── php.js          # PHPRuntime (.php -> built-in web server or CLI)
├── shell.js        # ShellRuntime (.sh, bash shebang)
├── elixir.js       # ElixirRuntime (.ex, .exs)
├── generic.js      # GenericExecutableRuntime (arbitrary command line)
└── index.js        # detectRuntime(), resolveRuntimeConfig(), listSupportedRuntimes()
```

---

## 2. Detection & Resolution Rules

### 1. File Extension Detection
- `.js`, `.mjs`, `.cjs` -> Node.js (or Bun/Deno if explicitly specified via `--runtime`)
- `.py` -> Python (`python3` or `python` with `-u` for unbuffered logs)
- `.rb` -> Ruby (`ruby`)
- `.php` -> PHP (`php`)
- `.sh` -> Shell (`bash` or `sh`)
- `.go` -> Go (`go run`)
- `.ex`, `.exs` -> Elixir (`elixir`)

### 2. TypeScript Ambiguity Rule
- `.ts` files **cannot** be auto-resolved to a single engine because both Bun and Deno execute TypeScript natively.
- An error is thrown requiring the user to specify `--runtime bun` or `--runtime deno`.

### 3. Shebang Header Detection
If a file has no extension or is executable:
- Reads the first 256 bytes of the file.
- Inspects `#!/usr/bin/env ...` or `#!/bin/...` to detect runtime (e.g. `python3`, `ruby`, `node`, `bash`).

### 4. Generic Command (`--command`)
- When `--command "my-binary --flag"` is provided:
  - Bypasses runtime detection.
  - Resolves executable using `resolveExecutable()`.
  - Splits and preserves argument tokens safely without shell injection vulnerabilities.

---

## 3. Normalization & App Metadata

[normalizeServiceConfig](file:///Users/ahmet/projects/unitup/src/service/normalize.js) converts raw CLI/API flags into a canonical service descriptor:

- Resolves absolute `cwd` (Working directory).
- Resolves executable path or validates binary exists in `$PATH`.
- Normalizes memory limits: parses `512M`, `1G`, `256MB` into bytes and native OS config strings.
- Reads and saves metadata in `~/.config/unitup/apps/<name>.json`.

---

## 4. Testing Multi-Runtime Capabilities

```bash
# Run multi-runtime detection and argument builder tests
node --test test/multi-runtime.test.js
```
