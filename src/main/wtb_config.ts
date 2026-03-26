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
    /** Optional: list of manual public peer URLs stored by WTB */
    publicPeers?: string[];

    /** Optional: auto-manage runtime public peer selection */
    autoPeerManager?: {
      /** Enable automatic runtime peer management. Default: true */
      enabled?: boolean;
      /** Desired total number of public peers to keep. Default: 6 */
      targetPeerCount?: number;
      /** Delay before first reconcile after startup (ms). Default: 20_000 */
      initialDelayMs?: number;
      /** Reconcile interval (ms). Default: 15 * 60_000 */
      reconcileIntervalMs?: number;
      /** Number of candidate peers to probe per cycle. Default: 12 */
      sampleSize?: number;
      /** Number of getPeers RTT samples per probe. Default: 3 */
      probeAttempts?: number;
      /** Delay between RTT samples (ms). Default: 1_500 */
      probeIntervalMs?: number;
      /** Timeout per admin command/probe step (ms). Default: 5_000 */
      probeTimeoutMs?: number;

      /** Last automatically selected runtime peer set */
      lastSelectedPeers?: string[];

      /** Persistent probe cache used by auto scheduling */
      probeState?: Record<
        string,
        {
          region?: string;
          lastProbedAt?: number;
          lastLatencyMs?: number | null;
          lastScore?: number | null;
          reachable?: boolean;
          successCount?: number;
          failureCount?: number;
        }
      >;
    };
  };

  /** Optional: web/static files configuration */
  web?: {
    /** Optional: override base assets directory used for bundled web apps (cinny/element) */
    assetsDir?: string;
  };
};

export type YggdrasilAutoPeerManagerConfig = NonNullable<
  NonNullable<WtbConfigV1['yggdrasil']>['autoPeerManager']
>;

export type YggdrasilAutoPeerManagerConfigInput = Partial<
  YggdrasilAutoPeerManagerConfig
>;

export type YggdrasilAutoPeerProbeState = {
  region?: string;
  lastProbedAt?: number;
  lastLatencyMs?: number | null;
  lastScore?: number | null;
  reachable?: boolean;
  successCount?: number;
  failureCount?: number;
};

export type YggdrasilAutoPeerManagerRuntimeStateInput = {
  lastSelectedPeers?: string[] | null;
  probeState?: Record<string, YggdrasilAutoPeerProbeState> | null;
};

const CONFIG_FILE_NAME = 'wtb.conf';

let cachedConfig: WtbConfigV1 | null = null;

const ensureDir = (dirPath: string): void => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const mergeMissingDirContentsSync = (srcDir: string, dstDir: string): number => {
  let copiedCount = 0;
  ensureDir(dstDir);
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copiedCount += mergeMissingDirContentsSync(srcPath, dstPath);
      continue;
    }
    if (entry.isFile()) {
      if (fs.existsSync(dstPath)) continue;
      ensureDir(path.dirname(dstPath));
      fs.copyFileSync(srcPath, dstPath);
      copiedCount += 1;
    }
  }

  return copiedCount;
};

const migrateLegacyDataIfNeeded = (
  legacyDirs: string[],
  targetDir: string,
): void => {
  try {
    let copiedAny = false;
    for (const legacyDir of legacyDirs) {
      if (!legacyDir) continue;
      if (path.resolve(legacyDir) === path.resolve(targetDir)) continue;
      if (!fs.existsSync(legacyDir)) continue;

      const copiedCount = mergeMissingDirContentsSync(legacyDir, targetDir);
      if (copiedCount <= 0) continue;

      log.info(
        'Merged %d legacy files from %s into %s',
        copiedCount,
        legacyDir,
        targetDir,
      );
      copiedAny = true;
    }

    if (!copiedAny) {
      log.debug('No legacy packaged data needed migration into %s', targetDir);
    }
  } catch (error) {
    log.warn('Failed to migrate legacy packaged data dir', error);
  }
};

const getStablePackagedDataDir = (): string => {
  const localAppData =
    (process.env.LOCALAPPDATA || '').trim() ||
    path.join(app.getPath('home'), 'AppData', 'Local');
  return path.join(localAppData, 'Programs', 'wtb-data');
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

    // If explicit portable mode is requested, keep portable behaviour.
    if ((process.env.PORTABLE_EXECUTABLE_DIR || '').trim()) {
      return portableDataDir;
    }

    // Prefer a stable directory under Local\Programs so upgrades don't wipe data.
    try {
      const persistentDataDir = getStablePackagedDataDir();
      const roaming = app.getPath('appData');
      const roamingDataDir =
        roaming && roaming.trim() ? path.join(roaming, 'wtb') : '';

      // Best-effort one-time migration from old packaged layouts.
      migrateLegacyDataIfNeeded(
        [portableDataDir, roamingDataDir],
        persistentDataDir,
      );
      return persistentDataDir;
    } catch {
      // ignore
    }

    // If a portable data dir already exists next to the exe, respect it.
    try {
      if (fs.existsSync(portableDataDir)) {
        return portableDataDir;
      }
    } catch {
      // ignore
    }

    // Fallback to portable location.
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

const normalizeBoolean = (raw: unknown, fallback: boolean): boolean => {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return fallback;
};

const normalizeInteger = (
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(num)));
};

const normalizeFiniteNumberOrNull = (raw: unknown): number | null => {
  if (raw == null) return null;
  const num = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
};

const normalizeProbeState = (
  raw: unknown,
): Record<string, YggdrasilAutoPeerProbeState> | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

  const out: Record<string, YggdrasilAutoPeerProbeState> = {};
  for (const [key, value] of Object.entries(raw)) {
    const uri = key.trim();
    if (!uri) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    const entry = value as Record<string, unknown>;
    out[uri] = {
      region:
        typeof entry.region === 'string' && entry.region.trim()
          ? entry.region.trim().toLowerCase()
          : undefined,
      lastProbedAt: normalizeFiniteNumberOrNull(entry.lastProbedAt) ?? undefined,
      lastLatencyMs: normalizeFiniteNumberOrNull(entry.lastLatencyMs),
      lastScore: normalizeFiniteNumberOrNull(entry.lastScore),
      reachable: normalizeBoolean(entry.reachable, false),
      successCount: normalizeFiniteNumberOrNull(entry.successCount) ?? undefined,
      failureCount: normalizeFiniteNumberOrNull(entry.failureCount) ?? undefined,
    };
  }

  return Object.keys(out).length ? out : undefined;
};

export const defaultYggdrasilAutoPeerManagerConfig = (): YggdrasilAutoPeerManagerConfig => {
  return {
    enabled: true,
    targetPeerCount: 6,
    initialDelayMs: 20_000,
    reconcileIntervalMs: 15 * 60_000,
    sampleSize: 12,
    probeAttempts: 3,
    probeIntervalMs: 1_500,
    probeTimeoutMs: 1_000,
    lastSelectedPeers: [],
    probeState: {},
  };
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
  const autoPeerManagerRaw =
    yggObj?.autoPeerManager && typeof yggObj.autoPeerManager === 'object'
      ? yggObj.autoPeerManager
      : {};
  const autoPeerDefaults = defaultYggdrasilAutoPeerManagerConfig();
  const autoPeerManager: YggdrasilAutoPeerManagerConfig = {
    enabled: normalizeBoolean(
      autoPeerManagerRaw?.enabled,
      autoPeerDefaults.enabled ?? true,
    ),
    targetPeerCount: normalizeInteger(
      autoPeerManagerRaw?.targetPeerCount,
      autoPeerDefaults.targetPeerCount ?? 6,
      3,
      6,
    ),
    initialDelayMs: normalizeInteger(
      autoPeerManagerRaw?.initialDelayMs,
      autoPeerDefaults.initialDelayMs ?? 20_000,
      0,
      10 * 60_000,
    ),
    reconcileIntervalMs: normalizeInteger(
      autoPeerManagerRaw?.reconcileIntervalMs,
      autoPeerDefaults.reconcileIntervalMs ?? 15 * 60_000,
      10_000,
      24 * 60 * 60_000,
    ),
    sampleSize: normalizeInteger(
      autoPeerManagerRaw?.sampleSize,
      autoPeerDefaults.sampleSize ?? 12,
      1,
      64,
    ),
    probeAttempts: normalizeInteger(
      autoPeerManagerRaw?.probeAttempts,
      autoPeerDefaults.probeAttempts ?? 3,
      1,
      8,
    ),
    probeIntervalMs: normalizeInteger(
      autoPeerManagerRaw?.probeIntervalMs,
      autoPeerDefaults.probeIntervalMs ?? 1_500,
      200,
      30_000,
    ),
    probeTimeoutMs: normalizeInteger(
      autoPeerManagerRaw?.probeTimeoutMs,
      autoPeerDefaults.probeTimeoutMs ?? 5_000,
      500,
      60_000,
    ),
    lastSelectedPeers:
      normalizeStringList(autoPeerManagerRaw?.lastSelectedPeers, { max: 16 }) ?? [],
    probeState: normalizeProbeState(autoPeerManagerRaw?.probeState) ?? {},
  };

  return {
    version,
    p2p: {
      bootstrapMultiaddrs,
      discovery: {
        enableDht,
        bootstrapIntervalMs,
      },
    },
    yggdrasil: {
      ...(publicPeers ? { publicPeers } : {}),
      autoPeerManager,
    },
    web: (() => {
      const webObj = obj?.web && typeof obj.web === 'object' ? obj.web : {};
      const assetsRaw = typeof webObj.assetsDir === 'string' ? webObj.assetsDir.trim() : '';
      return assetsRaw ? { assetsDir: assetsRaw } : undefined;
    })(),
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
    + '# - yggdrasil.publicPeers：手动模式下保存的 public peer 列表（URL）。\n'
    + '#   - 支持 1~10 个；仅用于手动模式，不写入 yggdrasil.conf。\n'
    + '# - yggdrasil.autoPeerManager：运行时自动调度 public peers。\n'
    + '#   - enabled：是否启用。\n'
    + '#   - targetPeerCount：目标总 peer 数（当前 UI 限制为 3~6，默认 6）。\n'
    + '#   - reconcileIntervalMs：后台重平衡周期。\n'
    + '#   - sampleSize / probeAttempts / probeIntervalMs / probeTimeoutMs：探测参数。\n'
    + '#   - lastSelectedPeers / probeState：自动调度内部状态，会由程序自动维护。\n'
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

const loadMutableConfigObject = (): any => {
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

  return parsed;
};

const persistMutableConfigObject = (parsed: any): WtbConfigV1 => {
  const cfgPath = getWtbConfigPath();

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

export const setWtbYggdrasilPublicPeers = (peers: string[] | null): WtbConfigV1 => {
  const parsed = loadMutableConfigObject();

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

  return persistMutableConfigObject(parsed);
};

export const setWtbYggdrasilAutoPeerManagerConfig = (
  input: YggdrasilAutoPeerManagerConfigInput,
): WtbConfigV1 => {
  const parsed = loadMutableConfigObject();
  const defaults = defaultYggdrasilAutoPeerManagerConfig();
  const existing = normalizeConfigV1(parsed).yggdrasil?.autoPeerManager || defaults;

  parsed.yggdrasil.autoPeerManager = {
    enabled:
      typeof input.enabled === 'boolean' ? input.enabled : existing.enabled,
    targetPeerCount:
      input.targetPeerCount == null
        ? existing.targetPeerCount
        : input.targetPeerCount,
    initialDelayMs:
      input.initialDelayMs == null
        ? existing.initialDelayMs
        : input.initialDelayMs,
    reconcileIntervalMs:
      input.reconcileIntervalMs == null
        ? existing.reconcileIntervalMs
        : input.reconcileIntervalMs,
    sampleSize:
      input.sampleSize == null ? existing.sampleSize : input.sampleSize,
    probeAttempts:
      input.probeAttempts == null
        ? existing.probeAttempts
        : input.probeAttempts,
    probeIntervalMs:
      input.probeIntervalMs == null
        ? existing.probeIntervalMs
        : input.probeIntervalMs,
    probeTimeoutMs:
      input.probeTimeoutMs == null
        ? existing.probeTimeoutMs
        : input.probeTimeoutMs,
    lastSelectedPeers: existing.lastSelectedPeers,
    probeState: existing.probeState,
  };

  return persistMutableConfigObject(parsed);
};

export const setWtbYggdrasilAutoPeerManagerRuntimeState = (
  input: YggdrasilAutoPeerManagerRuntimeStateInput,
): WtbConfigV1 => {
  const parsed = loadMutableConfigObject();

  if (
    !parsed.yggdrasil.autoPeerManager ||
    typeof parsed.yggdrasil.autoPeerManager !== 'object'
  ) {
    parsed.yggdrasil.autoPeerManager = {};
  }

  const normalizedSelected = normalizeStringList(input.lastSelectedPeers, {
    max: 16,
  });
  if (normalizedSelected && normalizedSelected.length) {
    parsed.yggdrasil.autoPeerManager.lastSelectedPeers = normalizedSelected;
  } else {
    delete parsed.yggdrasil.autoPeerManager.lastSelectedPeers;
  }

  const normalizedProbeState = normalizeProbeState(input.probeState);
  if (normalizedProbeState && Object.keys(normalizedProbeState).length) {
    parsed.yggdrasil.autoPeerManager.probeState = normalizedProbeState;
  } else {
    delete parsed.yggdrasil.autoPeerManager.probeState;
  }

  return persistMutableConfigObject(parsed);
};

export const setWtbWebAssetsDir = (assetsDir: string | null): WtbConfigV1 => {
  const parsed = loadMutableConfigObject();

  if (!parsed.web || typeof parsed.web !== 'object') parsed.web = {};

  if (assetsDir == null || (typeof assetsDir === 'string' && !assetsDir.trim())) {
    try {
      log.info('Clearing web assetsDir override');
      delete parsed.web.assetsDir;
    } catch {
      // ignore
    }
  } else if (typeof assetsDir === 'string') {
    log.info('Setting web assetsDir override: %s', assetsDir.trim());
    parsed.web.assetsDir = assetsDir.trim();
  }

  // Clean up if web is empty
  try {
    if (!parsed.web || Object.keys(parsed.web).length === 0) delete parsed.web;
  } catch {
    // ignore
  }

  return persistMutableConfigObject(parsed);
};
