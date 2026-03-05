/**
 * Service sync manager (HTTP Pull mode)
 *
 * Replaces libp2p pubsub with DHT rendezvous + HTTP pull:
 *   GET  /services  - return currently-enabled local services (for peers to pull)
 *   POST /notify    - receive a "please pull me" hint, immediately pull the caller
 *
 * Peer discovery:
 *   - On libp2p peer:connect: extract Yggdrasil IPv6 from remoteAddr -> pull + notify
 *   - DHT rendezvous (reuses original rendezvous key) -> dial new peers -> triggers above
 *   - Periodic timer: re-discover + pull all known peers + clean up expired records
 *
 * Public API is identical to ServiceAnnouncementsManager so main.ts IPC handlers
 * do not need any changes.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import log from 'electron-log';
import { getWtbDataDir } from './wtb_config';
import type {
  ServiceAnnouncementStatus,
  LocalServiceConfig,
  AnnouncementSystemStatus,
} from '../types/announcements';

// libp2p type (avoid ESM/CJS import issues)
type Libp2pNode = any;

// Preferred HTTP listen port; auto-increments on conflict
const SERVICE_SYNC_HTTP_PORT_DEFAULT = 47380;

// Timing constants
const REPUBLISH_INTERVAL_MS = 3 * 60 * 1000; // 3 min: re-publish to DHT + pull
const PULL_INTERVAL_MS = 60 * 1000; // 1 min: periodic pull
const DISCOVER_THROTTLE_MS = 10_000;
const DISCOVER_TIMEOUT_MS = 3_000;
const DISCOVER_LIMIT = 16;
const DIAL_TIMEOUT_MS = 2_000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_SERVICE_DESC_LENGTH = 200;
const DHT_ENDPOINT_TTL_SEC = 600; // 10 min

// Reuse the original rendezvous key so new and old clients can find each other
const ANNOUNCEMENT_RENDEZVOUS_KEY = crypto
  .createHash('sha256')
  .update('wtb:announcements:rendezvous:v1')
  .digest();

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const sha256Hex = (input: string): string =>
  crypto.createHash('sha256').update(input).digest('hex');

const getPublicServiceDir = (): string =>
  path.join(getWtbDataDir(), 'publicservice');

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const generateServiceId = (pubkey: string, url: string): string =>
  sha256Hex(pubkey + url).slice(0, 16);

/**
 * Extract IPv6 address from a libp2p multiaddr string.
 * e.g. "/ip6/200:1234:abcd::1/tcp/40000/..." -> "200:1234:abcd::1"
 */
function extractIPv6FromMultiaddr(maStr: string): string | null {
  const m = maStr.match(/^\/ip6\/([^/]+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// NDJSON store (independent copy; same logic as in service_announcements.ts)
// Both implementations point to the same data files under publicservice/
// ---------------------------------------------------------------------------

type NDJsonRecord<T> = T & { _deleted?: boolean };

class NdjsonStore<T extends { id: string }> {
  private filePath: string;
  private cache: Map<string, NDJsonRecord<T>> = new Map();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.cache.clear();
    if (!fs.existsSync(this.filePath)) {
      this.loaded = true;
      return;
    }
    const lines = fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as NDJsonRecord<T>;
        if (rec._deleted) {
          this.cache.delete(rec.id);
        } else {
          this.cache.set(rec.id, rec);
        }
      } catch {
        // ignore malformed lines
      }
    }
    this.loaded = true;
  }

  private appendRecord(rec: NDJsonRecord<T>) {
    ensureDir(path.dirname(this.filePath));
    fs.appendFileSync(this.filePath, JSON.stringify(rec) + '\n', 'utf8');
  }

  async get(id: string): Promise<T | null> {
    this.ensureLoaded();
    const rec = this.cache.get(id);
    return rec && !rec._deleted ? (rec as T) : null;
  }

  async has(id: string): Promise<boolean> {
    this.ensureLoaded();
    const rec = this.cache.get(id);
    return !!rec && !rec._deleted;
  }

  async upsert(obj: T): Promise<void> {
    this.ensureLoaded();
    this.cache.set(obj.id, obj);
    this.appendRecord(obj);
  }

  async delete(id: string): Promise<void> {
    this.ensureLoaded();
    if (this.cache.has(id)) {
      this.cache.delete(id);
      this.appendRecord({ id, _deleted: true } as NDJsonRecord<T>);
    }
  }

  async list(): Promise<T[]> {
    this.ensureLoaded();
    return Array.from(this.cache.values()).filter((r) => !r._deleted) as T[];
  }

  async count(): Promise<number> {
    this.ensureLoaded();
    return Array.from(this.cache.values()).filter((r) => !r._deleted).length;
  }
}

const getLocalServicesNdjsonPath = () =>
  path.join(getPublicServiceDir(), 'local_services.ndjson');
const getDiscoveredServicesNdjsonPath = () =>
  path.join(getPublicServiceDir(), 'discovered_services.ndjson');

class ServiceNdjsonStore {
  private localStore = new NdjsonStore<LocalServiceConfig>(
    getLocalServicesNdjsonPath(),
  );
  private discoveredStore = new NdjsonStore<ServiceAnnouncementStatus>(
    getDiscoveredServicesNdjsonPath(),
  );

  async getCounts(): Promise<{ local: number; discovered: number }> {
    return {
      local: await this.localStore.count(),
      discovered: await this.discoveredStore.count(),
    };
  }

  async getLocalService(id: string): Promise<LocalServiceConfig | null> {
    return this.localStore.get(id);
  }

  async hasLocalService(id: string): Promise<boolean> {
    return this.localStore.has(id);
  }

  async upsertLocalService(cfg: LocalServiceConfig): Promise<void> {
    return this.localStore.upsert(cfg);
  }

  async deleteLocalService(id: string): Promise<void> {
    return this.localStore.delete(id);
  }

  async listLocalServices(): Promise<LocalServiceConfig[]> {
    return this.localStore.list();
  }

  async getDiscoveredService(
    id: string,
  ): Promise<ServiceAnnouncementStatus | null> {
    return this.discoveredStore.get(id);
  }

  async upsertDiscoveredService(svc: ServiceAnnouncementStatus): Promise<void> {
    return this.discoveredStore.upsert(svc);
  }

  async deleteDiscoveredService(id: string): Promise<void> {
    return this.discoveredStore.delete(id);
  }

  async listDiscoveredServicesRaw(): Promise<ServiceAnnouncementStatus[]> {
    return this.discoveredStore.list();
  }
}

// ---------------------------------------------------------------------------
// ServiceSyncHttpManager
// ---------------------------------------------------------------------------

export class ServiceSyncHttpManager {
  private node: Libp2pNode | null = null;
  private store = new ServiceNdjsonStore();
  private httpServer: http.Server | null = null;
  private httpListenPort = SERVICE_SYNC_HTTP_PORT_DEFAULT;

  private republishTimer: NodeJS.Timeout | null = null;
  private pullTimer: NodeJS.Timeout | null = null;
  private peerConnectListener: ((evt: any) => void) | null = null;

  private signPublicKeyDerB64: string | null = null;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private signPrivateKeyDerB64: string | null = null;

  // peerId -> HTTP endpoint URL (http://[ygg-ipv6]:port)
  private knownEndpoints = new Map<string, string>();

  private lastDiscoverAttemptAt = 0;

  // ---------------------------------------------------------------------------
  // Public API (identical to ServiceAnnouncementsManager)
  // ---------------------------------------------------------------------------

  setIdentityKeys(signPrivateDerB64: string, signPublicDerB64: string): void {
    this.signPrivateKeyDerB64 = signPrivateDerB64;
    this.signPublicKeyDerB64 = signPublicDerB64;
  }

  async start(libp2pNode: Libp2pNode): Promise<void> {
    if (this.node) {
      log.warn('ServiceSyncHttpManager already started');
      return;
    }

    this.node = libp2pNode;

    // Build endpoint map from already-connected peers
    this.refreshConnectedPeerEndpoints();

    // Start HTTP server
    await this.startHttpServer();

    // peer:connect listener: new connection -> extract IPv6 -> pull + notify
    this.peerConnectListener = (evt: any) => {
      const peerId = evt?.detail?.toString?.() ?? String(evt?.detail ?? '');
      if (!peerId) return;
      log.info('service-sync: peer connected %s', peerId);
      this.refreshConnectedPeerEndpoints();
      void this.pullFromPeer(peerId);
      void this.notifyPeer(peerId);
    };
    this.node.addEventListener('peer:connect', this.peerConnectListener);

    // Publish self to DHT and start periodic timers
    await this.publishSelfToDht();

    this.republishTimer = setInterval(() => {
      void this.republishRoutine();
    }, REPUBLISH_INTERVAL_MS);

    this.pullTimer = setInterval(() => {
      void this.pullFromAllKnownPeers();
    }, PULL_INTERVAL_MS);

    // Initial pull from known peers
    await this.pullFromAllKnownPeers();

    log.info(
      'ServiceSyncHttpManager started (HTTP port %d)',
      this.httpListenPort,
    );
  }

  async stop(): Promise<void> {
    if (!this.node) return;

    if (this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }

    if (this.peerConnectListener) {
      try {
        this.node.removeEventListener('peer:connect', this.peerConnectListener);
      } catch {
        // ignore
      }
      this.peerConnectListener = null;
    }

    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.httpServer = null;
    this.node = null;

    log.info('ServiceSyncHttpManager stopped');
  }

  async getStatus(): Promise<AnnouncementSystemStatus> {
    const counts = await this.store.getCounts();
    const node = this.node;

    let listenAddrs: string[] | undefined;
    let peers: string[] | undefined;
    let peerConnections:
      | Array<{ peerId: string; addrs: string[] }>
      | undefined;

    if (node) {
      try {
        listenAddrs = node
          .getMultiaddrs?.()
          .map((ma: any) => ma.toString());
      } catch {
        // ignore
      }

      try {
        peers = node.getPeers?.().map((p: any) => p.toString());
      } catch {
        // ignore
      }

      try {
        const conns = (node as any).getConnections?.() ?? [];
        const peerConnMap = new Map<string, Set<string>>();
        for (const conn of conns) {
          try {
            const pid = conn.remotePeer?.toString?.() ?? '';
            const addrStr = conn.remoteAddr?.toString?.() ?? '';
            if (!pid) continue;
            if (!peerConnMap.has(pid)) peerConnMap.set(pid, new Set());
            if (addrStr) peerConnMap.get(pid)!.add(addrStr);
          } catch {
            // ignore per-connection errors
          }
        }
        peerConnections = Array.from(peerConnMap.entries()).map(
          ([pid, addrSet]) => ({
            peerId: pid,
            addrs: Array.from(addrSet),
          }),
        );
      } catch {
        // ignore
      }
    }

    return {
      running: node != null,
      peerId: node?.peerId?.toString?.(),
      listenAddrs,
      peers,
      peerConnections,
      // subscribedTopic field repurposed to carry runtime mode info for the UI
      subscribedTopic: node
        ? `http-pull:${this.httpListenPort}`
        : undefined,
      localServicesCount: counts.local,
      discoveredServicesCount: counts.discovered,
    };
  }

  async republishNow(): Promise<void> {
    if (!this.node) throw new Error('Service sync not running');
    await this.discoverPeersViaDhtBestEffort('manual republish');
    await this.publishSelfToDht();
    this.refreshConnectedPeerEndpoints();
    await this.pullFromAllKnownPeers();
  }

  async addLocalService(
    url: string,
    desc: string,
  ): Promise<LocalServiceConfig> {
    if (!this.signPublicKeyDerB64) throw new Error('Identity key not set');

    const trimmedUrl = (url ?? '').trim();
    const trimmedDesc = (desc ?? '').trim();

    if (!trimmedUrl) throw new Error('Service URL cannot be empty');
    if (!trimmedDesc) throw new Error('Service description cannot be empty');
    if (trimmedDesc.length > MAX_SERVICE_DESC_LENGTH) {
      throw new Error(
        `Service description too long (max ${MAX_SERVICE_DESC_LENGTH} chars)`,
      );
    }

    const id = generateServiceId(this.signPublicKeyDerB64, trimmedUrl);
    const existing = await this.store.getLocalService(id);

    const config: LocalServiceConfig = {
      id,
      url: trimmedUrl,
      desc: trimmedDesc,
      seq: existing ? existing.seq + 1 : 1,
      enabled: true,
      createdAt: existing?.createdAt ?? Date.now(),
      lastPublishedAt: Date.now(),
    };

    await this.store.upsertLocalService(config);

    // Notify all known peers to pull from us
    if (this.node) {
      void this.broadcastNotify();
    }

    return config;
  }

  async removeLocalService(id: string): Promise<void> {
    const config = await this.store.getLocalService(id);
    if (!config) throw new Error('Service not found');

    await this.store.deleteLocalService(id);

    if (this.node) {
      void this.broadcastNotify();
    }
  }

  async listLocalServices(): Promise<LocalServiceConfig[]> {
    return this.store.listLocalServices();
  }

  async listDiscoveredServices(): Promise<ServiceAnnouncementStatus[]> {
    const now = Date.now();
    const all = await this.store.listDiscoveredServicesRaw();
    return all
      .filter((svc) => {
        if (svc.revoked) return false;
        const expiresAt = new Date(svc.ts).getTime() + svc.ttl * 1000;
        return expiresAt > now;
      })
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  async cleanupExpiredServices(): Promise<void> {
    const now = Date.now();
    const all = await this.store.listDiscoveredServicesRaw();
    for (const svc of all) {
      const expiresAt = new Date(svc.ts).getTime() + svc.ttl * 1000;
      if (expiresAt <= now || svc.revoked) {
        await this.store.deleteDiscoveredService(svc.id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Extract peer Yggdrasil IPv6 from active libp2p connections and update
   * knownEndpoints. Only writes if not already known (manual notify entries win).
   */
  private refreshConnectedPeerEndpoints(): void {
    const node = this.node;
    if (!node) return;
    try {
      const conns = (node as any).getConnections?.() ?? [];
      for (const conn of conns) {
        try {
          const peerId = conn.remotePeer?.toString?.() ?? '';
          const addrStr = conn.remoteAddr?.toString?.() ?? '';
          if (!peerId || !addrStr) continue;
          const ipv6 = extractIPv6FromMultiaddr(addrStr);
          // Yggdrasil IPv6 contains several ':'; exclude loopback
          if (!ipv6 || !ipv6.includes(':') || ipv6 === '::1') continue;
          if (!this.knownEndpoints.has(peerId)) {
            this.knownEndpoints.set(
              peerId,
              `http://[${ipv6}]:${this.httpListenPort}`,
            );
          }
        } catch {
          // ignore per-connection errors
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * Build the self HTTP endpoint URL by extracting our Yggdrasil IPv6
   * from libp2p listen addresses. Returns null if not yet available.
   */
  private getSelfHttpEndpoint(): string | null {
    const node = this.node;
    if (!node || !this.httpListenPort) return null;
    try {
      const addrs = node.getMultiaddrs?.() ?? [];
      for (const ma of addrs) {
        const ipv6 = extractIPv6FromMultiaddr(ma.toString());
        if (ipv6 && ipv6.includes(':') && ipv6 !== '::1') {
          return `http://[${ipv6}]:${this.httpListenPort}`;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  // ---- HTTP server ----

  private async startHttpServer(): Promise<void> {
    this.httpServer = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    // Try preferred port; auto-increment up to 10 times on EADDRINUSE
    let port = this.httpListenPort;
    let bound = false;
    for (let attempt = 0; attempt < 10 && !bound; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve, reject) => {
          this.httpServer!.once('error', reject);
          this.httpServer!.listen(port, '0.0.0.0', () => {
            this.httpServer!.removeAllListeners('error');
            resolve();
          });
        });
        bound = true;
      } catch (err: any) {
        if (err?.code === 'EADDRINUSE') {
          port += 1;
        } else {
          throw err;
        }
      }
    }

    const addr = this.httpServer.address();
    this.httpListenPort =
      typeof addr === 'object' && addr ? addr.port : port;
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // ignore
    }

    if (method === 'GET' && pathname === '/services') {
      await this.handleGetServices(res);
      return;
    }

    if (method === 'POST' && pathname === '/notify') {
      await this.handlePostNotify(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  }

  /** GET /services - return enabled local services for peers to pull */
  private async handleGetServices(res: http.ServerResponse): Promise<void> {
    try {
      const locals = await this.store.listLocalServices();
      const peerId = this.node?.peerId?.toString?.() ?? '';
      const services: ServiceAnnouncementStatus[] = locals
        .filter((s) => s.enabled)
        .map((s) => ({
          id: s.id,
          peerId,
          url: s.url,
          desc: s.desc,
          seq: s.seq,
          ts: new Date().toISOString(),
          ttl: 86400,
          revoked: false,
          receivedAt: Date.now(),
          isLocal: false,
        }));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ services }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  }

  /**
   * POST /notify - receive a "come pull me" hint (body: { peerId, endpoint })
   * Store the caller's endpoint and immediately trigger a pull.
   */
  private async handlePostNotify(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    await new Promise<void>((resolve) => req.on('end', resolve));

    try {
      const body = raw
        ? (JSON.parse(raw) as { peerId?: unknown; endpoint?: unknown })
        : {};
      const remotePeerId = String(body.peerId ?? '');
      const remoteEndpoint = String(body.endpoint ?? '');
      if (
        remotePeerId &&
        remoteEndpoint &&
        remoteEndpoint.startsWith('http')
      ) {
        this.knownEndpoints.set(remotePeerId, remoteEndpoint);
      }
      if (remotePeerId) {
        void this.pullFromPeer(remotePeerId);
      }
    } catch {
      // ignore malformed body
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  // ---- Pull / Notify ----

  private async pullFromPeer(peerId: string): Promise<void> {
    const endpoint = this.knownEndpoints.get(peerId);
    if (!endpoint) return;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(`${endpoint}/services`, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) return;

      const json = (await resp.json()) as {
        services?: ServiceAnnouncementStatus[];
      };
      const services = json.services ?? [];

      for (const svc of services) {
        if (!svc.id || !svc.url) continue;
        // Prevent seq replay
        const existing = await this.store.getDiscoveredService(svc.id);
        if (existing && existing.seq >= svc.seq) continue;
        await this.store.upsertDiscoveredService({
          ...svc,
          receivedAt: Date.now(),
          isLocal: false,
        });
      }

      log.debug(
        'service-sync: pulled %d services from %s',
        services.length,
        peerId,
      );
    } catch {
      // ignore transient fetch/network errors
    }
  }

  private async notifyPeer(peerId: string): Promise<void> {
    const endpoint = this.knownEndpoints.get(peerId);
    if (!endpoint) return;
    const selfEndpoint = this.getSelfHttpEndpoint();
    if (!selfEndpoint) return; // Yggdrasil IPv6 not yet known

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        await fetch(`${endpoint}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            peerId: this.node?.peerId?.toString?.() ?? '',
            endpoint: selfEndpoint,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // ignore
    }
  }

  private async broadcastNotify(): Promise<void> {
    const peers = [...this.knownEndpoints.keys()];
    await Promise.all(peers.map((p) => this.notifyPeer(p)));
  }

  private async pullFromAllKnownPeers(): Promise<void> {
    this.refreshConnectedPeerEndpoints();
    const peers = [...this.knownEndpoints.keys()];
    for (const p of peers) {
      // eslint-disable-next-line no-await-in-loop
      await this.pullFromPeer(p);
    }
    await this.cleanupExpiredServices();
  }

  // ---- DHT ----

  /** Write our port to DHT so unknown peers can look it up */
  private async publishSelfToDht(): Promise<void> {
    const node = this.node;
    if (!node || !this.httpListenPort) return;
    const dht = (node as any).services?.dht ?? (node as any).dht;
    if (!dht?.put) return;

    const peerId = node.peerId?.toString?.() ?? '';
    if (!peerId) return;

    const key = Buffer.from(`wtb:svc-endpoint:${peerId}`);
    const value = Buffer.from(
      JSON.stringify({
        port: this.httpListenPort,
        ts: Date.now(),
        ttl: DHT_ENDPOINT_TTL_SEC,
      }),
    );

    try {
      await dht.put(key, value);
      log.debug(
        'service-sync: published endpoint to DHT (port %d)',
        this.httpListenPort,
      );
    } catch {
      // best-effort; ignore DHT errors
    }
  }

  /**
   * Discover new peers via DHT rendezvous key and dial them.
   * Successful dials trigger peer:connect -> refreshConnectedPeerEndpoints -> pull.
   */
  private async discoverPeersViaDhtBestEffort(reason: string): Promise<void> {
    const node = this.node;
    if (!node) return;

    const now = Date.now();
    if (now - this.lastDiscoverAttemptAt < DISCOVER_THROTTLE_MS) return;
    this.lastDiscoverAttemptAt = now;

    const peerRouting = (node as any)?.peerRouting;
    const getClosestPeers = peerRouting?.getClosestPeers;
    if (!(getClosestPeers instanceof Function)) return;

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), DISCOVER_TIMEOUT_MS);
    const found: any[] = [];

    try {
      for await (const p of getClosestPeers.call(
        peerRouting,
        ANNOUNCEMENT_RENDEZVOUS_KEY,
        { signal: ac.signal },
      )) {
        if (!p) continue;
        const idStr = p?.id?.toString?.() ?? '';
        if (!idStr || idStr === node.peerId?.toString?.()) continue;
        found.push(p);
        if (found.length >= DISCOVER_LIMIT) break;
      }
    } catch {
      // ignore
    } finally {
      clearTimeout(timeout);
    }

    if (found.length === 0) return;

    const connected = new Set<string>();
    try {
      for (const p of node.getPeers?.() ?? []) connected.add(p.toString());
    } catch {
      // ignore
    }

    let dialed = 0;
    for (const p of found) {
      try {
        const pid = p?.id;
        const pidStr = pid?.toString?.() ?? '';
        if (!pidStr || connected.has(pidStr)) continue;
        const dialAc = new AbortController();
        const dialTimer = setTimeout(() => dialAc.abort(), DIAL_TIMEOUT_MS);
        try {
          // eslint-disable-next-line no-await-in-loop
          await (node as any).dial?.(pid, { signal: dialAc.signal });
          dialed += 1;
        } finally {
          clearTimeout(dialTimer);
        }
      } catch {
        // ignore dial errors
      }
    }

    if (dialed > 0) {
      log.info(
        'service-sync: dht discover dialed %d peer(s) (%s)',
        dialed,
        reason,
      );
    }
  }

  private async republishRoutine(): Promise<void> {
    await this.discoverPeersViaDhtBestEffort('republish timer');
    await this.publishSelfToDht();
    this.refreshConnectedPeerEndpoints();
    await this.pullFromAllKnownPeers();
  }
}
