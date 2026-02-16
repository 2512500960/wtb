import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import net from 'net';
import log from 'electron-log';
import { app } from 'electron';
import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { multiaddr } from '@multiformats/multiaddr';
import { webSockets } from '@libp2p/websockets'
import {
  fromString as u8FromString,
  toString as u8ToString,
} from 'uint8arrays';
import { getYggdrasilIPv6AddressOrThrow } from './main';

type MsgStoreMaster = {
  schemaVersion: 1;
  client: {
    displayName: string;
    // DER-encoded keys in base64
    signPrivateKeyDerB64: string;
    signPublicKeyDerB64: string;
    encPrivateKeyDerB64: string;
    encPublicKeyDerB64: string;
  };
  contacts: Record<
    string,
    {
      peerId: string;
      displayName?: string;
      signPublicKeyDerB64?: string;
      encPublicKeyDerB64?: string;
      addedAt: number;
      lastSeenAt?: number;
    }
  >;
  conversations: Record<
    string,
    {
      convId: string;
      type: 'group' | 'dm';
      title: string;
      topic: string;
      storageId: string;
      createdAt: number;
      lastMessageAt?: number;
      lastMessagePreview?: string;
      unreadCount?: number;
      // dm only
      peerId?: string;
      peerEncPublicKeyDerB64?: string;
      peerSignPublicKeyDerB64?: string;
    }
  >;
};

export type ChatStatus = {
  running: boolean;
  peerId?: string;
  listenAddrs: string[];
  peers: string[];
  topics: string[];
  displayName?: string;
  identity?: {
    signPublicKeyDerB64: string;
    encPublicKeyDerB64: string;
  };
};

export type ChatConversation = {
  convId: string;
  type: 'group' | 'dm';
  title: string;
  topic: string;
  createdAt: number;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  unreadCount?: number;
  peerId?: string;
};

export type ChatMessage = {
  convId: string;
  type: 'group' | 'dm';
  topic: string;
  fromPeerId: string;
  fromDisplayName?: string;
  direction: 'in' | 'out';
  text: string;
  ts: number;
  receivedAt: number;
};

type WireEnvelopeV1 = {
  v: 1;
  kind: 'group' | 'dm';
  convId: string;
  topic: string;
  fromPeerId: string;
  fromDisplayName?: string;
  ts: number;
  nonceB64: string;
  // group
  text?: string;
  // dm
  toPeerId?: string;
  ivB64?: string;
  ctB64?: string;
  tagB64?: string;
  fromEncPublicKeyDerB64?: string;
  // signature (ed25519)
  fromSignPublicKeyDerB64: string;
  sigB64: string;
};

const sha256Hex = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex');
};

const randomB64 = (bytes: number): string =>
  crypto.randomBytes(bytes).toString('base64');

const safePreview = (text: string, maxLen: number = 60): string => {
  const cleaned = (text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '…';
};

const canWriteDir = (dirPath: string): boolean => {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const isUnderDir = (childPath: string, parentPath: string): boolean => {
  const child = path.resolve(childPath).toLowerCase();
  const parent = path.resolve(parentPath).toLowerCase();
  return child === parent || child.startsWith(parent + path.sep);
};

const getWtbDataDir = (): string => {
  const override = process.env.WTB_DATA_DIR;
  if (override && override.trim()) return override;

  if (app.isPackaged) {
    const exeDir = path.dirname(app.getPath('exe'));
    const portableBase =
      (process.env.PORTABLE_EXECUTABLE_DIR || '').trim() || exeDir;
    const portableDataDir = path.join(portableBase, 'wtb-data');

    if ((process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) {
      return portableDataDir;
    }

    try {
      if (fs.existsSync(portableDataDir)) {
        return portableDataDir;
      }
    } catch {
      // ignore
    }

    const programFiles = (process.env.ProgramFiles || '').trim();
    const programFilesX86 = (process.env['ProgramFiles(x86)'] || '').trim();
    const looksInstalled =
      (programFiles && isUnderDir(exeDir, programFiles)) ||
      (programFilesX86 && isUnderDir(exeDir, programFilesX86));

    if (!looksInstalled && canWriteDir(exeDir)) {
      return portableDataDir;
    }

    try {
      const roaming = app.getPath('appData');
      if (roaming && roaming.trim()) {
        return path.join(roaming, 'wtb');
      }
    } catch {
      // ignore
    }

    return portableDataDir;
  }

  return path.join(__dirname, '../../', 'wtb-data');
};

const getMsgStoreDir = (): string => path.join(getWtbDataDir(), 'msgstore');

const getP2pPort = (): number => {
  const raw = (process.env.WTB_P2P_PORT || '').trim();
  if (!raw) return 10848;
  const parsed = Number.parseInt(raw, 10);
  // Allow 0 = "auto" (pick an ephemeral free port at startup)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid WTB_P2P_PORT: ${raw}`);
  }
  return parsed;
};

const isAddrInUseError = (err: unknown): boolean => {
  const anyErr = err as any;
  const code = typeof anyErr?.code === 'string' ? anyErr.code : '';
  if (code === 'EADDRINUSE') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.toLowerCase().includes('eaddrinuse') ||
    msg.toLowerCase().includes('address already in use');
};

const pickFreeTcpPortOnHost = (host: string): Promise<number> => {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (e) => {
      try {
        server.close();
      } catch {
        // ignore
      }
      reject(e);
    });

    // Port 0 asks OS to allocate a free ephemeral port.
    server.listen({ host, port: 0 }, () => {
      const addr = server.address();
      const port =
        typeof addr === 'object' && addr != null ? (addr as net.AddressInfo).port : 0;
      server.close(() => resolve(port));
    });
  });
};

const getBootstrapMultiaddrs = (): string[] => {
  const raw =
    (process.env.WTB_P2P_BOOTSTRAP_MULTIADDRS || '').trim() ||
    (process.env.WTB_P2P_BOOTSTRAP || '').trim();
  if (!raw) return [];

  // Allow comma / whitespace / newline separated list
  const parts = raw
    .split(/[\s,]+/g)
    .map((x) => x.trim())
    .filter(Boolean);

  // De-dup
  return Array.from(new Set(parts));
};

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
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
  });
  fs.renameSync(tmp, filePath);
};

const getMasterPath = (): string => path.join(getMsgStoreDir(), 'master.json');

const getConversationFilePath = (storageId: string): string => {
  return path.join(getMsgStoreDir(), `conv_${storageId}.ndjson`);
};

const encodeWireSignPayload = (env: Omit<WireEnvelopeV1, 'sigB64'>): Buffer => {
  // Stable payload as an array - ordering is explicit.
  const fields = [
    env.v,
    env.kind,
    env.convId,
    env.topic,
    env.fromPeerId,
    env.fromDisplayName ?? '',
    env.ts,
    env.nonceB64,
    env.text ?? '',
    env.toPeerId ?? '',
    env.ivB64 ?? '',
    env.ctB64 ?? '',
    env.tagB64 ?? '',
    env.fromEncPublicKeyDerB64 ?? '',
    env.fromSignPublicKeyDerB64,
  ];
  return Buffer.from(JSON.stringify(fields), 'utf8');
};

const aesGcmEncrypt = (
  key: Buffer,
  plaintext: string,
): { ivB64: string; ctB64: string; tagB64: string } => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ivB64: iv.toString('base64'),
    ctB64: ct.toString('base64'),
    tagB64: tag.toString('base64'),
  };
};

const aesGcmDecrypt = (
  key: Buffer,
  ivB64: string,
  ctB64: string,
  tagB64: string,
): string => {
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
};

const importEd25519Private = (derB64: string) =>
  crypto.createPrivateKey({
    key: Buffer.from(derB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
const importEd25519Public = (derB64: string) =>
  crypto.createPublicKey({
    key: Buffer.from(derB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
const importX25519Private = (derB64: string) =>
  crypto.createPrivateKey({
    key: Buffer.from(derB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
const importX25519Public = (derB64: string) =>
  crypto.createPublicKey({
    key: Buffer.from(derB64, 'base64'),
    format: 'der',
    type: 'spki',
  });

const ensureMaster = (): MsgStoreMaster => {
  ensureDir(getMsgStoreDir());
  const existing = readJsonFile<MsgStoreMaster>(getMasterPath());
  if (existing && existing.schemaVersion === 1) {
    return existing;
  }

  const signKp = crypto.generateKeyPairSync('ed25519');
  const encKp = crypto.generateKeyPairSync('x25519');

  const master: MsgStoreMaster = {
    schemaVersion: 1,
    client: {
      displayName: '我',
      signPrivateKeyDerB64: signKp.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      signPublicKeyDerB64: signKp.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
      encPrivateKeyDerB64: encKp.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      encPublicKeyDerB64: encKp.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    },
    contacts: {},
    conversations: {},
  };

  writeJsonFile(getMasterPath(), master);
  return master;
};

const saveMaster = (master: MsgStoreMaster): void => {
  writeJsonFile(getMasterPath(), master);
};

const appendConversationMessage = (
  storageId: string,
  msg: ChatMessage,
): void => {
  ensureDir(getMsgStoreDir());
  const fp = getConversationFilePath(storageId);
  fs.appendFileSync(fp, JSON.stringify(msg) + '\n', { encoding: 'utf8' });
};

const loadConversationMessages = (
  storageId: string,
  limit: number,
): ChatMessage[] => {
  try {
    const fp = getConversationFilePath(storageId);
    if (!fs.existsSync(fp)) return [];
    const raw = fs.readFileSync(fp, { encoding: 'utf8' });
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    return slice
      .map((l) => {
        try {
          return JSON.parse(l) as ChatMessage;
        } catch {
          return null;
        }
      })
      .filter((m): m is ChatMessage => m != null);
  } catch {
    return [];
  }
};

export class Libp2pGroupChatService {
  private node: Libp2p | null = null;
  private topics = new Set<string>();
  private onMessage?: (msg: ChatMessage) => void;

  private master: MsgStoreMaster;

  constructor(onMessage?: (msg: ChatMessage) => void) {
    this.onMessage = onMessage;
    this.master = ensureMaster();
  }

  isRunning(): boolean {
    return this.node != null;
  }

  getIdentity() {
    this.master = ensureMaster();
    return {
      displayName: this.master.client.displayName,
      signPublicKeyDerB64: this.master.client.signPublicKeyDerB64,
      encPublicKeyDerB64: this.master.client.encPublicKeyDerB64,
    };
  }

  setDisplayName(name: string): void {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return;
    this.master.client.displayName = trimmed;
    saveMaster(this.master);
  }

  listConversations(): ChatConversation[] {
    const items = Object.values(this.master.conversations).map((c) => ({
      convId: c.convId,
      type: c.type,
      title: c.title,
      topic: c.topic,
      createdAt: c.createdAt,
      lastMessageAt: c.lastMessageAt,
      lastMessagePreview: c.lastMessagePreview,
      unreadCount: c.unreadCount ?? 0,
      peerId: c.peerId,
    }));

    items.sort(
      (a, b) =>
        (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
    );
    return items;
  }

  loadMessages(convId: string, limit: number = 200): ChatMessage[] {
    const conv = this.master.conversations[convId];
    if (!conv) return [];
    return loadConversationMessages(conv.storageId, limit);
  }

  markRead(convId: string): void {
    const conv = this.master.conversations[convId];
    if (!conv) return;
    conv.unreadCount = 0;
    saveMaster(this.master);
  }

  ensureContact(input: {
    peerId: string;
    displayName?: string;
    signPublicKeyDerB64?: string;
    encPublicKeyDerB64?: string;
  }): void {
    const peerId = (input.peerId ?? '').trim();
    if (!peerId) throw new Error('peerId 为空');

    const existing = this.master.contacts[peerId];
    const now = Date.now();
    this.master.contacts[peerId] = {
      peerId,
      displayName: input.displayName ?? existing?.displayName,
      signPublicKeyDerB64:
        input.signPublicKeyDerB64 ?? existing?.signPublicKeyDerB64,
      encPublicKeyDerB64:
        input.encPublicKeyDerB64 ?? existing?.encPublicKeyDerB64,
      addedAt: existing?.addedAt ?? now,
      lastSeenAt: existing?.lastSeenAt,
    };
    saveMaster(this.master);
  }

  createGroup(title: string): ChatConversation {
    const name = (title ?? '').trim();
    if (!name) throw new Error('群组名称为空');

    const groupId = crypto.randomBytes(16).toString('hex');
    const convId = `g:${groupId}`;
    const topic = `grp/${groupId}`;
    const storageId = sha256Hex(convId);

    const now = Date.now();
    this.master.conversations[convId] = {
      convId,
      type: 'group',
      title: name,
      topic,
      storageId,
      createdAt: now,
      unreadCount: 0,
    };
    saveMaster(this.master);

    // if running, subscribe immediately
    if (this.node) {
      try {
        (this.node as Libp2p).services.pubsub.subscribe(topic);
        this.topics.add(topic);
      } catch (err) {
        log.warn('subscribe group topic failed', err);
      }
    }

    return this.listConversations().find((c) => c.convId === convId)!;
  }

  joinGroup(input: { groupId: string; title: string }): ChatConversation {
    const groupId = (input.groupId ?? '').trim();
    if (!groupId) throw new Error('groupId 为空');

    const title = (input.title ?? '').trim() || `群组 ${groupId.slice(0, 8)}`;
    const convId = `g:${groupId}`;
    const topic = `grp/${groupId}`;
    const storageId = sha256Hex(convId);

    const existing = this.master.conversations[convId];
    const now = Date.now();
    this.master.conversations[convId] = {
      convId,
      type: 'group',
      title,
      topic,
      storageId,
      createdAt: existing?.createdAt ?? now,
      lastMessageAt: existing?.lastMessageAt,
      lastMessagePreview: existing?.lastMessagePreview,
      unreadCount: existing?.unreadCount ?? 0,
    };
    saveMaster(this.master);

    if (this.node) {
      try {
        (this.node as Libp2p).services.pubsub.subscribe(topic);
        this.topics.add(topic);
      } catch (err) {
        log.warn('subscribe join group topic failed', err);
      }
    }

    return this.listConversations().find((c) => c.convId === convId)!;
  }

  startDm(input: {
    peerId: string;
    title?: string;
    peerEncPublicKeyDerB64: string;
    peerSignPublicKeyDerB64: string;
  }): ChatConversation {
    const peerId = (input.peerId ?? '').trim();
    if (!peerId) throw new Error('对端 peerId 为空');

    // ensure contact keys exist
    this.ensureContact({
      peerId,
      displayName: input.title,
      encPublicKeyDerB64: input.peerEncPublicKeyDerB64,
      signPublicKeyDerB64: input.peerSignPublicKeyDerB64,
    });

    const selfPeer = this.node?.peerId?.toString?.();
    if (!selfPeer) {
      // convId/topic must be stable; for now require node running to know our peerId
      throw new Error('libp2p 未启动，无法创建私聊（需要本机 peerId）');
    }

    const pair = [selfPeer, peerId].sort().join('|');
    const pairHash = sha256Hex(pair).slice(0, 32);
    const convId = `dm:${pairHash}`;
    const topic = `dm/${pairHash}`;
    const storageId = sha256Hex(convId);

    if (!this.master.conversations[convId]) {
      const now = Date.now();
      this.master.conversations[convId] = {
        convId,
        type: 'dm',
        title:
          input.title?.trim() ||
          this.master.contacts[peerId]?.displayName ||
          peerId,
        topic,
        storageId,
        createdAt: now,
        unreadCount: 0,
        peerId,
        peerEncPublicKeyDerB64: input.peerEncPublicKeyDerB64,
        peerSignPublicKeyDerB64: input.peerSignPublicKeyDerB64,
      };
      saveMaster(this.master);
    }

    if (this.node) {
      try {
        (this.node as Libp2p).services.pubsub.subscribe(topic);
        this.topics.add(topic);
      } catch (err) {
        log.warn('subscribe dm topic failed', err);
      }
    }

    return this.listConversations().find((c) => c.convId === convId)!;
  }

  private signEnvelope(env: Omit<WireEnvelopeV1, 'sigB64'>): string {
    const key = importEd25519Private(this.master.client.signPrivateKeyDerB64);
    const payload = encodeWireSignPayload(env);
    const sig = crypto.sign(null, payload, key);
    return sig.toString('base64');
  }

  private verifyEnvelope(env: WireEnvelopeV1): boolean {
    try {
      const pub = importEd25519Public(env.fromSignPublicKeyDerB64);
      const { sigB64, ...rest } = env;
      const payload = encodeWireSignPayload(rest);
      return crypto.verify(null, payload, pub, Buffer.from(sigB64, 'base64'));
    } catch {
      return false;
    }
  }

  private deriveDmKey(
    selfEncPrivDerB64: string,
    peerEncPubDerB64: string,
    salt: string,
  ): Buffer {
    const priv = importX25519Private(selfEncPrivDerB64);
    const pub = importX25519Public(peerEncPubDerB64);
    const secret = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
    const key = crypto.hkdfSync(
      'sha256',
      secret,
      Buffer.from(salt, 'utf8'),
      Buffer.from('wtb-dm', 'utf8'),
      32,
    );
    return Buffer.from(key);
  }

  private isNoPeersSubscribedToTopicError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.includes('PublishError.NoPeersSubscribedToTopic');
  }

  async sendMessage(convId: string, text: string): Promise<void> {
    const node = this.node;
    if (!node) throw new Error('libp2p 未启动');
    const conv = this.master.conversations[convId];
    if (!conv) throw new Error('会话不存在');

    const topic = conv.topic;
    const now = Date.now();
    const nonceB64 = randomB64(12);
    const fromPeerId = node.peerId.toString();

    const base: Omit<WireEnvelopeV1, 'sigB64'> = {
      v: 1,
      kind: conv.type,
      convId,
      topic,
      fromPeerId,
      fromDisplayName: this.master.client.displayName,
      ts: now,
      nonceB64,
      fromSignPublicKeyDerB64: this.master.client.signPublicKeyDerB64,
    };

    let env: WireEnvelopeV1;

    if (conv.type === 'group') {
      const withText: Omit<WireEnvelopeV1, 'sigB64'> = {
        ...base,
        text: text ?? '',
      };
      env = {
        ...withText,
        sigB64: this.signEnvelope(withText),
      };
    } else {
      const peerId = conv.peerId;
      if (!peerId) throw new Error('私聊缺少对端 peerId');
      const peerEncPub = conv.peerEncPublicKeyDerB64;
      const peerSignPub = conv.peerSignPublicKeyDerB64;
      if (!peerEncPub || !peerSignPub) throw new Error('私聊缺少对端公钥');

      const key = this.deriveDmKey(
        this.master.client.encPrivateKeyDerB64,
        peerEncPub,
        convId,
      );
      const enc = aesGcmEncrypt(key, text ?? '');

      const withDm: Omit<WireEnvelopeV1, 'sigB64'> = {
        ...base,
        toPeerId: peerId,
        ivB64: enc.ivB64,
        ctB64: enc.ctB64,
        tagB64: enc.tagB64,
        fromEncPublicKeyDerB64: this.master.client.encPublicKeyDerB64,
      };

      env = {
        ...withDm,
        sigB64: this.signEnvelope(withDm),
      };
    }

    // Persist locally first so the UI doesn't fail hard on transient publish errors.
    const stored: ChatMessage = {
      convId,
      type: conv.type,
      topic,
      fromPeerId,
      fromDisplayName: this.master.client.displayName,
      direction: 'out',
      text: text ?? '',
      ts: now,
      receivedAt: now,
    };

    appendConversationMessage(conv.storageId, stored);
    conv.lastMessageAt = now;
    conv.lastMessagePreview = safePreview(stored.text);
    conv.unreadCount = conv.unreadCount ?? 0;
    saveMaster(this.master);
    this.onMessage?.(stored);

    try {
      await node.services.pubsub.publish(
        topic,
        u8FromString(JSON.stringify(env)),
      );
    } catch (err) {
      if (this.isNoPeersSubscribedToTopicError(err)) {
        // Common in small networks / first start: allow "offline send" without surfacing an error.
        log.info('publish skipped: no peers subscribed to topic', {
          topic,
          convId,
        });
        return;
      }

      log.warn('pubsub publish failed', err);
      throw err;
    }
  }

  async start(): Promise<ChatStatus> {
    if (this.node) return this.status();
    console.log('Starting libp2p group chat service...');
    this.master = ensureMaster();
    const yggdrasilIPv6Address = await getYggdrasilIPv6AddressOrThrow();
    const desiredPort = getP2pPort();
    let p2pPort = desiredPort;
    if (desiredPort === 0) {
      p2pPort = await pickFreeTcpPortOnHost(yggdrasilIPv6Address);
      log.info('WTB_P2P_PORT=0, picked free port %d for p2p', p2pPort);
    }
    // Listen only on the Yggdrasil interface to avoid exposing the chat service on unintended networks.
    // Use all possible protocols to maximize connectivity, but only on Yggdrasil interface
    const makeNode = async (listenPort: number) => {
      const yggdrasilIPv6AddressMA = multiaddr(
        `/ip6/${yggdrasilIPv6Address}/tcp/${listenPort}`,
      );
      console.log('Libp2p will listen on', yggdrasilIPv6AddressMA.toString());
      const node = await createLibp2p({
      // addresses: {
      //   listen: ['/ip6/::/tcp/0'],
      // },
      // addresses: {
      //   listen: [yggdrasilIPv6AddressMA.toString(),'/ip4/0.0.0.0/tcp/0'],
      // },
      addresses: {
        // Bind to a specific interface address (Yggdrasil) so we don't advertise loopback
        // or other host-local/private addresses from unrelated interfaces.
        listen: [yggdrasilIPv6AddressMA.toString()],
        // Yggdrasil uses ULA (fd00::/8). Some libp2p address managers may treat these as
        // "private" and omit them from advertised multiaddrs unless explicitly announced.
        announce: [yggdrasilIPv6AddressMA.toString()],
      },
      transports: [tcp()],
      
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: false,
          globalSignaturePolicy: 'StrictSign',
        }),
      },
      });
      return node;
    };

    let node = await makeNode(p2pPort);

    // libp2p does not start listening until `start()` is called.
    try {
      await node.start();
    } catch (err) {
      // If the preferred port is occupied, retry once with a free ephemeral port.
      if (desiredPort !== 0 && isAddrInUseError(err)) {
        log.warn('p2p port %d in use, retrying with a free port', p2pPort);
        try {
          await node.stop();
        } catch {
          // ignore
        }
        p2pPort = await pickFreeTcpPortOnHost(yggdrasilIPv6Address);
        node = await makeNode(p2pPort);
        await node.start();
      } else {
        log.error('libp2p node start failed', err);
        try {
          await node.stop();
        } catch {
          // ignore
        }
        throw err;
      }
    }

    const startedListenAddrs = node.getMultiaddrs().map((ma) => ma.toString());
    log.info(
      'Libp2p node started with peerId %s, listening on %o',
      node.peerId.toString(),
      startedListenAddrs,
    );
    if (startedListenAddrs.length === 0) {
      log.warn(
        'Libp2p node started but has no listen multiaddrs (check transports/addresses.listen)',
      );
    }

    // Best-effort: dial bootstrap peers so nodes can actually discover each other.
    // Without at least one connection, gossipsub will have no mesh peers and publishes
    // will commonly report "NoPeersSubscribedToTopic".
    const bootstrap = getBootstrapMultiaddrs();
    if (bootstrap.length > 0) {
      log.info('Dialing %d bootstrap peer(s)...', bootstrap.length);
      for (const addr of bootstrap) {
        try {
          await node.dial(multiaddr(addr));
        } catch (err) {
          log.warn('bootstrap dial failed: %s', addr, err);
        }
      }
    }

    node.services.pubsub.addEventListener('message', (event: any) => {
      try {
        const topic = String(event.detail?.topic ?? '');
        const fromPeer = event.detail?.from?.toString?.() ?? '';
        const dataU8 = event.detail?.data;
        const data = dataU8 ? u8ToString(dataU8) : '';

        let env: WireEnvelopeV1 | null = null;
        try {
          env = JSON.parse(data) as WireEnvelopeV1;
        } catch {
          return;
        }

        if (!env || env.v !== 1) return;
        if (!env.topic || env.topic !== topic) return;
        if (!env.convId) return;
        if (!this.master.conversations[env.convId]) {
          // Unknown conversation - ignore (requires explicit join/add)
          return;
        }

        if (!this.verifyEnvelope(env)) {
          return;
        }

        const conv = this.master.conversations[env.convId];
        const isFromSelf = env.fromPeerId === node.peerId.toString();
        if (isFromSelf) return;

        let text = '';
        if (env.kind === 'group') {
          text = env.text ?? '';
        } else {
          // DM: only accept if it's addressed to us
          const selfPeerId = node.peerId.toString();
          if (env.toPeerId !== selfPeerId) {
            return;
          }

          const peerEncPub = conv.peerEncPublicKeyDerB64;
          if (!peerEncPub) {
            // Try to learn the peer encryption pubkey from envelope
            if (env.fromEncPublicKeyDerB64) {
              conv.peerEncPublicKeyDerB64 = env.fromEncPublicKeyDerB64;
              saveMaster(this.master);
            }
          }

          const usePeerEncPub = conv.peerEncPublicKeyDerB64;
          if (!usePeerEncPub || !env.ivB64 || !env.ctB64 || !env.tagB64) return;
          const key = this.deriveDmKey(
            this.master.client.encPrivateKeyDerB64,
            usePeerEncPub,
            env.convId,
          );
          try {
            text = aesGcmDecrypt(key, env.ivB64, env.ctB64, env.tagB64);
          } catch {
            return;
          }
        }

        // Update contact last-seen and keys
        if (env.fromPeerId) {
          const now = Date.now();
          const c = this.master.contacts[env.fromPeerId];
          this.master.contacts[env.fromPeerId] = {
            peerId: env.fromPeerId,
            displayName: env.fromDisplayName ?? c?.displayName,
            signPublicKeyDerB64:
              env.fromSignPublicKeyDerB64 ?? c?.signPublicKeyDerB64,
            encPublicKeyDerB64:
              env.fromEncPublicKeyDerB64 ?? c?.encPublicKeyDerB64,
            addedAt: c?.addedAt ?? now,
            lastSeenAt: now,
          };
        }

        const stored: ChatMessage = {
          convId: env.convId,
          type: conv.type,
          topic,
          fromPeerId: env.fromPeerId || fromPeer,
          fromDisplayName: env.fromDisplayName,
          direction: 'in',
          text,
          ts: env.ts,
          receivedAt: Date.now(),
        };

        appendConversationMessage(conv.storageId, stored);
        conv.lastMessageAt = stored.ts;
        conv.lastMessagePreview = safePreview(stored.text);
        conv.unreadCount = (conv.unreadCount ?? 0) + 1;
        saveMaster(this.master);

        this.onMessage?.(stored);
      } catch (err) {
        log.warn('libp2p chat message handler failed', err);
      }
    });

    // Subscribe to known topics on startup
    for (const conv of Object.values(this.master.conversations)) {
      try {
        console.log('Subscribing to topic on startup', conv.topic);
        node.services.pubsub.subscribe(conv.topic);
        this.topics.add(conv.topic);
      } catch {
        // ignore
      }
    }

    this.node = node;
    log.info('MessageStore directory: %s', getMsgStoreDir());
    return this.status();
  }

  async stop(): Promise<ChatStatus> {
    const node = this.node;
    this.node = null;
    this.topics.clear();

    if (node) {
      try {
        await node.stop();
      } catch (err) {
        log.warn('libp2p stop failed', err);
      }
    }

    return this.status();
  }

  status(): ChatStatus {
    const node = this.node;
    const id = this.getIdentity();
    if (!node) {
      return {
        running: false,
        listenAddrs: [],
        peers: [],
        topics: Array.from(this.topics),
        displayName: id.displayName,
        identity: {
          signPublicKeyDerB64: id.signPublicKeyDerB64,
          encPublicKeyDerB64: id.encPublicKeyDerB64,
        },
      };
    }
    // console.log('Libp2p status requested', {
    //   peerId: node.peerId.toString(),
    //   listenAddrs: node.getMultiaddrs().map((ma) => ma.toString()),
    //   peers: node.getPeers().map((p) => p.toString()),
    //   topics: Array.from(this.topics),
    // });
    return {
      running: true,
      peerId: node.peerId.toString(),
      listenAddrs: node.getMultiaddrs().map((ma) => ma.toString()),
      peers: node.getPeers().map((p) => p.toString()),
      topics: Array.from(this.topics),
      displayName: id.displayName,
      identity: {
        signPublicKeyDerB64: id.signPublicKeyDerB64,
        encPublicKeyDerB64: id.encPublicKeyDerB64,
      },
    };
  }

  async dial(multiaddrStr: string): Promise<ChatStatus> {
    const node = this.node;
    if (!node) throw new Error('libp2p 未启动');
    if (!multiaddrStr || typeof multiaddrStr !== 'string')
      throw new Error('multiaddr 为空');

    const ma = multiaddr(multiaddrStr.trim());
    await node.dial(ma);
    return this.status();
  }

  async subscribe(topic: string): Promise<ChatStatus> {
    const node = this.node;
    if (!node) throw new Error('libp2p 未启动');
    const t = (topic ?? '').trim();
    if (!t) throw new Error('topic 为空');

    (node as Libp2p).services.pubsub.subscribe(t);
    this.topics.add(t);
    return this.status();
  }

  async publish(topic: string, message: string): Promise<void> {
    const node = this.node;
    if (!node) throw new Error('libp2p 未启动');
    const t = (topic ?? '').trim();
    if (!t) throw new Error('topic 为空');

    const payload = u8FromString(message ?? '');
    try {
      await node.services.pubsub.publish(t, payload);
    } catch (err) {
      if (this.isNoPeersSubscribedToTopicError(err)) {
        log.info('publish skipped: no peers subscribed to topic', { topic: t });
        return;
      }
      throw err;
    }
  }
}
