# Unitup Workspace Guidelines for AI Agents

Welcome to **Unitup** — a lightweight, zero-dependency, cross-platform process manager and zero-downtime deployment orchestration engine.

---

## Core Invariants

1. **Zero External Dependencies**:
   - Production code in `src/` must NEVER import anything outside Node.js built-ins (`node:*`).
   - `package.json` must keep `"dependencies": {}`.
2. **Zero-Downtime Architectural Boundary**:
   - Zero-downtime runtime primitives belong to `src/core/` (ProcessManager, Router, GenerationManager, ReadinessChecker, DrainManager, Supervisor, IPC).
   - Deployment sequencing belongs to `src/deploy/` (DeploymentManager, RollbackManager).
   - CLI (`src/cli.js`) is only a thin translation layer.
3. **Multi-OS Native Daemon Support**:
   - Linux: systemd user/system services & timers.
   - macOS: launchd LaunchAgents / LaunchDaemons `.plist`.
   - Windows: Windows Services via `sc.exe` and `WindowsServiceHost`.
4. **Validation Triad**:
   - Every code modification must pass:
     ```bash
     npm test && npx tsc --noEmit && npx biome check src/ test/
     ```

---

## Workspace Skills Available

For deep-dive runbooks and procedures, activate the specialized skills in `.agents/skills/`:

- **[zero-downtime-deployment](file:///Users/ahmet/projects/unitup/.agents/skills/zero-downtime-deployment/SKILL.md)**: State machine, canary weighted routing, rollback, connection draining, and streaming protocol handling.
- **[platform-service-adapters](file:///Users/ahmet/projects/unitup/.agents/skills/platform-service-adapters/SKILL.md)**: Systemd, launchd, and Windows service integration, escaping, user lingering, and command runner mocking.
- **[multi-runtime-management](file:///Users/ahmet/projects/unitup/.agents/skills/multi-runtime-management/SKILL.md)**: Auto-detection and arguments for Node, Python, Bun, Deno, Go, Ruby, PHP, and generic binaries.
- **[unitup-development-and-qa](file:///Users/ahmet/projects/unitup/.agents/skills/unitup-development-and-qa/SKILL.md)**: Testing standards with `node:test`, TypeScript declaration sync, and Biome linting.
