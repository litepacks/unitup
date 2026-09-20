---
name: zero-downtime-deployment
description: >-
  Develop, test, and debug zero-downtime deployments, canary releases, rollback sequencing,
  generation management, router reverse proxying, connection draining, and readiness probes in Unitup.
  Use when modifying core routing, process lifecycle, readiness checks, drain manager, or deploy orchestration.
---

# Zero-Downtime Deployment & Traffic Routing in Unitup

This skill provides architectural guidelines, lifecycle specifications, and testing procedures for Unitup's zero-downtime deployment subsystem.

---

## 1. Architectural Invariant: Core vs. Deploy Separation

Unitup strictly decouples low-level process and routing primitives from deployment sequencing:

```text
unitup
├── core/                         # Zero-downtime runtime primitives (No deployment sequencing)
│   ├── process-manager.js        # Child process lifecycle (start, stop, isAlive, signal, waitForExit)
│   ├── generation-manager.js     # Generation records, ephemeral internal ports, disk persistence
│   ├── router.js                 # HTTP & WebSocket reverse proxy on stable public port, atomic switch, canary weights
│   ├── readiness.js              # TCP connect & HTTP 2xx health probes, fast startup failure detection
│   ├── drain-manager.js          # In-flight connection tracking, graceful drain, process retirement
│   ├── lock.js                   # Cross-process deployment concurrency lock
│   ├── supervisor.js             # Daemon supervisor (unitupd) managing generations and IPC
│   └── ipc.js                    # Domain socket / Named Pipe IPC server and client
│
└── deploy/                       # Orchestration layer (Composes core primitives)
    ├── deployment-manager.js     # State machine for full deployments and canary rollouts
    └── rollback-manager.js       # Rollback sequencing and canary abortion
```

### Golden Rules:
1. **Never put deployment sequencing into `core/`**: Router, ProcessManager, GenerationManager, and DrainManager must have no knowledge of "steps" or deployment decisions.
2. **Never put networking or OS primitives into `deploy/`**: DeploymentManager and RollbackManager must only compose core primitives.
3. **Never build zero-downtime inside CLI commands**: `src/cli.js` must remain a thin adapter that calls `deploy`, `promote`, or `rollback`.
4. **Never create per-generation OS service units**: Only one supervisor service unit exists per application.

---

## 2. Deployment State Machine

DeploymentManager executes a strict, observable state machine:

```text
IDLE
  └── ACQUIRING_LOCK
        └── CREATING_GENERATION
              └── STARTING
                    └── WAITING_READY
                          ├── (If canary): SETTING_CANARY -> COMPLETE
                          └── (If full deploy):
                                SWITCHING
                                  └── STABILIZING
                                        └── DRAINING
                                              └── STOPPING_PREVIOUS
                                                    └── COMPLETE
```

### Critical Safety Invariants:
- **Previous Generation Safety**: The previous generation is NEVER stopped or drained until the new generation has passed readiness and traffic has switched.
- **Readiness Failure Preservation**: If the new generation fails readiness or crashes on startup, it is immediately stopped and removed. The router remains pointed at the previous generation, and the deployment fails cleanly.
- **Stabilization Window**: During `stabilizationWindowMs` (default 500ms), if the new generation crashes, traffic is automatically reverted to the previous generation before an error is thrown.
- **Port Mismatch & EADDRINUSE Diagnosis**: If user code hardcodes its listening port instead of reading `process.env.PORT`, `ReadinessChecker` diagnoses this immediately (raising `PortMismatchError` or diagnosing `EADDRINUSE` from captured process stderr) rather than hanging for 15 seconds.

---

## 3. Canary & Weighted Routing Mechanics

### Router Primitives (`src/core/router.js`):
- `setCanary(serviceName, generation, weight)`: Accepts decimal (`0.15`) or percentage (`"15%"` or `15`), normalized to `[0.0, 1.0]`.
- `resolveBackend(serviceName, req)`:
  1. **Header Override**:
     - `x-canary: true`, `1`, `always` -> Routes to canary generation deterministically.
     - `x-canary: false`, `0`, `never` -> Routes to primary active generation deterministically.
  2. **Probabilistic Splitting**: If `Math.random() < canary.weight`, routes to canary.
  3. **Fallback**: Routes to primary active generation.
- `promoteCanary(serviceName)`: Atomically shifts primary backend to canary, clears canary map, returns promoted generation.
- `clearCanary(serviceName)`: Removes canary backend without touching primary active generation.

### Canary Deployment Flow:
```bash
# 1. Deploy canary with 10% traffic (keeps existing active generation intact)
unitup deploy <app> --canary --weight 10%

# 2. Inspect status (shows both active and canary generations with port & weight)
unitup status <app>

# 3A. Promote canary to 100% active (drains and stops old active generation)
unitup promote <app>

# 3B. OR abort canary (stops and drains canary, keeps old active generation intact)
unitup rollback <app>
```

---

## 4. Connection Draining & Streaming Protocols

[DrainManager](file:///Users/ahmet/projects/unitup/src/core/drain-manager.js) ensures graceful retirement:
1. `inFlightRequests` map tracks active HTTP requests and WebSocket connections per generation ID.
2. In `_handleHttpRequest`: increments in-flight counter, decrements on response `'finish'` or `'close'`.
3. In `_handleWebSocketUpgrade`: increments in-flight counter, decrements on socket `'close'`, `'end'`, or `'error'`.
4. `DrainManager.drain(generation, { timeout, pollInterval, stopProcess })`:
   - Polls `router.getInFlightCount(generation.id)`.
   - Waits for active in-flight requests, long-lived WebSockets, Server-Sent Events (SSE), and chunked uploads to complete up to `timeout`.
   - Stops the process gracefully (`SIGTERM` -> timeout -> `SIGKILL`).

---

## 5. Testing & Verification Runbook

When modifying zero-downtime or routing code, run:

```bash
# 1. Core routing and architectural boundary tests
node --test test/router.test.js test/deployment-manager.test.js test/rollback-manager.test.js test/canary.test.js

# 2. Connection draining & streaming protocols test
node --test test/live-connections.test.js test/drain-manager.test.js

# 3. Continuous zero-downtime traffic integration test (v1 -> v2 -> v1 -> v2 under load)
node --test test/zero-downtime-integration.test.js

# 4. Full test suite and type check
npm test
npx tsc --noEmit
```

### Test Construction Rules:
- **Never bind hardcoded ports** like `3000` or `8080`. Always use `port: 0` (ephemeral port allocation) or `findFreePort()` to avoid collisions with running user services.
- **Always clean up servers and sockets** in `afterEach` or `finally` blocks.
