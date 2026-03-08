import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import { app } from 'electron';
import crypto from 'crypto';
import YAML from 'yaml';

export type WtbConfigV1 = {
  version: 1;
  p2p: {
    /** Optional: list of bootstrap peer multiaddrs to dial on startup */
    bootstrapMultiaddrs: string[];

    /** Optional discovery settings */
    discovery?: {
      /** Enable kad-dht (used for peer/content routing). Default: true */
      enableDht?: boolean;
      /** Bootstrap peer discovery tick interval (ms). Default: 60_000 */
      bootstrapIntervalMs?: number;
    };
  };

  /** Optional: yggdrasil-related settings */
  yggdrasil?: {
    /** Optional: list of public peer URLs to write into yggdrasil.conf `Peers` */
    publicPeers?: string[];
  };
};

const CONFIG_FILE_NAME = 'wtb.conf';

let cachedConfig: WtbConfigV1 | null = null;

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const sha256Hex = (input: string): string => {
  return crypto.createHash('sha256').update(input).digest('hex');
};

const safeNowTag = (): string => {
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, '-');
};

export const getWtbDataDir = (): string => {
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
    const isUnderDir = (childPath: string, parentPath: string): boolean => {
      const child = path.resolve(childPath).toLowerCase();
      const parent = path.resolve(parentPath).toLowerCase();
      return child === parent || child.startsWith(parent + path.sep);
    };
    const looksInstalled =
      (programFiles && isUnderDir(exeDir, programFiles)) ||
      (programFilesX86 && isUnderDir(exeDir, programFilesX86));

    if (!looksInstalled) {
      try {
        fs.accessSync(exeDir, fs.constants.W_OK);
        return portableDataDir;
      } catch {
        // not writable
      }
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

export const getWtbConfigPath = (): string => {
  return path.join(getWtbDataDir(), CONFIG_FILE_NAME);
};

const defaultConfigV1 = (): WtbConfigV1 => {
  return {
    version: 1,
    p2p: {
      bootstrapMultiaddrs: [
        '/ip6/201:f536:8bb3:f51d:3377:70d4:fb3b:a829/tcp/4001/p2p/12D3KooWQ9ApfKJ2y4AL13QEnn2PuKZzsyjKk1iz2GCCNNUXrrmA',
        // '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
        // '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
        // '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
        // '/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8',
        // '/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ',
      ],
      discovery: {
        enableDht: true,
        bootstrapIntervalMs: 60_000,
      },
    },
  };
};

const normalizeStringList = (
  raw: unknown,
  options?: { max?: number },
): string[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const max =
    options?.max && Number.isFinite(options.max) && options.max > 0
      ? Math.floor(options.max)
      : undefined;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    out.push(s);
    seen.add(s);
    if (max && out.length >= max) break;
  }
  return out.length ? out : undefined;
};

const normalizeConfigV1 = (raw: unknown): WtbConfigV1 => {
  const def = defaultConfigV1();
  const obj = (raw && typeof raw === 'object' ? (raw as any) : {}) as any;

  const version = obj.version === 1 ? 1 : 1;

  const bootstrapRaw = obj?.p2p?.bootstrapMultiaddrs;
  const bootstrapMultiaddrs = Array.isArray(bootstrapRaw)
    ? bootstrapRaw
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v) => !!v)
    : def.p2p.bootstrapMultiaddrs;

  const discoveryObj =
    obj?.p2p?.discovery && typeof obj.p2p.discovery === 'object'
      ? obj.p2p.discovery
      : {};

  const enableDhtRaw = (discoveryObj as any).enableDht;
  const enableDht =
    typeof enableDhtRaw === 'boolean' ? enableDhtRaw : def.p2p.discovery?.enableDht;

  const intervalRaw = (discoveryObj as any).bootstrapIntervalMs;
  const intervalNum =
    typeof intervalRaw === 'number' ? intervalRaw : Number(intervalRaw);
  const bootstrapIntervalMs =
    Number.isFinite(intervalNum) && intervalNum >= 5_000
      ? Math.floor(intervalNum)
      : def.p2p.discovery?.bootstrapIntervalMs;

  const yggObj =
    obj?.yggdrasil && typeof obj.yggdrasil === 'object' ? obj.yggdrasil : null;
  const publicPeers = normalizeStringList(yggObj?.publicPeers, { max: 10 });

  return {
    version,
    p2p: {
      bootstrapMultiaddrs,
      discovery: {
        enableDht,
        bootstrapIntervalMs,
      },
    },
    yggdrasil: publicPeers ? { publicPeers } : undefined,
  };
};

const renderYamlWithHeader = (cfg: WtbConfigV1): string => {
  const header =
    '# WorldTreeBrowser 配置文件\n'
    + '# 位置：wtb-data/wtb.conf（可直接编辑）\n'
    + '#\n'
    + '# 说明：\n'
    + '# - p2p.bootstrapMultiaddrs：启动时尝试 dial 的 bootstrap peer 列表（multiaddr）\n'
    + '#   示例：/ip6/<ygg-ip>/tcp/<port>/p2p/<peerId>\n'
    + '# - p2p.discovery.enableDht：是否启用 kad-dht（用于更自动的发现/路由）\n'
    + '# - p2p.discovery.bootstrapIntervalMs：bootstrap 发现轮询间隔（毫秒）\n'
    + '# - yggdrasil.publicPeers：可选。Yggdrasil 公共 peer 列表（URL），将写入 yggdrasil.conf 的 Peers。\n'
    + '#   - 支持 1~10 个；不填则保持现有随机 peers 逻辑。\n'
    + '#\n';

  const yamlBody = YAML.stringify(cfg);
  // Ensure a trailing newline for nicer diffs.
  return `${header}${yamlBody.trimEnd()}\n`;
};

const writeConfigAtomic = (filePath: string, text: string): void => {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  fs.renameSync(tmp, filePath);
};

export const loadOrCreateWtbConfig = (): WtbConfigV1 => {
  if (cachedConfig) return cachedConfig;

  const cfgPath = getWtbConfigPath();
  try {
    if (!fs.existsSync(cfgPath)) {
      const def = defaultConfigV1();
      writeConfigAtomic(cfgPath, renderYamlWithHeader(def));
      cachedConfig = def;
      log.info('Created default config: %s', cfgPath);
      return def;
    }

    const rawText = fs.readFileSync(cfgPath, 'utf8');
    const parsed = YAML.parse(rawText);
    const cfg = normalizeConfigV1(parsed);
    cachedConfig = cfg;
    return cfg;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Failed to load config, regenerating defaults: %s', msg);

    try {
      if (fs.existsSync(cfgPath)) {
        const backupPath = `${cfgPath}.broken-${safeNowTag()}-${sha256Hex(msg).slice(0, 8)}`;
        fs.copyFileSync(cfgPath, backupPath);
        log.warn('Backed up broken config to: %s', backupPath);
      }
    } catch {
      // ignore
    }

    const def = defaultConfigV1();
    try {
      writeConfigAtomic(cfgPath, renderYamlWithHeader(def));
    } catch {
      // ignore
    }
    cachedConfig = def;
    return def;
  }
};

export const getWtbConfig = (): WtbConfigV1 => {
  return loadOrCreateWtbConfig();
};

export const reloadWtbConfig = (): WtbConfigV1 => {
  cachedConfig = null;
  return loadOrCreateWtbConfig();
};

export const setWtbYggdrasilPublicPeers = (peers: string[] | null): WtbConfigV1 => {
  const cfgPath = getWtbConfigPath();
  let parsed: any = {};

  try {
    if (fs.existsSync(cfgPath)) {
      const rawText = fs.readFileSync(cfgPath, 'utf8');
      parsed = YAML.parse(rawText) || {};
    }
  } catch {
    parsed = {};
  }

  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!parsed.yggdrasil || typeof parsed.yggdrasil !== 'object') {
    parsed.yggdrasil = {};
  }

  const normalizedPeers = normalizeStringList(peers, { max: 10 });
  if (normalizedPeers && normalizedPeers.length) {
    parsed.yggdrasil.publicPeers = normalizedPeers;
  } else {
    // Remove the key to keep initial/default behavior intact.
    try {
      delete parsed.yggdrasil.publicPeers;
    } catch {
      // ignore
    }
  }

  // If the object becomes empty, remove it as well.
  try {
    const keys = Object.keys(parsed.yggdrasil || {});
    if (!keys.length) delete parsed.yggdrasil;
  } catch {
    // ignore
  }

  const cfg = normalizeConfigV1(parsed);
  writeConfigAtomic(cfgPath, renderYamlWithHeader(cfg));
  cachedConfig = cfg;
  return cfg;
};
