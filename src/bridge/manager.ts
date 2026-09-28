import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { type EnvConfig } from '../config/env.js';
import { getLogger } from '../utils/logger.js';
import {
  type BridgeHello,
  type BridgeResponse,
  BRIDGE_CONTRACT_VERSION,
  BridgeHandshakeSchema,
  BridgePairingResponseSchema,
  BridgeRequestSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from './protocol.js';
import { EasyedaApiMethodSchema } from './types.js';
import { SERVER_VERSION } from '../config/version.js';
import { getGlobalMetricsCollector } from '../observability/index.js';
import {
  BridgeListenerOwnership,
  BridgeOwnershipConflictError,
  type BridgeOwnershipConflict,
} from './listener-ownership.js';

const PAIRING_TIMEOUT_MS = 10_000;
const STALE_SWEEP_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
// Zombie detection: if no heartbeat received within 3× the heartbeat interval, close the socket.
const HEARTBEAT_LIVENESS_MULTIPLIER = 3;
// A chunked payload may total this many times BRIDGE_MAX_PAYLOAD_SIZE before
// the connection is closed (memory bound for reassembly).
const CHUNK_AGGREGATE_MULTIPLIER = 8;
// Drop a partial chunk assembly that has not completed within this window.
const CHUNK_ASSEMBLY_TTL_MS = 60_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  startedAt: number;
}

interface PairingEntry {
  challenge: string;
  timer: ReturnType<typeof setTimeout>;
}

export type BridgeState = 'disconnected' | 'connecting' | 'connected' | 'error';
/** owner = holds the listener lock and the plugin socket; attached = relays through the owner over loopback. */
export type BridgeRole = 'owner' | 'attached' | 'none';
const ATTACH_TIMEOUT_MS = 5_000;

export class BridgeManager extends EventEmitter {
  public state: BridgeState = 'disconnected';
  public hello: BridgeHello | null = null;
  private _role: BridgeRole = 'none';
  private _ownerPid: number | undefined;
  private _ownerPluginConnected = false;
  private readonly attachedSockets = new Set<WebSocket>();
  private _lastDisconnectMs = 0;
  // ponytail: one queue serialises every relayed request; per-method fairness if reads ever starve.
  private relayQueue: Promise<unknown> = Promise.resolve();

  private wss: WebSocketServer | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;
  private _activePort = 0;
  private _connectedAtMs = 0;
  private readonly requestMap = new Map<string, PendingRequest>();
  private requestIdCounter = 0;
  private readonly config: EnvConfig;
  private _lastHeartbeatMs = 0;
  private reconnectAttempts = 0;
  private reconnectStartMs = 0;
  private _nextReconnectAtMs = 0;
  private readonly pairingChallenges = new Map<string, PairingEntry>();
  private readonly _methodRegistryHash: string;
  private _extensionVersion: string | undefined;
  private _extensionMethodListHash: string | undefined;
  private _loaderVersion: string | undefined;
  private _extensionBuildId: string | undefined;
  private listenerOwnership: BridgeListenerOwnership | undefined;
  private _ownershipConflict: BridgeOwnershipConflict | undefined;

  constructor(config: EnvConfig) {
    super();
    this.config = config;
    this._methodRegistryHash = this.computeMethodRegistryHash();
  }

  get lastHeartbeatMs(): number {
    return this._lastHeartbeatMs;
  }

  get activePort(): number {
    return this._activePort;
  }

  get ownershipConflict(): BridgeOwnershipConflict | undefined {
    return this._ownershipConflict;
  }

  get uptimeMs(): number {
    if (this.state !== 'connected' || this._connectedAtMs === 0) return 0;
    return Date.now() - this._connectedAtMs;
  }

  get connected(): boolean {
    if (this._role === 'attached') return this.state === 'connected' && this._ownerPluginConnected;
    return this.state === 'connected';
  }

  get role(): BridgeRole {
    return this._role;
  }

  /** Pid of the process holding the bridge listener (self when owner). */
  get ownerPid(): number | undefined {
    return this._role === 'owner' ? process.pid : this._ownerPid;
  }

  get attachedClients(): number {
    return this.attachedSockets.size;
  }

  get reconnectAttemptCount(): number {
    return this.reconnectAttempts;
  }

  get lastDisconnectMs(): number {
    return this._lastDisconnectMs;
  }

  /** True while a reconnect timer is armed (plugin dropped, auto-retry pending). */
  get reconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  /** Epoch ms of the next scheduled reconnect attempt, if any. */
  get nextReconnectAtMs(): number | undefined {
    return this._nextReconnectAtMs || undefined;
  }

  /**
   * Wait until the bridge is in the 'connected' state.
   * Resolves immediately if already connected. Rejects after timeoutMs.
   */
  waitForConnection(timeoutMs: number): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connected', onConnected);
        reject(new Error('Bridge not connected'));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once('connected', onConnected);
    });
  }

  get methodRegistryHash(): string {
    return this._methodRegistryHash;
  }

  /** EasyEDA Pro application version reported at the last successful handshake. */
  get easyedaVersion(): string | undefined {
    return this.hello?.easyedaVersion;
  }

  /** Bridge extension version reported at the last successful handshake. */
  get extensionVersion(): string | undefined {
    return this._extensionVersion;
  }

  /** Whether the connected extension's version differs from this server's version. */
  get extensionVersionMismatch(): boolean {
    return this._extensionVersion !== undefined && this._extensionVersion !== SERVER_VERSION;
  }

  /** Method-list hash reported by the extension's active dispatcher at handshake. */
  get extensionMethodListHash(): string | undefined {
    return this._extensionMethodListHash;
  }

  /** Extension loader version reported at handshake (tracks the .eext import). */
  get loaderVersion(): string | undefined {
    return this._loaderVersion;
  }

  /** Dispatcher build id reported by the plugin at handshake (compare with the shipped checksums manifest). */
  get extensionBuildId(): string | undefined {
    return this._extensionBuildId;
  }

  /**
   * True when the extension reported a dispatcher method-list hash that does
   * not match this server's method registry — i.e. the extension is serving
   * stale (or newer) dispatch logic. Undefined-hash extensions (older builds)
   * report false here; extension_version_mismatch covers those.
   */
  get registryMismatch(): boolean {
    return (
      this._extensionMethodListHash !== undefined &&
      this._extensionMethodListHash !== this._methodRegistryHash
    );
  }

  private isLoopbackHost(host: string): boolean {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  }

  private computeMethodRegistryHash(): string {
    // Locale-independent ordering: must produce byte-identical input to the
    // extension loader's refreshMethodListHash (do NOT use localeCompare here).
    const sorted = [...EasyedaApiMethodSchema.options].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return crypto.createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 16);
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') return;

    const prev = this.state;
    this.state = 'connecting';
    this.emit('stateChanged', this.state, prev);

    const logger = getLogger();
    this._ownershipConflict = undefined;
    const ownership = new BridgeListenerOwnership(this.config.DATA_DIR, this.config.BRIDGE_HOST);

    try {
      ownership.acquire();
      this.listenerOwnership = ownership;
    } catch (err) {
      if (err instanceof BridgeOwnershipConflictError) {
        this._ownershipConflict = err.conflict;
        const { ownerPort, ownerPid } = err.conflict;
        if (ownerPort && this.isLoopbackHost(this.config.BRIDGE_HOST)) {
          try {
            await this.attachToOwner(ownerPort, ownerPid);
            logger.info({ ownerPid, ownerPort }, 'attached to the bridge owner as a relay client');
            return;
          } catch (attachErr) {
            logger.warn({ err: attachErr, ownerPort }, 'attach to bridge owner failed');
          }
        }
      }
      this.state = 'error';
      this.emit('stateChanged', 'error', 'connecting');
      throw err;
    }

    const ports = parsePortScanSpec(this.config.BRIDGE_PORT_SCAN);
    let lastErr: Error | null = null;

    for (const port of ports) {
      try {
        ownership.updatePort(port);
        await this.tryListen(port);
        this._role = 'owner';
        logger.info({ port }, 'bridge websocket server listening');
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        logger.debug({ port, err: lastErr.message }, 'bridge port unavailable, trying next');
      }
    }

    ownership.release();
    this.listenerOwnership = undefined;
    logger.error({ ports, err: lastErr?.message }, 'failed to start bridge server on any port');
    this.state = 'error';
    this.emit('stateChanged', 'error', 'connecting');
    this.emit('error', lastErr ?? new Error('No available bridge port'));
    throw lastErr ?? new Error('No available bridge port');
  }

  private tryListen(port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        host: this.config.BRIDGE_HOST,
        port,
      });
      this.wss = wss;
      this._activePort = port;

      wss.once('listening', () => {
        wss.on('error', (err) => {
          getLogger().error({ err }, 'bridge server error');
          this.emit('error', err);
        });
        resolve();
      });
      wss.once('error', (err) => {
        this.wss = null;
        this._activePort = 0;
        reject(err);
      });

      wss.on('connection', (ws) => this.handleConnection(ws));
    });
  }

  private handleConnection(ws: WebSocket): void {
    const logger = getLogger();
    const isLoopback = this.isLoopbackHost(this.config.BRIDGE_HOST);
    const needsPairing = !isLoopback && !!this.config.BRIDGE_TOKEN;
    let paired = !needsPairing;
    let pairingChallengeId: string | null = null;

    logger.info({ needsPairing, isLoopback }, 'new bridge client connection');

    // Issue pairing challenge for non-loopback connections with a token configured
    if (needsPairing) {
      const challenge = crypto.randomUUID();
      pairingChallengeId = challenge;
      const timer = setTimeout(() => {
        if (this.pairingChallenges.has(challenge)) {
          this.pairingChallenges.delete(challenge);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4001, 'pairing_timeout');
          }
        }
      }, PAIRING_TIMEOUT_MS);
      this.pairingChallenges.set(challenge, { challenge, timer });
      ws.send(JSON.stringify({ type: 'pairing_challenge', challenge }));
      logger.info('sent pairing challenge to new client');
    }

    // A5: reassembly buffers for `{type:'chunk'}` envelopes from this client.
    // A chunked payload may exceed the per-frame cap but is bounded by the
    // aggregate cap; partial assemblies expire after CHUNK_ASSEMBLY_TTL_MS.
    const chunkAssemblies = new Map<
      string,
      {
        chunks: Array<string | undefined>;
        total: number;
        received: number;
        bytes: number;
        startedAt: number;
      }
    >();
    const aggregateCap = this.config.BRIDGE_MAX_PAYLOAD_SIZE * CHUNK_AGGREGATE_MULTIPLIER;

    const routeParsed = (data: { type?: string } & Record<string, unknown>): void => {
      if (data.type === 'attach') {
        this.handleAttach(ws, data);
      } else if (this.attachedSockets.has(ws)) {
        if (data.type === 'request') this.relayAttachedRequest(ws, data);
      } else if (data.type === 'handshake') {
        this.handleHandshake(ws, data);
      } else if (data.type === 'response') {
        this.handleResponse(data as unknown as BridgeResponse);
      } else if (data.type === 'request') {
        this.handleIncomingRequest(ws, data);
      } else if (data.type === 'heartbeat') {
        this._lastHeartbeatMs = Date.now();
        this.emit('heartbeat', data.timestamp);
      }
    };

    const handleChunk = (data: Record<string, unknown>): void => {
      const id = typeof data.id === 'string' ? data.id : '';
      const seq = typeof data.seq === 'number' ? data.seq : -1;
      const total = typeof data.total === 'number' ? data.total : 0;
      const piece = typeof data.data === 'string' ? data.data : undefined;
      if (!id || seq < 0 || total < 1 || total > 4096 || seq >= total || piece === undefined) {
        logger.warn({ id, seq, total }, 'invalid chunk envelope');
        return;
      }
      const now = Date.now();
      for (const [key, entry] of chunkAssemblies) {
        if (now - entry.startedAt > CHUNK_ASSEMBLY_TTL_MS) chunkAssemblies.delete(key);
      }
      let assembly = chunkAssemblies.get(id);
      if (!assembly) {
        assembly = {
          chunks: new Array<string | undefined>(total),
          total,
          received: 0,
          bytes: 0,
          startedAt: now,
        };
        chunkAssemblies.set(id, assembly);
      }
      if (assembly.total !== total) {
        chunkAssemblies.delete(id);
        logger.warn({ id }, 'chunk total changed mid-assembly, dropping');
        return;
      }
      if (assembly.chunks[seq] === undefined) {
        assembly.received += 1;
        assembly.bytes += piece.length;
      }
      assembly.chunks[seq] = piece;
      if (assembly.bytes > aggregateCap) {
        chunkAssemblies.delete(id);
        logger.warn(
          { id, bytes: assembly.bytes, aggregateCap },
          'chunked payload exceeds aggregate cap',
        );
        ws.close(4009, 'payload_too_large');
        return;
      }
      if (assembly.received === assembly.total) {
        chunkAssemblies.delete(id);
        try {
          routeParsed(JSON.parse(assembly.chunks.join('')));
        } catch (err) {
          logger.error({ err, id }, 'failed to parse reassembled chunked payload');
        }
      }
    };

    ws.on('message', (raw) => {
      try {
        // 0. Payload size enforcement (before parsing)
        const rawSize = Array.isArray(raw)
          ? raw.reduce((sum, chunk) => sum + chunk.byteLength, 0)
          : raw.byteLength;
        if (rawSize > this.config.BRIDGE_MAX_PAYLOAD_SIZE) {
          logger.warn({ size: rawSize }, 'payload exceeds maximum size');
          ws.close(4009, 'payload_too_large');
          return;
        }

        const data = JSON.parse(raw.toString());

        // 1. Handle pairing response (if challenge was issued)
        if (!paired && pairingChallengeId && data.type === 'pairing_response') {
          const parsed = BridgePairingResponseSchema.safeParse(data);
          if (
            !parsed.success ||
            parsed.data.challenge !== pairingChallengeId ||
            parsed.data.sessionToken !== this.config.BRIDGE_TOKEN
          ) {
            logger.warn('pairing response validation failed');
            ws.close(4001, 'invalid_pairing');
            return;
          }
          // Pairing successful — clean up challenge and allow handshake
          const entry = this.pairingChallenges.get(pairingChallengeId);
          if (entry) {
            clearTimeout(entry.timer);
            this.pairingChallenges.delete(pairingChallengeId);
          }
          paired = true;
          logger.info('client pairing successful');
          return; // Wait for the next message (handshake)
        }

        // 2. Reject if pairing is required but not yet completed
        if (needsPairing && !paired) {
          ws.close(4001, 'pairing_required');
          return;
        }

        // 3. Normal message routing (chunk envelopes reassemble, then route)
        if (data.type === 'chunk') {
          handleChunk(data);
          return;
        }
        routeParsed(data);
      } catch (err) {
        logger.error({ err }, 'bridge message processing error');
      }
    });

    ws.on('close', (code, reason) => {
      if (this.attachedSockets.delete(ws)) {
        logger.info({ code, remaining: this.attachedSockets.size }, 'attached bridge client left');
        return;
      }
      if (this.ws !== ws) {
        logger.debug({ code, reason: reason.toString() }, 'stale bridge client disconnected');
        return;
      }

      logger.info({ code, reason: reason.toString() }, 'bridge client disconnected');
      this.ws = null;
      const prevState = this.state;
      this.state = 'connecting';
      this._connectedAtMs = 0;
      this._lastDisconnectMs = Date.now();
      this.broadcastToAttached({ type: 'owner_status', pluginConnected: false });
      this.hello = null;
      this._extensionVersion = undefined;
      this._extensionMethodListHash = undefined;
      this._loaderVersion = undefined;
      this.stopStaleSweep();
      this.stopHeartbeat();

      // Clean up any pending pairing challenges
      for (const [, entry] of this.pairingChallenges) {
        clearTimeout(entry.timer);
      }
      this.pairingChallenges.clear();

      this.rejectPending(
        new Error(`Bridge disconnected: ${reason.toString() || 'connection closed'}`),
      );
      this.emit('stateChanged', this.state, prevState);
      this.emit('disconnected', reason.toString() || 'connection closed');
      this.scheduleReconnect();
      // The WSS is still listening; no reconnect needed — wait for the next client.
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'bridge client socket error');
    });
  }

  /**
   * Validate and accept a handshake message. Sets up the bridge session
   * and replies with a hello containing the server's capabilities.
   */
  private handleHandshake(ws: WebSocket, data: unknown): void {
    const logger = getLogger();
    const parsed = BridgeHandshakeSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn({ errors: parsed.error.issues }, 'bridge handshake validation failed');
      ws.close(4001, 'Invalid handshake');
      return;
    }

    // Session token enforcement
    if (this.config.BRIDGE_TOKEN) {
      if (!parsed.data.sessionToken) {
        logger.warn('bridge handshake rejected: session token required');
        ws.close(4001, 'session_token_required');
        return;
      }
      if (parsed.data.sessionToken !== this.config.BRIDGE_TOKEN) {
        logger.warn('bridge handshake rejected: invalid session token');
        ws.close(4001, 'invalid_session_token');
        return;
      }
    }

    // Replace existing connection if any
    const previousWs = this.ws;
    const prevState = this.state;

    if (previousWs && previousWs !== ws) {
      logger.info('replacing existing bridge client connection');
      this.rejectPending(new Error('Bridge connection replaced by a new client.'));
      // The EasyEDA register() socket path has no close callback, so tell the
      // old plugin instance directly; otherwise it reconnects and replaces us back.
      try {
        previousWs.send(JSON.stringify({ type: 'replaced' }));
      } catch {
        // socket already gone
      }
      previousWs.close(4000, 'Replaced by new bridge client');
      this.stopHeartbeat();
      this.stopStaleSweep();
    }

    this.ws = ws;
    this.state = 'connected';
    this._connectedAtMs = Date.now();
    this._lastHeartbeatMs = Date.now(); // seed so first liveness check doesn't fire immediately
    this.reconnectAttempts = 0;
    this.reconnectStartMs = 0;

    // Extension version mismatch warning
    const extVer = parsed.data.extensionVersion;
    this._extensionVersion = extVer;
    if (extVer && extVer !== SERVER_VERSION) {
      logger.warn(
        `⚠️ EasyEDA Pro bridge extension version mismatch: extension is v${extVer}, but MCP server is v${SERVER_VERSION}. Please update the extension in EasyEDA Pro.`,
      );
    }

    // Dispatcher registry staleness: unlike the advisory version warning, this
    // compares the actual method surface, so a stale dispatcher fails loudly
    // in health_check/run_self_test (and triggers an auto-push in hot-swap dev mode).
    this._extensionMethodListHash = parsed.data.methodListHash;
    this._loaderVersion = parsed.data.loaderVersion;
    this._extensionBuildId = parsed.data.buildId;
    if (this.registryMismatch) {
      logger.error(
        {
          extensionMethodListHash: this._extensionMethodListHash,
          serverMethodRegistryHash: this._methodRegistryHash,
        },
        'bridge method registry mismatch: the extension dispatcher is stale. ' +
          'Re-import the extension, or enable BRIDGE_HOT_SWAP_ENABLED for auto-push in dev.',
      );
      this.emit('registryMismatch', {
        extensionMethodListHash: this._extensionMethodListHash,
        serverMethodRegistryHash: this._methodRegistryHash,
      });
    }

    this.hello = {
      type: 'hello',
      bridgeVersion: SERVER_VERSION,
      contractVersion: BRIDGE_CONTRACT_VERSION,
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      easyedaVersion: parsed.data.easyedaVersion,
      capabilities: EasyedaApiMethodSchema.options,
      methodRegistryHash: this._methodRegistryHash,
      maxPayloadSize: this.config.BRIDGE_MAX_PAYLOAD_SIZE,
      supportsChunking: true,
      maxAggregatePayloadSize: this.config.BRIDGE_MAX_PAYLOAD_SIZE * CHUNK_AGGREGATE_MULTIPLIER,
      hotSwapEnabled: this.config.BRIDGE_HOT_SWAP_ENABLED || undefined,
      devMode: parsed.data.devMode ?? false,
    };

    // Reply with hello
    ws.send(JSON.stringify(this.hello));
    if (prevState !== 'connected') {
      this.emit('stateChanged', 'connected', prevState);
    }
    this.emit('connected', this.hello);
    this.startHeartbeat();
    this.startStaleSweep();
    this.broadcastToAttached(this.attachOkMessage());
  }

  private attachOkMessage(): Record<string, unknown> {
    return {
      type: 'attach_ok',
      ownerPid: process.pid,
      pluginConnected: this.state === 'connected' && this.ws !== null,
      hello: this.hello,
      extensionVersion: this._extensionVersion,
      extensionMethodListHash: this._extensionMethodListHash,
      loaderVersion: this._loaderVersion,
      extensionBuildId: this._extensionBuildId,
    };
  }

  private broadcastToAttached(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const socket of this.attachedSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    }
  }

  /** Owner side: accept a loopback MCP server process as a relay client. No token exchange — loopback only. */
  private handleAttach(ws: WebSocket, data: Record<string, unknown>): void {
    if (!this.isLoopbackHost(this.config.BRIDGE_HOST) || this._role !== 'owner') {
      ws.send(
        JSON.stringify({ type: 'attach_rejected', message: 'attach is loopback-owner only' }),
      );
      ws.close(4003, 'attach_rejected');
      return;
    }
    this.attachedSockets.add(ws);
    getLogger().info(
      { clientPid: data.pid, attached: this.attachedSockets.size },
      'attached bridge client registered',
    );
    ws.send(JSON.stringify(this.attachOkMessage()));
    this.emit('attached', { pid: data.pid, count: this.attachedSockets.size });
  }

  private relayAttachedRequest(ws: WebSocket, data: unknown): void {
    const parsed = BridgeRequestSchema.safeParse(data);
    const id = String((data as Record<string, unknown>)?.id ?? 'unknown');
    const reply = (body: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, type: 'response', ...body }));
    };
    if (!parsed.success) {
      reply({
        ok: false,
        error: { code: 'INVALID_PARAMS', message: 'Invalid request schema', suggestion: '' },
        durationMs: 0,
      });
      return;
    }
    if (this.state !== 'connected' || !this.ws) {
      reply({
        ok: false,
        error: {
          code: 'BRIDGE_NOT_READY',
          message: 'Bridge not connected: the owner process has no EasyEDA plugin session.',
          suggestion: 'Open EasyEDA Pro with the bridge extension loaded, then retry.',
        },
        durationMs: 0,
      });
      return;
    }
    const startedAt = Date.now();
    const { method, params, timeoutMs, traceparent } = parsed.data;
    this.relayQueue = this.relayQueue
      .catch(() => undefined)
      .then(() => this.call(method, params, { timeoutMs, traceparent }))
      .then(
        (result) => reply({ ok: true, result, durationMs: Date.now() - startedAt }),
        (err: Error & { code?: string; suggestion?: string; data?: unknown }) =>
          reply({
            ok: false,
            error: {
              code: err.code ?? (err.message.includes('timed out') ? 'TIMEOUT' : 'UNKNOWN'),
              message: err.message,
              suggestion: err.suggestion ?? '',
              data: err.data,
            },
            durationMs: Date.now() - startedAt,
          }),
      );
  }

  /** Attached side: open a loopback socket to the owner and relay calls through it. */
  private attachToOwner(port: number, ownerPid: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.terminate();
        reject(new Error(`attach to bridge owner on port ${port} timed out`));
      }, ATTACH_TIMEOUT_MS);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      ws.once('error', fail);
      ws.once('open', () =>
        ws.send(JSON.stringify({ type: 'attach', pid: process.pid, clientName: 'easyeda-mcp-pro' })),
      );
      ws.on('message', (raw) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        if (data.type === 'attach_ok') {
          this.applyOwnerStatus(data);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            this.ws = ws;
            this._role = 'attached';
            this._activePort = port;
            this._ownerPid = typeof data.ownerPid === 'number' ? data.ownerPid : ownerPid;
            this._connectedAtMs = Date.now();
            this._lastHeartbeatMs = Date.now();
            this.reconnectAttempts = 0;
            const prev = this.state;
            this.state = 'connected';
            this.emit('stateChanged', 'connected', prev);
            if (this._ownerPluginConnected) this.emit('connected', this.hello);
            resolve();
          } else if (this._ownerPluginConnected) {
            this.emit('connected', this.hello);
          }
        } else if (data.type === 'owner_status') {
          this.applyOwnerStatus(data);
        } else if (data.type === 'attach_rejected') {
          fail(new Error(String(data.message ?? 'attach rejected')));
        } else if (data.type === 'response') {
          this.handleResponse(data as unknown as BridgeResponse);
        } else if (data.type === 'heartbeat') {
          this._lastHeartbeatMs = Date.now();
        }
      });
      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return;
        getLogger().info({ code }, 'relay link to bridge owner closed');
        this.ws = null;
        this._role = 'none';
        this._ownerPluginConnected = false;
        this._lastDisconnectMs = Date.now();
        this.hello = null;
        const prev = this.state;
        // ponytail: 'error' not 'connecting' — connect() early-returns on 'connecting', so the relay never recovered once the owner exited.
        this.state = 'error';
        this.rejectPending(new Error(`Bridge disconnected: ${reason.toString() || 'owner link closed'}`));
        this.emit('stateChanged', this.state, prev);
        this.emit('disconnected', 'owner link closed');
        this.scheduleReconnect();
      });
    });
  }

  private applyOwnerStatus(data: Record<string, unknown>): void {
    this._ownerPluginConnected = data.pluginConnected === true;
    if ('hello' in data) this.hello = (data.hello as BridgeHello | null) ?? null;
    if ('extensionVersion' in data) this._extensionVersion = data.extensionVersion as string | undefined;
    if ('extensionMethodListHash' in data)
      this._extensionMethodListHash = data.extensionMethodListHash as string | undefined;
    if ('loaderVersion' in data) this._loaderVersion = data.loaderVersion as string | undefined;
    if ('extensionBuildId' in data) this._extensionBuildId = data.extensionBuildId as string | undefined;
  }

  /**
   * Validate and handle an incoming request from the extension.
   * The server does not currently accept arbitrary extension requests,
   * so unknown methods are rejected with a structured error response.
   */
  private handleIncomingRequest(ws: WebSocket, data: unknown): void {
    const logger = getLogger();
    const parsed = BridgeRequestSchema.safeParse(data);
    if (!parsed.success) {
      const fallbackId = (data as Record<string, unknown>)?.id ?? 'unknown';
      logger.warn({ id: fallbackId }, 'incoming request validation failed');
      ws.send(
        JSON.stringify({
          id: String(fallbackId),
          type: 'response',
          ok: false,
          error: {
            code: 'INVALID_PARAMS',
            message: 'Invalid request schema',
            suggestion: 'Check the request format and required fields.',
          },
          durationMs: 0,
        }),
      );
      return;
    }

    // Reject unknown methods
    if (!(EasyedaApiMethodSchema.options as readonly string[]).includes(parsed.data.method)) {
      logger.warn({ method: parsed.data.method }, 'unknown bridge method requested');
      ws.send(
        JSON.stringify({
          id: parsed.data.id,
          type: 'response',
          ok: false,
          error: {
            code: 'METHOD_NOT_FOUND',
            message: `Unknown bridge method: "${parsed.data.method}"`,
            suggestion: `Use one of the supported methods: ${EasyedaApiMethodSchema.options.slice(0, 5).join(', ')}…`,
          },
          durationMs: 0,
        }),
      );
      return;
    }

    // Known method, but the server does not handle incoming extension requests directly.
    // This path is reserved for future use (e.g., event notifications from the extension).
    logger.warn({ method: parsed.data.method }, 'incoming request not supported');
    ws.send(
      JSON.stringify({
        id: parsed.data.id,
        type: 'response',
        ok: false,
        error: {
          code: 'BRIDGE_NOT_READY',
          message: 'Incoming extension requests are not supported yet.',
          suggestion: 'Use the MCP tool API to invoke this method.',
        },
        durationMs: 0,
      }),
    );
  }

  async call<TParams, TResult>(
    method: string,
    params?: TParams,
    opts?: { timeoutMs?: number; traceparent?: string },
  ): Promise<TResult> {
    if (this.state !== 'connected') {
      const waitMs = this.config.BRIDGE_WAIT_FOR_EDA_MS;
      if (waitMs > 0) {
        await this.waitForConnection(waitMs);
      }
    }

    const ws = this.ws;
    if (this.state !== 'connected' || !ws) {
      if (this._ownershipConflict && this._role !== 'attached')
        throw new Error(this._ownershipConflict.message);
      throw new Error(`Bridge not connected. Cannot call method "${method}".`);
    }

    const id = `req_${++this.requestIdCounter}`;
    const timeoutMs = opts?.timeoutMs ?? this.config.BRIDGE_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requestMap.delete(id);
        getGlobalMetricsCollector().recordTimed({
          category:
            method.startsWith('export.') || method.startsWith('board.export')
              ? 'export'
              : 'bridge-read',
          name: method,
          durationMs: timeoutMs,
          ok: false,
        });
        reject(new Error(`Bridge method "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.requestMap.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
        startedAt: Date.now(),
      });

      const message = JSON.stringify({
        id,
        type: 'request',
        method,
        params,
        timeoutMs,
        traceparent: opts?.traceparent,
      });

      ws.send(message);
    }) as Promise<TResult>;
  }

  disconnect(reason?: string): void {
    const prev = this.state;
    this.state = 'disconnected';

    this.stopHeartbeat();
    this.stopStaleSweep();
    this.clearReconnectTimer();

    // Clean up pending pairing challenges
    for (const [, entry] of this.pairingChallenges) {
      clearTimeout(entry.timer);
    }
    this.pairingChallenges.clear();

    this.rejectPending(new Error(`Bridge disconnected: ${reason ?? 'unknown'}`));

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const socket of this.attachedSockets) socket.close(4000, 'owner shutting down');
    this.attachedSockets.clear();
    this._role = 'none';
    this._ownerPid = undefined;
    this._ownerPluginConnected = false;

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this._activePort = 0;

    this.listenerOwnership?.release();
    this.listenerOwnership = undefined;
    this._ownershipConflict = undefined;

    this.hello = null;
    this._extensionVersion = undefined;
    this._extensionMethodListHash = undefined;
    this._loaderVersion = undefined;
    this.reconnectAttempts = 0;
    this.emit('stateChanged', this.state, prev);
    this.emit('disconnected', reason ?? 'unknown');
  }

  private handleResponse(data: BridgeResponse): void {
    const entry = this.requestMap.get(data.id);
    if (!entry) {
      getLogger().warn({ requestId: data.id }, 'received response for unknown request');
      return;
    }

    clearTimeout(entry.timer);
    this.requestMap.delete(data.id);
    const durationMs = Date.now() - entry.startedAt;
    getGlobalMetricsCollector().recordTimed({
      category:
        entry.method.startsWith('export.') || entry.method.startsWith('board.export')
          ? 'export'
          : 'bridge-read',
      name: entry.method,
      durationMs,
      ok: data.ok,
    });

    if (data.ok) {
      entry.resolve(data.result);
    } else {
      const error = new Error(data.error?.message ?? `Bridge method "${entry.method}" failed`);
      // Preserve the dispatcher's structured error fields (code/suggestion/data) across
      // the wire — without this, every caller checking `err.code` (e.g. to distinguish
      // NOT_IMPLEMENTED from a timeout, or NET_COLLISION from a generic failure) always
      // sees `undefined`, regardless of what the dispatcher actually reported.
      if (data.error) {
        Object.assign(error, {
          code: data.error.code,
          suggestion: data.error.suggestion,
          data: data.error.data,
        });
      }
      entry.reject(error);
    }
  }

  private rejectPending(error: Error): void {
    for (const [, entry] of this.requestMap) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.requestMap.clear();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.state !== 'connected') return;

      // Zombie detection: close if no heartbeat received within 3x the interval.
      const silenceMs = Date.now() - this._lastHeartbeatMs;
      const timeoutMs = this.config.BRIDGE_HEARTBEAT_MS * HEARTBEAT_LIVENESS_MULTIPLIER;
      if (silenceMs > timeoutMs) {
        getLogger().warn(
          { silenceMs, timeoutMs },
          'bridge heartbeat timeout — zombie connection detected, closing',
        );
        this.ws.close(4002, 'heartbeat_timeout');
        return;
      }

      try {
        this.ws.send(
          JSON.stringify({ type: 'heartbeat', timestamp: Date.now(), source: 'server' }),
        );
      } catch {
        getLogger().warn('bridge heartbeat send failed, disconnecting');
        this.disconnect('heartbeat failed');
      }
    }, this.config.BRIDGE_HEARTBEAT_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Schedule a reconnect attempt with tiered backoff. Never stops retrying.
   * Tiers (elapsed since first disconnect):
   *   0–30 s  → 1 s interval
   *   30–120 s → 3 s interval
   *   >120 s  → 10 s interval
   * Each delay has ±10 % jitter.
   */
  private scheduleReconnect(): void {
    if (this.state === 'disconnected') return;

    if (this.reconnectAttempts === 0) {
      this.reconnectStartMs = Date.now();
    }
    this.reconnectAttempts++;

    const elapsed = Date.now() - this.reconnectStartMs;
    let base: number;
    if (elapsed < 30_000) base = RECONNECT_BASE_MS;
    else if (elapsed < 120_000) base = RECONNECT_BASE_MS * 3;
    else base = Math.min(RECONNECT_BASE_MS * 10, RECONNECT_MAX_DELAY_MS);

    const jitterBasisPoints = crypto.randomInt(-1_000, 1_001);
    const delay = Math.round(base * (1 + jitterBasisPoints / 10_000));

    getLogger().info(
      { attempt: this.reconnectAttempts, delay, elapsed },
      'scheduling bridge reconnect',
    );
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this._nextReconnectAtMs = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._nextReconnectAtMs = 0;
      this.connect().catch((err) => {
        getLogger().error({ err }, 'bridge reconnect failed');
        this.scheduleReconnect();
      });
    }, delay);
  }

  private clearReconnectTimer(): void {
    this._nextReconnectAtMs = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Periodically sweep the pending-request map for entries whose
   * timeout has elapsed but whose `setTimeout` may have been leaked
   * (defence-in-depth). Runs every 30 s while connected.
   */
  private startStaleSweep(): void {
    if (this.staleSweepTimer) clearInterval(this.staleSweepTimer);
    this.staleSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.requestMap) {
        const elapsed = now - entry.startedAt;
        if (elapsed >= this.config.BRIDGE_TIMEOUT_MS) {
          getLogger().warn(
            { requestId: id, method: entry.method, elapsed },
            'stale sweep cleaning up expired request',
          );
          clearTimeout(entry.timer);
          entry.reject(new Error(`Bridge request "${entry.method}" expired (stale sweep)`));
          this.requestMap.delete(id);
        }
      }
    }, STALE_SWEEP_MS);
  }

  private stopStaleSweep(): void {
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
  }
}

/**
 * Parse a port scan specification string into an ordered array of ports.
 * Supports comma-separated values and dash ranges:
 *   "18601"           → [18601]
 *   "18601,49620"     → [18601, 49620]
 *   "49620-49629"     → [49620, 49621, ..., 49629]
 *   "18601,49620-49629" → [18601, 49620, 49621, ..., 49629]
 */
export function parsePortScanSpec(spec: string): number[] {
  const ports: number[] = [];
  const parts = spec.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch && rangeMatch[1] !== undefined && rangeMatch[2] !== undefined) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start > 0 && end > 0 && start <= end && end <= 65535) {
        for (let p = start; p <= end; p++) {
          ports.push(p);
        }
      }
    } else {
      const port = parseInt(trimmed, 10);
      if (port > 0 && port <= 65535) {
        ports.push(port);
      }
    }
  }

  return ports;
}
