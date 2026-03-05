
// --- ndjson 存储实现 ---
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
        // ignore
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
    return Array.from(this.cache.values()).filter(r => !r._deleted) as T[];
  }

  async count(): Promise<number> {
    this.ensureLoaded();
    return Array.from(this.cache.values()).filter(r => !r._deleted).length;
  }
}

const getLocalServicesNdjsonPath = () => path.join(getPublicServiceDir(), 'local_services.ndjson');
const getDiscoveredServicesNdjsonPath = () => path.join(getPublicServiceDir(), 'discovered_services.ndjson');

class PublicServiceNdjsonStore {
  private localStore = new NdjsonStore<LocalServiceConfig>(getLocalServicesNdjsonPath());
  private discoveredStore = new NdjsonStore<ServiceAnnouncementStatus>(getDiscoveredServicesNdjsonPath());

  async flush(): Promise<void> {
    // ndjson为追加写入，无需flush
  }

  async getCounts(): Promise<{ local: number; discovered: number }> {
    return {
      local: await this.localStore.count(),
      discovered: await this.discoveredStore.count(),
    };
  }

  async getLocalService(id: string): Promise<LocalServiceConfig | null> {
    return await this.localStore.get(id);
  }

  async hasLocalService(id: string): Promise<boolean> {
    return await this.localStore.has(id);
  }

  async upsertLocalService(cfg: LocalServiceConfig): Promise<void> {
    await this.localStore.upsert(cfg);
  }

  async deleteLocalService(id: string): Promise<void> {
    await this.localStore.delete(id);
  }

  async listLocalServices(): Promise<LocalServiceConfig[]> {
    return await this.localStore.list();
  }

  async getDiscoveredService(id: string): Promise<ServiceAnnouncementStatus | null> {
    return await this.discoveredStore.get(id);
  }

  async upsertDiscoveredService(svc: ServiceAnnouncementStatus): Promise<void> {
    await this.discoveredStore.upsert(svc);
  }

  async deleteDiscoveredService(id: string): Promise<void> {
    await this.discoveredStore.delete(id);
  }

  async listDiscoveredServicesRaw(): Promise<ServiceAnnouncementStatus[]> {
    return await this.discoveredStore.list();
  }
}
/**
 * 服务公告发布与发现系统
 *
 * 功能：
 * - 发布本地服务公告到 libp2p gossipsub
 * - 接收并验证远程服务公告
 * - 使用 ed25519 签名（复用 libp2p chat 的密钥）
 * - 持久化到本地数据库
 * - 周期性重发（对抗网络 churn）
 * - 支持撤回
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import log from 'electron-log';

import { getWtbDataDir } from './wtb_config';

const u8FromString = (input: string): Uint8Array => {
  return Buffer.from(input, 'utf8');
};

const u8ToString = (input: Uint8Array): string => {
  return Buffer.from(input).toString('utf8');
};

import type {
  ServiceAnnouncementPayload,
  SignedServiceAnnouncement,
  ServiceAnnouncementStatus,
  LocalServiceConfig,
  AnnouncementSystemStatus,
} from '../types/announcements';

// libp2p 类型（避免 ESM/CJS 导入问题）
type Libp2pNode = any;

// 服务公告专用 topic（版本化）
const ANNOUNCEMENT_TOPIC = 'ygg-service-announcements-v1';

// 重发间隔（10 分钟）
const REPUBLISH_INTERVAL_MS = 3 * 60 * 1000;

// 用于在小网络里通过 DHT 主动“碰见”其他客户端（不依赖 bootstrap 节点转发 pubsub）
const ANNOUNCEMENT_RENDEZVOUS_KEY = crypto
  .createHash('sha256')
  .update('wtb:announcements:rendezvous:v1')
  .digest();

const DISCOVER_THROTTLE_MS = 10_000;
const DISCOVER_TIMEOUT_MS = 2_000;
const DISCOVER_LIMIT = 16;
const DIAL_TIMEOUT_MS = 1_500;

// 限制描述长度，避免公告消息过大（也与 UI 侧保持一致）
const MAX_SERVICE_DESC_LENGTH = 200;

// sql.js 类型（避免 ESM/CJS + typings 问题）


const sha256Hex = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex');
};

// NOTE: getWtbDataDir moved to wtb_config.ts

const getLegacyAnnouncementsDir = (): string =>
  path.join(getWtbDataDir(), 'announcements');

const getLegacyStoreFilePath = (): string =>
  path.join(getLegacyAnnouncementsDir(), 'store.json');

const getPublicServiceDir = (): string =>
  path.join(getWtbDataDir(), 'publicservice');

const getPublicServiceDbPath = (): string =>
  path.join(getPublicServiceDir(), 'publicservice.sqlite');

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const readJsonFile = <T>(filePath: string): T | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const writeJsonFile = (filePath: string, value: unknown): void => {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
  });
  fs.renameSync(tmp, filePath);
};

const atomicWriteBinaryFile = (filePath: string, data: Uint8Array): void => {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, filePath);
};







/**
 * 生成服务 ID（基于公钥和 URL）
 */
const generateServiceId = (pubkey: string, url: string): string => {
  return sha256Hex(pubkey + url).slice(0, 16);
};

export class ServiceAnnouncementsManager {
  private node: Libp2pNode | null = null;

  private store = new PublicServiceNdjsonStore();

  private subscribed = false;

  private republishTimer: NodeJS.Timeout | null = null;

  private peerConnectListener: ((evt: any) => void) | null = null;
  private pubsubMessageListener: ((evt: any) => void) | null = null;

  private lastResubscribeAt = 0;
  private lastPeerConnectRepublishAt = 0;

  private lastDiscoverAttemptAt = 0;

  // 从 libp2p chat 获取的身份密钥
  private signPrivateKeyDerB64: string | null = null;

  private signPublicKeyDerB64: string | null = null;

  constructor() {
    // 预初始化ndjson存储（无阻塞）
    this.store.flush().catch(() => {
      // ignore
    });
  }

  private isNoPeersSubscribedToTopicError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('PublishError.NoPeersSubscribedToTopic');
  }

  private async discoverPeersViaDhtBestEffort(reason: string): Promise<void> {
    const node = this.node;
    if (!node) return;

    const now = Date.now();
    if (now - this.lastDiscoverAttemptAt < DISCOVER_THROTTLE_MS) return;
    this.lastDiscoverAttemptAt = now;

    const peerRouting = (node as any)?.peerRouting;
    const getClosestPeers = peerRouting?.getClosestPeers;
    if (!(getClosestPeers instanceof Function)) return;

    // Best-effort: query a stable key so different clients converge.
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), DISCOVER_TIMEOUT_MS);
    const found: any[] = [];
    try {
      for await (const p of getClosestPeers.call(peerRouting, ANNOUNCEMENT_RENDEZVOUS_KEY, {
        signal: ac.signal,
      })) {
        if (!p) continue;
        const idStr = p?.id?.toString?.() ?? '';
        if (!idStr) continue;
        if (idStr === node.peerId?.toString?.()) continue;
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
      const peers = node.getPeers?.() ?? [];
      for (const p of peers) connected.add(p.toString());
    } catch {
      // ignore
    }

    let dialed = 0;
    for (const p of found) {
      try {
        const pid = p?.id;
        const pidStr = pid?.toString?.() ?? '';
        if (!pidStr) continue;
        if (connected.has(pidStr)) continue;
        const dialAc = new AbortController();
        const dialTimeout = setTimeout(() => dialAc.abort(), DIAL_TIMEOUT_MS);
        try {
          await (node as any).dial?.(pid, { signal: dialAc.signal });
        } finally {
          clearTimeout(dialTimeout);
        }
        dialed += 1;
      } catch {
        // ignore dial errors
      }
    }

    if (dialed > 0) {
      log.info('announcements: dht discover dialed %d peer(s) (%s)', dialed, reason);
    }
  }

  /**
   * 设置身份密钥（从 libp2p chat 模块获取）
   */
  setIdentityKeys(signPrivateDerB64: string, signPublicDerB64: string): void {
    this.signPrivateKeyDerB64 = signPrivateDerB64;
    this.signPublicKeyDerB64 = signPublicDerB64;
  }

  /**
   * 启动服务公告系统（需要 libp2p 实例）
   */
  async start(libp2pNode: Libp2pNode): Promise<void> {
    if (this.node) {
      log.warn('ServiceAnnouncementsManager already started');
      return;
    }

    this.node = libp2pNode;

    // 订阅公告 topic
    try {
      this.node.services.pubsub.subscribe(ANNOUNCEMENT_TOPIC);
      this.subscribed = true;
      log.info(`Subscribed to ${ANNOUNCEMENT_TOPIC}`);
    } catch (err) {
      log.error('Failed to subscribe to announcement topic', err);
    }

    // 监听消息
    this.pubsubMessageListener = this.handleMessage.bind(this);
    this.node.services.pubsub.addEventListener('message', this.pubsubMessageListener);

    // IMPORTANT: In small networks, peers may connect *after* we subscribed.
    // Some pubsub implementations won't automatically re-send existing subscriptions
    // to newly connected peers, which makes publish() think subs=0 forever.
    // On each peer connection, toggle subscription to force a SUBSCRIBE update.
    this.peerConnectListener = (evt: any) => {
      try {
        const peerId = evt?.detail?.toString?.() ?? String(evt?.detail ?? '');
        log.info('announcements: peer connected %s; re-sync subscriptions', peerId);
      } catch {
        // ignore
      }
      void this.resubscribeAnnouncementTopicBestEffort('peer:connect');
      void this.republishAfterPeerConnectBestEffort();
    };
    this.node.addEventListener('peer:connect', this.peerConnectListener);

    // 启动周期性重发
    this.startRepublishTimer();

    log.info('ServiceAnnouncementsManager started');
  }

  /**
   * 停止服务公告系统
   */
  async stop(): Promise<void> {
    if (!this.node) return;

    this.stopRepublishTimer();

    try {
      if (this.subscribed) {
        this.node.services.pubsub.unsubscribe(ANNOUNCEMENT_TOPIC);
        this.subscribed = false;
      }
    } catch (err) {
      log.warn('Failed to unsubscribe from announcement topic', err);
    }

    try {
      if (this.pubsubMessageListener) {
        this.node.services.pubsub.removeEventListener('message', this.pubsubMessageListener);
      }
    } catch {
      // ignore
    } finally {
      this.pubsubMessageListener = null;
    }

    try {
      if (this.peerConnectListener) {
        this.node.removeEventListener('peer:connect', this.peerConnectListener);
      }
    } catch {
      // ignore
    } finally {
      this.peerConnectListener = null;
    }

    this.node = null;
    await this.store.flush();
    log.info('ServiceAnnouncementsManager stopped');
  }

  private async resubscribeAnnouncementTopicBestEffort(reason: string): Promise<void> {
    const node = this.node;
    if (!node) return;
    if (!this.subscribed) return;

    const now = Date.now();
    // Throttle resubscribe bursts (e.g. multiple peer:connect events)
    if (now - this.lastResubscribeAt < 3000) return;
    this.lastResubscribeAt = now;

    try {
      // Toggle to force a subscription update to peers.
      node.services.pubsub.unsubscribe(ANNOUNCEMENT_TOPIC);
    } catch {
      // ignore
    }

    try {
      node.services.pubsub.subscribe(ANNOUNCEMENT_TOPIC);
      log.debug('announcements: re-subscribed to %s (%s)', ANNOUNCEMENT_TOPIC, reason);
    } catch (err) {
      log.debug('announcements: re-subscribe failed (%s)', reason, err);
    }
  }

  private async republishAfterPeerConnectBestEffort(): Promise<void> {
    const now = Date.now();
    // Avoid spamming republish if connections flap
    if (now - this.lastPeerConnectRepublishAt < 5000) return;
    this.lastPeerConnectRepublishAt = now;

    // Give pubsub a brief moment to exchange subscriptions
    setTimeout(() => {
      this.republishAllServices().catch(() => {
        // ignore
      });
    }, 800);
  }

  /**
   * 获取系统状态
   */
  async getStatus(): Promise<AnnouncementSystemStatus> {
    const counts = await this.store.getCounts();

    const snap = this.getPeerSnapshotBestEffort();
    return {
      running: this.node != null,
      peerId: this.node?.peerId?.toString(),
      listenAddrs: snap.listenAddrs,
      peers: snap.peers,
      peerConnections: snap.peerConnections,
      subscribedTopic: this.subscribed ? ANNOUNCEMENT_TOPIC : undefined,
      localServicesCount: counts.local,
      discoveredServicesCount: counts.discovered,
    };
  }

  /**
   * 立即重发一次所有本地服务公告（用于手动“强制重试”）
   */
  async republishNow(): Promise<void> {
    if (!this.node) {
      throw new Error('公告系统未运行');
    }
    await this.discoverPeersViaDhtBestEffort('manual republish');
    await this.republishAllServices();
  }

  private getPeerSnapshotBestEffort(): {
    listenAddrs?: string[];
    peers?: string[];
    peerConnections?: Array<{ peerId: string; addrs: string[] }>;
  } {
    const node = this.node;
    if (!node) return {};

    const out: {
      listenAddrs?: string[];
      peers?: string[];
      peerConnections?: Array<{ peerId: string; addrs: string[] }>;
    } = {};

    try {
      out.listenAddrs = node.getMultiaddrs?.().map((ma: any) => ma.toString());
    } catch {
      // ignore
    }

    try {
      out.peers = node.getPeers?.().map((p: any) => p.toString());
    } catch {
      // ignore
    }

    try {
      const conns = (node as any).getConnections?.() ?? [];
      const peerConnMap = new Map<string, Set<string>>();
      for (const conn of conns) {
        try {
          const peerId =
            conn.remotePeer?.toString?.() ?? String(conn.remotePeer ?? '');
          const addrStr = conn.remoteAddr?.toString?.() ?? '';
          if (!peerId) continue;
          if (!peerConnMap.has(peerId)) peerConnMap.set(peerId, new Set());
          if (addrStr) peerConnMap.get(peerId)!.add(addrStr);
        } catch {
          // ignore per-connection errors
        }
      }

      out.peerConnections = Array.from(peerConnMap.entries()).map(
        ([peerId, addrSet]) => ({
          peerId,
          addrs: Array.from(addrSet),
        }),
      );
    } catch {
      // ignore
    }

    return out;
  }

  private getPubsubSnapshotBestEffort(): {
    topics?: string[];
    pubsubPeers?: string[];
    announcementSubscribers?: string[];
  } {
    const node = this.node;
    if (!node) return {};

    const out: {
      topics?: string[];
      pubsubPeers?: string[];
      announcementSubscribers?: string[];
    } = {};

    try {
      out.topics = node.services?.pubsub?.getTopics?.() ?? undefined;
    } catch {
      // ignore
    }

    try {
      const peers = node.services?.pubsub?.getPeers?.() ?? undefined;
      out.pubsubPeers = peers ? peers.map((p: any) => p.toString()) : undefined;
    } catch {
      // ignore
    }

    try {
      const subs = node.services?.pubsub?.getSubscribers?.(ANNOUNCEMENT_TOPIC) ?? undefined;
      out.announcementSubscribers = subs ? subs.map((p: any) => p.toString()) : undefined;
    } catch {
      // ignore
    }

    return out;
  }

  /**
   * 添加或更新本地服务
   */
  async addLocalService(url: string, desc: string): Promise<LocalServiceConfig> {
    if (!this.signPublicKeyDerB64) {
      throw new Error('身份密钥未设置');
    }

    const trimmedUrl = (url ?? '').trim();
    const trimmedDesc = (desc ?? '').trim();

    if (!trimmedUrl) throw new Error('服务 URL 不能为空');
    if (!trimmedDesc) throw new Error('服务描述不能为空');
    if (trimmedDesc.length > MAX_SERVICE_DESC_LENGTH) {
      throw new Error(`服务描述过长（最多 ${MAX_SERVICE_DESC_LENGTH} 字符）`);
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
      lastPublishedAt: existing?.lastPublishedAt,
    };

    await this.store.upsertLocalService(config);

    // 立即发布
    if (this.node) {
      this.publishService(id).catch((err) =>
        log.error('Failed to publish service immediately', err),
      );
    }

    return config;
  }

  /**
   * 删除本地服务（发送撤回消息）
   */
  async removeLocalService(id: string): Promise<void> {
    const config = await this.store.getLocalService(id);
    if (!config) {
      throw new Error('服务不存在');
    }

    // 发布撤回消息
    if (this.node) {
      await this.publishRevocation(id);
    }

    await this.store.deleteLocalService(id);
  }

  /**
   * 获取本地服务列表
   */
  async listLocalServices(): Promise<LocalServiceConfig[]> {
    return await this.store.listLocalServices();
  }

  /**
   * 获取发现的远程服务列表（过滤过期和撤回的）
   */
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

  /**
   * 清理过期的服务记录
   */
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

  /**
   * 发布服务公告
   */
  private async publishService(id: string): Promise<void> {
    if (!this.node || !this.signPrivateKeyDerB64 || !this.signPublicKeyDerB64) {
      return;
    }

    const config = await this.store.getLocalService(id);
    if (!config || !config.enabled) return;

    const peerId = this.node.peerId.toString();

    const payload: ServiceAnnouncementPayload = {
      id: config.id,
      peerId,
      pubkey: this.signPublicKeyDerB64,
      url: config.url,
      desc: config.desc,
      seq: config.seq,
      ts: new Date().toISOString(),
      ttl: 86400, // 1 天
      revoked: false,
    };

    const signed = this.signAnnouncement(payload);
    const wireData = JSON.stringify(signed);

    try {
      await this.node.services.pubsub.publish(
        ANNOUNCEMENT_TOPIC,
        u8FromString(wireData),
      );

      config.lastPublishedAt = Date.now();
      await this.store.upsertLocalService(config);

      log.info(`Published service announcement: ${id}`);
    } catch (err) {
      if (this.isNoPeersSubscribedToTopicError(err)) {
        // Expected in small / bootstrap networks: no subscribers yet.
        // We'll retry on the republish timer; don't surface as an error.
        const ps = this.getPubsubSnapshotBestEffort();
        const subs = ps.announcementSubscribers?.length ?? 0;
        const pubsubPeers = ps.pubsubPeers?.length ?? 0;
        const topics = ps.topics?.length ?? 0;
        log.info(
          `Skipped publish service ${id}: no peers subscribed (subs=${subs} pubsubPeers=${pubsubPeers} topics=${topics})`,
        );
        if (pubsubPeers > 0 || subs > 0) {
          log.debug('announcements: pubsub snapshot (sample)', {
            pubsubPeers: (ps.pubsubPeers ?? []).slice(0, 8),
            subscribers: (ps.announcementSubscribers ?? []).slice(0, 8),
            topics: (ps.topics ?? []).slice(0, 16),
          });
        }

        // Try to actively discover and dial other clients via DHT, then retry once.
        await this.discoverPeersViaDhtBestEffort('publish skipped: no subscribers');
        try {
          await this.node.services.pubsub.publish(
            ANNOUNCEMENT_TOPIC,
            u8FromString(wireData),
          );
          config.lastPublishedAt = Date.now();
          await this.store.upsertLocalService(config);
          log.info(`Published service announcement after discover: ${id}`);
        } catch {
          // still no subscribers or transient publish failure - keep silent like before
        }
        return;
      }

      log.error(`Failed to publish service ${id}`, err);
    }
  }

  /**
   * 发布撤回消息
   */
  private async publishRevocation(id: string): Promise<void> {
    if (!this.node || !this.signPrivateKeyDerB64 || !this.signPublicKeyDerB64) {
      return;
    }

    const config = await this.store.getLocalService(id);
    if (!config) return;

    const peerId = this.node.peerId.toString();

    const payload: ServiceAnnouncementPayload = {
      id: config.id,
      peerId,
      pubkey: this.signPublicKeyDerB64,
      url: config.url,
      desc: config.desc,
      seq: config.seq + 1,
      ts: new Date().toISOString(),
      ttl: 0,
      revoked: true,
    };

    const signed = this.signAnnouncement(payload);
    const wireData = JSON.stringify(signed);

    try {
      await this.node.services.pubsub.publish(
        ANNOUNCEMENT_TOPIC,
        u8FromString(wireData),
      );
      log.info(`Published revocation for service: ${id}`);
    } catch (err) {
      if (this.isNoPeersSubscribedToTopicError(err)) {
        const ps = this.getPubsubSnapshotBestEffort();
        const subs = ps.announcementSubscribers?.length ?? 0;
        const pubsubPeers = ps.pubsubPeers?.length ?? 0;
        const topics = ps.topics?.length ?? 0;
        log.info(
          `Skipped publish revocation for ${id}: no peers subscribed (subs=${subs} pubsubPeers=${pubsubPeers} topics=${topics})`,
        );
        if (pubsubPeers > 0 || subs > 0) {
          log.debug('announcements: pubsub snapshot (sample)', {
            pubsubPeers: (ps.pubsubPeers ?? []).slice(0, 8),
            subscribers: (ps.announcementSubscribers ?? []).slice(0, 8),
            topics: (ps.topics ?? []).slice(0, 16),
          });
        }
        return;
      }

      log.error(`Failed to publish revocation for ${id}`, err);
    }
  }

  /**
   * 签名公告
   */
  private signAnnouncement(
    payload: ServiceAnnouncementPayload,
  ): SignedServiceAnnouncement {
    if (!this.signPrivateKeyDerB64) {
      throw new Error('签名私钥未设置');
    }

    // 对 payload 做确定性序列化（按字段顺序）
    const canonicalPayload = JSON.stringify([
      payload.id,
      payload.peerId,
      payload.pubkey,
      payload.url,
      payload.desc,
      payload.seq,
      payload.ts,
      payload.ttl,
      payload.revoked ?? false,
    ]);

    const key = crypto.createPrivateKey({
      key: Buffer.from(this.signPrivateKeyDerB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    const payloadBytes = Buffer.from(canonicalPayload, 'utf8');
    const signature = crypto.sign(null, payloadBytes, key);

    return {
      ...payload,
      signature: signature.toString('base64'),
    };
  }

  /**
   * 验证签名
   */
  private verifyAnnouncement(signed: SignedServiceAnnouncement): boolean {
    try {
      const { signature, ...payload } = signed;

      const canonicalPayload = JSON.stringify([
        payload.id,
        payload.peerId,
        payload.pubkey,
        payload.url,
        payload.desc,
        payload.seq,
        payload.ts,
        payload.ttl,
        payload.revoked ?? false,
      ]);

      const pub = crypto.createPublicKey({
        key: Buffer.from(payload.pubkey, 'base64'),
        format: 'der',
        type: 'spki',
      });

      const payloadBytes = Buffer.from(canonicalPayload, 'utf8');
      const sigBytes = Buffer.from(signature, 'base64');

      return crypto.verify(null, payloadBytes, pub, sigBytes);
    } catch (err) {
      log.warn('Signature verification failed', err);
      return false;
    }
  }

  /**
   * 处理接收到的消息
   */
  private handleMessage(evt: any): void {
    void this.handleMessageAsync(evt);
  }

  private async handleMessageAsync(evt: any): Promise<void> {
    try {
      const topic = evt.detail?.topic;
      if (topic !== ANNOUNCEMENT_TOPIC) return;

      const data = evt.detail?.data;
      if (!data) return;

      const wireData = u8ToString(data);
      const signed: SignedServiceAnnouncement = JSON.parse(wireData);

      // 验证签名
      if (!this.verifyAnnouncement(signed)) {
        log.warn('Invalid signature, ignoring announcement', signed.id);
        return;
      }

      // 检查是否是本地服务（跳过）
      const isLocal = await this.store.hasLocalService(signed.id);
      if (isLocal) return;

      // 检查 seq（防止回放攻击）
      const existing = await this.store.getDiscoveredService(signed.id);
      if (existing && existing.seq >= signed.seq) {
        log.debug('Ignoring old announcement', {
          id: signed.id,
          existingSeq: existing.seq,
          newSeq: signed.seq,
        });
        return;
      }

      // 存储服务
      const status: ServiceAnnouncementStatus = {
        id: signed.id,
        peerId: signed.peerId,
        url: signed.url,
        desc: signed.desc,
        seq: signed.seq,
        ts: signed.ts,
        ttl: signed.ttl,
        revoked: signed.revoked ?? false,
        receivedAt: Date.now(),
        isLocal: false,
      };

      await this.store.upsertDiscoveredService(status);

      log.info('Received service announcement', {
        id: signed.id,
        url: signed.url,
        revoked: signed.revoked,
      });
    } catch (err) {
      log.error('Failed to handle announcement message', err);
    }
  }

  /**
   * 启动周期性重发定时器
   */
  private startRepublishTimer(): void {
    if (this.republishTimer) return;

    this.republishTimer = setInterval(() => {
      this.republishAllServices().catch((err) =>
        log.error('Republish timer failed', err),
      );
    }, REPUBLISH_INTERVAL_MS);

    // 立即发布一次
    this.republishAllServices().catch((err) =>
      log.error('Initial republish failed', err),
    );
  }

  /**
   * 停止重发定时器
   */
  private stopRepublishTimer(): void {
    if (this.republishTimer) {
      clearInterval(this.republishTimer);
      this.republishTimer = null;
    }
  }

  /**
   * 重发所有本地服务
   */
  private async republishAllServices(): Promise<void> {
    await this.discoverPeersViaDhtBestEffort('republish');
    const locals = await this.store.listLocalServices();
    for (const svc of locals) {
      const id = svc.id;
      await this.publishService(id);
    }
    // 清理过期服务
    await this.cleanupExpiredServices();
  }
}
