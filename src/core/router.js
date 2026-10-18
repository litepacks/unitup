import http from 'node:http';
import net from 'node:net';

/**
 * Router owns stable public ports and reverse-proxies HTTP & WebSocket traffic
 * to whichever internal generation is marked active.
 *
 * Supports multi-port listening with STRICT port-level isolation:
 * - A request arriving on port A can ONLY EVER route to backends registered for port A.
 * - Under NO circumstances will requests cross port boundaries.
 * - Opening port B will NEVER close or disrupt port A.
 *
 * It contains NO deployment sequencing decisions.
 */
export class Router {
  constructor(options = {}) {
    this.activeBackends = new Map(); // serviceName -> generation { id, internalPort }
    this.canaryBackends = new Map(); // serviceName -> { generation, weight }
    this.inFlightRequests = new Map(); // generationId -> number
    this.servers = new Map(); // port -> { server, port, host }
    this.portServices = new Map(); // port -> Set<serviceName>
    this.servicePorts = new Map(); // serviceName -> port
    this.server = null; // backward compatibility: primary/latest server
    this.listeningPort = null; // backward compatibility
    this.listeningHost = null; // backward compatibility
    this.closing = false;
  }

  /**
   * Associates a service name with a public port.
   *
   * @param {string} serviceName
   * @param {number|string} port
   */
  registerServicePort(serviceName, port) {
    if (!serviceName || !port) return;
    const numPort = Number(port);
    this.servicePorts.set(serviceName, numPort);
    if (!this.portServices.has(numPort)) {
      this.portServices.set(numPort, new Set());
    }
    this.portServices.get(numPort).add(serviceName);
  }

  /**
   * Sets a canary backend with a specific traffic weight (0 to 1, or 1 to 100).
   *
   * @param {string} serviceName
   * @param {object} generation
   * @param {number} [weight=0.1] - Probability (0 to 1) or percentage (1 to 100)
   * @param {number} [publicPort]
   */
  setCanary(serviceName, generation, weight = 0.1, publicPort = null) {
    const parsed =
      typeof weight === 'string' ? Number.parseFloat(weight.replace('%', '')) : Number(weight);
    const num = Number.isNaN(parsed) ? 0.1 : parsed;
    const normalizedWeight = num > 1 ? num / 100 : num;
    this.canaryBackends.set(serviceName, {
      generation,
      weight: Math.max(0, Math.min(1, normalizedWeight)),
    });

    const targetPort =
      publicPort ||
      generation?.publicPort ||
      (this.servers.size === 1 ? this.servers.keys().next().value : null);
    if (targetPort) {
      this.registerServicePort(serviceName, targetPort);
    }
  }

  /**
   * Clears the canary backend for a service.
   *
   * @param {string} serviceName
   */
  clearCanary(serviceName) {
    this.canaryBackends.delete(serviceName);
  }

  /**
   * Promotes the canary generation to the active primary generation,
   * clearing the canary state.
   *
   * @param {string} serviceName
   * @returns {object|null} The promoted generation
   */
  promoteCanary(serviceName) {
    const canary = this.canaryBackends.get(serviceName);
    if (!canary || !canary.generation) return null;
    const port = this.servicePorts.get(serviceName);
    this.switchBackend(serviceName, canary.generation, port);
    this.canaryBackends.delete(serviceName);
    return canary.generation;
  }

  /**
   * Gets the canary config for a service.
   *
   * @param {string} serviceName
   * @returns {{ generation: object, weight: number }|null}
   */
  getCanary(serviceName) {
    return this.canaryBackends.get(serviceName) || null;
  }

  /**
   * Resolves the target backend generation for an incoming request.
   *
   * @param {string} serviceName
   * @param {import('node:http').IncomingMessage} [req]
   * @returns {object|null}
   */
  resolveBackend(serviceName, req = null) {
    const primary = this.activeBackends.get(serviceName);
    const canary = this.canaryBackends.get(serviceName);

    if (!canary || !canary.generation) {
      return primary || null;
    }

    if (!primary) {
      return canary.generation;
    }

    // Optional header-based override (e.g. x-canary: true or x-canary: always)
    if (req?.headers) {
      const canaryHeader = req.headers['x-canary'];
      if (canaryHeader === 'true' || canaryHeader === 'always' || canaryHeader === '1') {
        return canary.generation;
      }
      if (canaryHeader === 'false' || canaryHeader === 'never' || canaryHeader === '0') {
        return primary;
      }
    }

    // Probabilistic routing based on weight
    if (canary.weight > 0 && Math.random() < canary.weight) {
      return canary.generation;
    }

    return primary;
  }

  /**
   * Helper to find the service name matching the request.
   * STRICT: Scoped to the listening port. Never returns an unrelated service!
   *
   * @param {import('node:http').IncomingMessage} [req]
   * @param {number} [listeningPort]
   * @returns {string|null}
   */
  _resolveServiceName(req, listeningPort = null) {
    const numPort = listeningPort ? Number(listeningPort) : null;
    let candidateNames = null;

    if (numPort && this.portServices.has(numPort)) {
      candidateNames = Array.from(this.portServices.get(numPort));
    } else if (this.activeBackends.size > 0 || this.canaryBackends.size > 0) {
      candidateNames = Array.from(
        new Set([...this.activeBackends.keys(), ...this.canaryBackends.keys()]),
      );
    }

    if (!candidateNames || candidateNames.length === 0) {
      return null;
    }

    // Single service registered on this port: unconditionally routes to it
    if (candidateNames.length === 1) {
      return candidateNames[0];
    }

    // Multiple services registered on this port: match by Host header
    if (req?.headers?.host) {
      const hostRaw = req.headers.host.split(':')[0].toLowerCase();
      const hostNormalized = hostRaw.replace(/[^a-z0-9]/g, '');

      // 1. Exact match
      for (const srv of candidateNames) {
        if (hostRaw === srv.toLowerCase()) {
          return srv;
        }
      }

      // 2. Normalized match (e.g. "supanote.app" matches service "supanoteapp")
      for (const srv of candidateNames) {
        const srvNorm = srv.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (
          hostNormalized === srvNorm ||
          hostNormalized.includes(srvNorm) ||
          srvNorm.includes(hostNormalized)
        ) {
          return srv;
        }
      }
    }

    // STRICT: Return null if host does not match any service on this port.
    // NEVER fall back to another random service.
    return null;
  }

  /**
   * Increments in-flight request counter for a generation.
   * @param {number|string} generationId
   */
  _incrementInFlight(generationId) {
    const id = String(generationId);
    const count = this.inFlightRequests.get(id) || 0;
    this.inFlightRequests.set(id, count + 1);
  }

  /**
   * Decrements in-flight request counter for a generation.
   * @param {number|string} generationId
   */
  _decrementInFlight(generationId) {
    const id = String(generationId);
    const count = this.inFlightRequests.get(id) || 0;
    if (count <= 1) {
      this.inFlightRequests.delete(id);
    } else {
      this.inFlightRequests.set(id, count - 1);
    }
  }

  /**
   * Gets the current number of in-flight requests for a generation.
   *
   * @param {number|string} generationId
   * @returns {number}
   */
  getInFlightCount(generationId) {
    return this.inFlightRequests.get(String(generationId)) || 0;
  }

  /**
   * Switches the active backend generation for a service.
   * Switching is atomic and lock-free for incoming requests.
   *
   * @param {string} serviceName
   * @param {object} generation - { id, internalPort, service }
   * @param {number} [publicPort]
   */
  switchBackend(serviceName, generation, publicPort = null) {
    this.activeBackends.set(serviceName, generation);
    const targetPort =
      publicPort ||
      generation?.publicPort ||
      (this.servers.size === 1 ? this.servers.keys().next().value : null);
    if (targetPort) {
      this.registerServicePort(serviceName, targetPort);
    }
  }

  /**
   * Gets the active backend generation for a service.
   *
   * @param {string} serviceName
   * @returns {object|null}
   */
  getActiveBackend(serviceName) {
    return this.activeBackends.get(serviceName) || null;
  }

  /**
   * Starts listening on the public port.
   * Supports multiple distinct ports concurrently without closing existing ones.
   *
   * @param {number} publicPort
   * @param {string} [host='0.0.0.0']
   * @param {string} [serviceName=null]
   * @returns {Promise<{ port: number, host: string }>}
   */
  async listen(publicPort, host = '0.0.0.0', serviceName = null) {
    const portNum = Number(publicPort);
    if (serviceName) {
      this.registerServicePort(serviceName, portNum);
    }

    const existing = this.servers.get(portNum);
    if (existing && existing.server) {
      this.listeningPort = portNum;
      this.listeningHost = existing.host;
      this.server = existing.server;
      return { port: portNum, host: existing.host };
    }

    this.closing = false;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res, portNum);
      });

      server.on('upgrade', (req, clientSocket, head) => {
        this._handleWebSocketUpgrade(req, clientSocket, head, portNum);
      });

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Public port ${portNum} is already occupied by another process.`));
        } else {
          reject(err);
        }
      });

      server.listen(portNum, host, () => {
        this.servers.set(portNum, { server, port: portNum, host });
        const actualPort = server.address() ? server.address().port : portNum;
        this.listeningPort = actualPort;
        this.listeningHost = host;
        this.server = server;
        resolve({ port: actualPort, host });
      });
    });
  }

  /**
   * Dispatches and proxies an HTTP request to the active backend.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {number} [listeningPort]
   */
  _handleHttpRequest(req, res, listeningPort = null) {
    const effectivePort = listeningPort || this.listeningPort;
    const serviceName = this._resolveServiceName(req, effectivePort);
    const backend = serviceName ? this.resolveBackend(serviceName, req) : null;

    if (!serviceName) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '1',
      });
      res.end(
        `503 Service Unavailable: No service matching host "${req?.headers?.host || 'unknown'}" on port ${effectivePort}.`,
      );
      return;
    }

    if (!backend || !backend.internalPort) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '1',
      });
      res.end(
        `503 Service Unavailable: No active generation backend available for service "${serviceName}".`,
      );
      return;
    }

    const genId = backend.id;
    this._incrementInFlight(genId);

    let decremented = false;
    const cleanupInFlight = () => {
      if (!decremented) {
        decremented = true;
        this._decrementInFlight(genId);
      }
    };

    res.once('finish', cleanupInFlight);
    res.once('close', cleanupInFlight);

    // Forward headers
    const forwardedHeaders = { ...req.headers };
    const clientIp = req.socket?.remoteAddress || '127.0.0.1';
    forwardedHeaders['x-forwarded-for'] = forwardedHeaders['x-forwarded-for']
      ? `${forwardedHeaders['x-forwarded-for']}, ${clientIp}`
      : clientIp;
    forwardedHeaders['x-forwarded-proto'] = forwardedHeaders['x-forwarded-proto'] || 'http';
    forwardedHeaders['x-forwarded-host'] = req.headers.host || `localhost:${effectivePort}`;
    forwardedHeaders['x-forwarded-port'] = String(effectivePort);

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: backend.internalPort,
        path: req.url,
        method: req.method,
        headers: forwardedHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    req.on('error', () => {
      cleanupInFlight();
      proxyReq.destroy();
    });

    proxyReq.on('error', (err) => {
      cleanupInFlight();
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`502 Bad Gateway: Error communicating with generation #${genId} (${err.message}).`);
      } else {
        res.destroy();
      }
    });

    req.pipe(proxyReq);
  }

  /**
   * Dispatches and proxies WebSocket / Upgrade connections to the active backend.
   */
  _handleWebSocketUpgrade(req, clientSocket, head, listeningPort = null) {
    const effectivePort = listeningPort || this.listeningPort;
    const serviceName = this._resolveServiceName(req, effectivePort);
    const backend = serviceName ? this.resolveBackend(serviceName, req) : null;
    if (!serviceName || !backend || !backend.internalPort) {
      clientSocket.destroy();
      return;
    }

    const genId = backend.id;
    this._incrementInFlight(genId);

    let decremented = false;
    const cleanupInFlight = () => {
      if (!decremented) {
        decremented = true;
        this._decrementInFlight(genId);
      }
    };

    let backendSocket = null;

    const onClientEnded = () => {
      cleanupInFlight();
      if (backendSocket && !backendSocket.destroyed) {
        backendSocket.destroy();
      }
    };

    clientSocket.once('close', onClientEnded);
    clientSocket.once('end', onClientEnded);
    clientSocket.once('error', onClientEnded);

    backendSocket = net.connect(backend.internalPort, '127.0.0.1', () => {
      backendSocket.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join('') +
          '\r\n',
      );
      if (head && head.length > 0) {
        backendSocket.write(head);
      }
      backendSocket.pipe(clientSocket);
      clientSocket.pipe(backendSocket);
    });

    const onBackendEnded = () => {
      cleanupInFlight();
      if (!clientSocket.destroyed) {
        clientSocket.destroy();
      }
    };

    backendSocket.once('close', onBackendEnded);
    backendSocket.once('end', onBackendEnded);
    backendSocket.on('error', onBackendEnded);
  }

  /**
   * Closes the public router HTTP listener(s).
   *
   * @param {number} [port=null] - Specific port to close, or null to close all.
   * @returns {Promise<void>}
   */
  async close(port = null) {
    if (port !== null) {
      const portNum = Number(port);
      const entry = this.servers.get(portNum);
      if (!entry || !entry.server) return;
      return new Promise((resolve) => {
        if (typeof entry.server.closeAllConnections === 'function')
          entry.server.closeAllConnections();
        entry.server.close(() => {
          this.servers.delete(portNum);
          this.portServices.delete(portNum);
          if (this.listeningPort === portNum) {
            const nextEntry = this.servers.values().next().value;
            this.server = nextEntry ? nextEntry.server : null;
            this.listeningPort = nextEntry ? nextEntry.port : null;
            this.listeningHost = nextEntry ? nextEntry.host : null;
          }
          resolve();
        });
      });
    }

    this.closing = true;
    const closePromises = [];
    for (const [, entry] of this.servers.entries()) {
      if (entry.server) {
        closePromises.push(
          new Promise((resolve) => {
            if (typeof entry.server.closeAllConnections === 'function')
              entry.server.closeAllConnections();
            entry.server.close(() => resolve());
          }),
        );
      }
    }
    await Promise.all(closePromises);
    this.servers.clear();
    this.portServices.clear();
    this.servicePorts.clear();
    this.server = null;
    this.listeningPort = null;
    this.listeningHost = null;
  }
}
