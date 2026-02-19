// 服务公告相关类型定义（主进程和渲染进程共享）

/**
 * 服务公告 - 签名前的数据结构
 */
export type ServiceAnnouncementPayload = {
  /** 服务唯一 ID（建议：sha256(pubkey + url) 的前 16 字符） */
  id: string;
  /** 发布者的 libp2p peerId */
  peerId: string;
  /** 发布者的 ed25519 公钥（DER base64，用于验签） */
  pubkey: string;
  /** 服务访问 URL（Yggdrasil IPv6 地址） */
  url: string;
  /** 服务描述（简短） */
  desc: string;
  /** 序列号（每次更新必须递增，防止回放攻击） */
  seq: number;
  /** 时间戳（ISO 8601 格式） */
  ts: string;
  /** TTL（秒，例如 86400 = 1 天） */
  ttl: number;
  /** 是否撤回（撤回时设为 true） */
  revoked?: boolean;
};

/**
 * 签名后的服务公告（wire format）
 */
export type SignedServiceAnnouncement = ServiceAnnouncementPayload & {
  /** ed25519 签名（base64） */
  signature: string;
};

/**
 * 服务公告状态（用于展示）
 */
export type ServiceAnnouncementStatus = {
  /** 服务 ID */
  id: string;
  /** 发布者 peerId */
  peerId: string;
  /** 服务 URL */
  url: string;
  /** 服务描述 */
  desc: string;
  /** 序列号 */
  seq: number;
  /** 发布时间戳 */
  ts: string;
  /** TTL（秒） */
  ttl: number;
  /** 是否已撤回 */
  revoked: boolean;
  /** 本地接收时间 */
  receivedAt: number;
  /** 是否本地发布 */
  isLocal?: boolean;
};

/**
 * 本地服务公告配置（用于发布）
 */
export type LocalServiceConfig = {
  /** 服务 ID */
  id: string;
  /** 服务 URL */
  url: string;
  /** 服务描述 */
  desc: string;
  /** 当前序列号 */
  seq: number;
  /** 是否启用（周期性发布） */
  enabled: boolean;
  /** 创建时间 */
  createdAt: number;
  /** 最后发布时间 */
  lastPublishedAt?: number;
};

/**
 * 服务公告系统状态
 */
export type AnnouncementSystemStatus = {
  /** libp2p 是否运行 */
  running: boolean;
  /** 本地 peerId */
  peerId?: string;
  /** 本机监听的 multiaddrs（用于手动 dial / 排查网络） */
  listenAddrs?: string[];
  /** 当前已知 peers（通常是已连接或曾经见过的 peerId 列表，取决于 libp2p 实现） */
  peers?: string[];
  /** 活跃连接（peerId -> remoteAddr 列表） */
  peerConnections?: Array<{ peerId: string; addrs: string[] }>;
  /** 已订阅的 topic */
  subscribedTopic?: string;
  /** 本地发布的服务数量 */
  localServicesCount: number;
  /** 发现的远程服务数量 */
  discoveredServicesCount: number;
};
