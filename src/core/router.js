import http from 'node:http';
import net from 'node:net';

/**
 * Router owns a stable public port and reverse-proxies HTTP & WebSocket traffic
 * to whichever internal generation is marked active.
 *
 * It contains NO deployment sequencing decisions.
 */
export class Router {
  constructor(options = {}) {
    this.activeBackends = new Map(); // serviceName -> generation { id, internalPort }
    this.canaryBackends = new Map(); // serviceName -> { generation, weight }
    this.inFlightRequests = new Map(); // generationId -> number
    this.server = null;
    this.listeningPort = null;
    this.listeningHost = null;
    this.closing = false;
  }

  /**
   * Sets a canary backend with a specific traffic weight (0 to 1, or 1 to 100).
   *
   * @param {string} serviceName
   * @param {object} generation
   * @param {number} [weight=0.1] - Probability (0 to 1) or percentage (1 to 100)
   */
  setCanary(serviceName, generation, weight = 0.1) {
    const parsed = typeof weight === 'string' ? Number.parseFloat(weight.replace('%', '')) : Number(weight);
    const num = Number.isNaN(parsed) ? 0.1 : parsed;
    const normalizedWeight = num > 1 ? num / 100 : num;
    this.canaryBackends.set(serviceName, {
      generation,
      weight: Math.max(0, Math.min(1, normalizedWeight))
    });
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
    this.switchBackend(serviceName, canary.generation);
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
   * @param {import('node:http').IncomingMessage} [req]
   * @returns {string|null}
   */
  _resolveServiceName(req) {
    if (this.activeBackends.size === 1) {
      return this.activeBackends.keys().next().value;
    }
    if (this.activeBackends.size > 1 && req?.headers?.host) {
      for (const srv of this.activeBackends.keys()) {
        if (req.headers.host.includes(srv)) {
          return srv;
        }
      }
    }
    if (this.activeBackends.size > 0) {
      return this.activeBackends.keys().next().value;
    }
    if (this.canaryBackends.size > 0) {
      return this.canaryBackends.keys().next().value;
    }
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
   */
  switchBackend(serviceName, generation) {
    this.activeBackends.set(serviceName, generation);
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
   *
   * @param {number} publicPort
   * @param {string} [host='0.0.0.0']
   * @returns {Promise<{ port: number, host: string }>}
   */
  async listen(publicPort, host = '0.0.0.0') {
    if (this.server && this.listeningPort === publicPort) {
      return { port: this.listeningPort, host: this.listeningHost };
    }

    if (this.server) {
      await this.close();
    }

    this.closing = false;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this._handleHttpRequest(req, res);
      });

      server.on('upgrade', (req, clientSocket, head) => {
        this._handleWebSocketUpgrade(req, clientSocket, head);
      });

      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Public port ${publicPort} is already occupied by another process.`));
        } else {
          reject(err);
        }
      });

      server.listen(publicPort, host, () => {
        this.server = server;
        const actualPort = server.address() ? server.address().port : publicPort;
        this.listeningPort = actualPort;
        this.listeningHost = host;
        resolve({ port: actualPort, host });
      });
    });
  }

  /**
   * Dispatches and proxies an HTTP request to the active backend.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  _handleHttpRequest(req, res) {
    const serviceName = this._resolveServiceName(req);
    const backend = serviceName ? this.resolveBackend(serviceName, req) : null;

    if (!backend || !backend.internalPort) {
      res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Retry-After': '1'
      });
      res.end('503 Service Unavailable: No active generation backend available.');
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
    forwardedHeaders['x-forwarded-host'] = req.headers.host || `localhost:${this.listeningPort}`;
    forwardedHeaders['x-forwarded-port'] = String(this.listeningPort);

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port: backend.internalPort,
        path: req.url,
        method: req.method,
        headers: forwardedHeaders
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
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
  _handleWebSocketUpgrade(req, clientSocket, head) {
    const serviceName = this._resolveServiceName(req);
    const backend = serviceName ? this.resolveBackend(serviceName, req) : null;
    if (!backend || !backend.internalPort) {
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
          '\r\n'
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
   * Closes the public router HTTP listener.
   *
   * @returns {Promise<void>}
   */
  async close() {
    this.closing = true;
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server.close(() => {
        this.server = null;
        this.listeningPort = null;
        this.listeningHost = null;
        resolve();
      });
    });
  }
}
