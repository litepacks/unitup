---
name: unitup-development-and-qa
description: >-
  Development standards, testing procedures, TypeScript type verification, Biome linting,
  and zero-external-dependency constraints for the Unitup codebase. Use when adding new features,
  running tests, updating index.d.ts, or validating pull requests.
---

# Unitup Development, QA & Quality Standards

This skill outlines the core engineering invariants, code quality checks, and testing workflows required for any contribution to Unitup.

---

## 1. Golden Constraint: Zero External Dependencies

**Unitup has strictly ZERO production external dependencies (`dependencies: {}` in package.json).**

- Only Node.js built-in standard modules are allowed (`node:fs`, `node:path`, `node:os`, `node:child_process`, `node:http`, `node:net`, `node:events`, `node:assert`, `node:test`).
- Never add npm packages to `dependencies`.
- Development dependencies (`devDependencies`) are strictly limited to developer tooling: `biome` for linting/formatting and `typescript` for `.d.ts` type-checking.

---

## 2. Testing Principles & Node.js Test Runner

Unitup uses the native Node.js test runner (`node:test` and `node:assert`). No Jest, Mocha, or Vitest.

### Test Authoring Rules:
1. **Never use hardcoded network ports**:
   - Always use `port: 0` for ephemeral port allocation or `findFreePort()`.
   - Hardcoding ports like `3000` or `8080` breaks developer machines running local web servers.
2. **Deterministic Cleanup**:
   - Every test that opens an HTTP server, router, socket, or temporary file must clean it up in an `afterEach` or `finally` block.
3. **Mock Process & System Calls**:
   - Do not call real `systemctl`, `launchctl`, or `sc.exe` in unit tests. Use `setCommandRunner()`.
   - Use simulated process managers when testing deployment state machines to keep tests blazing fast (< 100ms per suite).

### Common Test Commands:
```bash
# Run a specific test suite
node --test test/canary.test.js
node --test test/router.test.js
node --test test/deployment-manager.test.js

# Run the complete test suite across all platforms
npm test
```

---

## 3. TypeScript Type Synchronization (`index.d.ts`)

Unitup is written in standard ES Modules (`"type": "module"`), but provides high-grade TypeScript declarations in [index.d.ts](file:///Users/ahmet/projects/unitup/index.d.ts).

Whenever a public function, class, option, or result object is added or modified in `src/`:
1. Update `index.d.ts` with matching types.
2. Verify with the TypeScript compiler:
   ```bash
   npx tsc --noEmit
   ```
3. Ensure `npx tsc --noEmit` exits with **0 errors**.

---

## 4. Linting & Formatting with Biome

Unitup uses Biome for sub-second formatting and static analysis:

```bash
# Check code style, formatting, and lint rules
npx biome check src/ test/

# Automatically apply safe fixes
npx biome check --write src/ test/
```

Always ensure `npx biome check src/ test/` exits cleanly with zero errors before concluding tasks.

---

## 5. Pre-Commit / Pre-Push Checklist

Before submitting any task, run the full validation chain:

```bash
npm test && npx tsc --noEmit && npx biome check src/ test/
```
