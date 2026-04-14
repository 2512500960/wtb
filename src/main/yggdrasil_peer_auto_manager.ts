import log from 'electron-log';
import net from 'net';
import tls from 'tls';
import { URL } from 'url';
import {
  listPreferredPublicPeerNodes,
  type PreferredPublicPeerNode,
  type PublicPeerNode,
} from './public_ygg_peers';
import {
  defaultYggdrasilAutoPeerManagerConfig,
  reloadWtbConfig,
  setWtbYggdrasilAutoPeerManagerRuntimeState,
  type YggdrasilAutoPeerProbeState,
  type YggdrasilAutoPeerManagerConfig,
} from './wtb_config';

type YggdrasilCtlResult = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type RuntimePeerEntry = {
  uri: string;
  up: boolean;
  inbound: boolean;
  latencyMs: number | null;
  cost: number | null;
  uptimeSec: number | null;
  lastError: string | null;
  lastErrorAgoMs: number | null;
};

export type YggdrasilPeerAutoManagerEvent = {
  at: number;
  level: 'info' | 'warn';
  message: string;
};

export type YggdrasilPeerAutoManagerProbeSnapshot = {
  uri: string;
  region: string;
  latencyMs: number | null;
  cost: number | null;
  uptimeSec: number | null;
  score: number;
  outcome: 'selected' | 'rejected' | 'failed';
};

export type YggdrasilPeerAutoManagerCycleSummary = {
  reason: string;
  startedAt: number;
  finishedAt: number;
  pinnedUpCount: number;
  desiredManagedCount: number;
  currentManagedCount: number;
  selectedManagedPeers: string[];
  addedPeers: string[];
  removedPeers: string[];
  connectedPublicPeers: string[];
  managedConnectedPeers: string[];
  probeSnapshots: YggdrasilPeerAutoManagerProbeSnapshot[];
  error?: string;
};

export type YggdrasilPeerAutoManagerStatus = {
  running: boolean;
  enabled: boolean;
  cycleInFlight: boolean;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastCycleAt: number | null;
  lastSuccessAt: number | null;
  lastReason: string | null;
  config: YggdrasilAutoPeerManagerConfig;
  pinnedPeers: string[];
  connectedPublicPeers: string[];
  managedConnectedPeers: string[];
  selectedManagedPeers: string[];
  recentEvents: YggdrasilPeerAutoManagerEvent[];
  lastCycleSummary: YggdrasilPeerAutoManagerCycleSummary | null;
};

type ProbeResult = RuntimePeerEntry & {
  region: string;
  address: string;
  score: number;
};

type ProbeAttempt = {
  candidate: PreferredPublicPeerNode;
  result: ProbeResult | null;
};

type ProbePoolMode = 'bootstrap' | 'maintenance';

type ProbeStateEntry = {
  region: string;
  lastProbedAt: number | null;
  lastLatencyMs: number | null;
  lastScore: number | null;
  reachable: boolean;
  successCount: number;
  failureCount: number;
};

type Dependencies = {
  isYggdrasilRunning: () => boolean;
  loadBundledPeers: () => PublicPeerNode[];
  invokeCtl: (
    command: 'addpeer' | 'removepeer' | 'getpeersjson',
    args?: string[],
    options?: { timeoutMs?: number },
  ) => Promise<YggdrasilCtlResult>;
};

type ResolvedAutoPeerConfig = Required<YggdrasilAutoPeerManagerConfig>;

const MAX_RECENT_EVENTS = 40;
const normalizeUri = (value: string): string => value.trim();
const deriveUriHostKey = (value: string): string => {
  try {
    const u = new URL(value);
    const scheme = (u.protocol || '').replace(':', '') || '';
    let port = Number(u.port || 0) || undefined;
    if (!port) {
      if (scheme === 'tls' || scheme === 'wss' || scheme === 'quic') port = 443;
      else if (scheme === 'ws' || scheme === 'tcp') port = 80;
      else port = 443;
    }
    return `${scheme}://${u.hostname}:${port}`;
  } catch {
    return value.trim();
  }
};
const normalizeRegion = (value: string | undefined): string =>
  (value || 'unknown').trim().toLowerCase() || 'unknown';

const clampTargetPeerCount = (value: number | undefined): number => {
  const target = typeof value === 'number' ? value : 6;
  return Math.min(6, Math.max(3, Math.floor(target)));
};

const deriveProbePoolSize = (targetPeerCount: number): number => {
  return Math.min(18, Math.max(6, targetPeerCount * 2));
};

const deriveProbeAttempts = (targetPeerCount: number): number => {
  return Math.min(8, Math.max(4, targetPeerCount * 2));
};

const getBootstrapRegionPriority = (region: string): number => {
  const normalized = normalizeRegion(region);
  if (
    /japan|singapore|hong\s*kong|hongkong|taiwan|korea|south\s*korea|china|thailand|malaysia|indonesia|vietnam|philippines|india/.test(
      normalized,
    )
  ) {
    return 0;
  }
  if (/united\s*states|usa|us|canada/.test(normalized)) {
    return 1;
  }
  if (
    /finland|germany|netherlands|france|sweden|norway|denmark|uk|united\s*kingdom|europe|spain|italy|poland|czech|austria|switzerland|belgium|ireland/.test(
      normalized,
    )
  ) {
    return 2;
  }
  if (/australia|new\s*zealand|oceania/.test(normalized)) {
    return 3;
  }
  return 4;
};

const parsePercent = (value: string | undefined): number => {
  if (!value) return 0;
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!match) return 0;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : 0;
};

const durationLikeToMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1_000_000 ? value / 1_000_000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed >= 1_000_000 ? parsed / 1_000_000 : parsed;
    }
  }
  return null;
};

const numberLike = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const formatProbeMetric = (label: string, value: number | null): string => {
  if (value == null || !Number.isFinite(value)) return `${label}=n/a`;
  return `${label}=${Math.round(value * 10) / 10}`;
};

const scorePreferredPeer = (peer: PreferredPublicPeerNode): number => {
  const reliabilityScore = parsePercent(peer.reliability) * 4;
  const protocolScore =
    peer.scheme === 'tls'
      ? 60
      : peer.scheme === 'quic'
        ? 56
        : peer.scheme === 'wss'
          ? 52
          : peer.scheme === 'ws'
            ? 48
            : peer.scheme === 'tcp'
              ? 44
              : 30;
  const ipScore =
    peer.ipVersion === 'ipv6' ? 12 : peer.ipVersion === 'unknown' ? 6 : 0;
  const statusScore = /online/i.test(peer.status || '') ? 15 : 0;
  return reliabilityScore + protocolScore + ipScore + statusScore;
};

const scoreRuntimePeer = (
  peer: RuntimePeerEntry,
  candidate: PreferredPublicPeerNode | undefined,
): number => {
  const metadata = candidate ? scorePreferredPeer(candidate) : 0;
  const latencyScore =
    peer.latencyMs == null ? 0 : Math.max(0, 3000 - peer.latencyMs);
  const costScore = peer.cost == null ? 0 : Math.max(0, 2000 - peer.cost);
  const uptimeScore =
    peer.uptimeSec == null ? 0 : Math.min(600, Math.max(0, peer.uptimeSec)) / 2;
  const stateScore = peer.up ? 5000 : -1500;
  return stateScore + latencyScore + costScore + uptimeScore + metadata;
};

const parseGetPeersJson = (stdout: string): RuntimePeerEntry[] => {
  const raw = (stdout || '').trim();
  if (!raw) return [];

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const peersRaw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.peers)
      ? parsed.peers
      : Array.isArray(parsed?.response?.peers)
        ? parsed.response.peers
        : [];

  return peersRaw
    .filter((entry: any) => entry && typeof entry === 'object')
    .map((entry: any) => {
      const uri = normalizeUri(String(entry.remote || entry.uri || ''));
      return {
        uri,
        up: entry.up === true,
        inbound: entry.inbound === true,
        latencyMs: durationLikeToMs(entry.latency ?? entry.latency_ms),
        cost: numberLike(entry.cost),
        uptimeSec: numberLike(entry.uptime),
        lastError:
          typeof entry.last_error === 'string' && entry.last_error.trim()
            ? entry.last_error.trim()
            : null,
        lastErrorAgoMs: durationLikeToMs(entry.last_error_time),
      } satisfies RuntimePeerEntry;
    })
    .filter((entry: RuntimePeerEntry) => !!entry.uri);
};

const cloneStatus = (
  status: YggdrasilPeerAutoManagerStatus,
): YggdrasilPeerAutoManagerStatus => {
  return JSON.parse(JSON.stringify(status)) as YggdrasilPeerAutoManagerStatus;
};

export class YggdrasilPeerAutoManager {
  private timer: ReturnType<typeof setTimeout> | null = null;

  private running = false;

  private cycleInFlight = false;

  private status: YggdrasilPeerAutoManagerStatus = {
    running: false,
    enabled: true,
    cycleInFlight: false,
    nextRunAt: null,
    lastStartedAt: null,
    lastCycleAt: null,
    lastSuccessAt: null,
    lastReason: null,
    config: defaultYggdrasilAutoPeerManagerConfig(),
    pinnedPeers: [],
    connectedPublicPeers: [],
    managedConnectedPeers: [],
    selectedManagedPeers: [],
    recentEvents: [],
    lastCycleSummary: null,
  };

  constructor(private readonly deps: Dependencies) {}

  isStarted(): boolean {
    return this.running;
  }

  getStatus(): YggdrasilPeerAutoManagerStatus {
    this.refreshStaticStatus();
    return cloneStatus(this.status);
  }

  async start(reason: string): Promise<void> {
    if (this.running) return;
    if (!this.deps.isYggdrasilRunning()) return;

    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.running = false;
      this.status.running = false;
      this.status.enabled = false;
      this.recordEvent('info', '自动 peer 管理已禁用');
      return;
    }

    this.running = true;
    this.status.running = true;
    this.status.enabled = true;
    this.status.lastStartedAt = Date.now();
    this.status.lastReason = reason;
    this.recordEvent(
      'info',
      `自动 peer 管理已启动，目标 peer 数 ${cfg.targetPeerCount}`,
    );
    const restoredCount = await this.restorePersistedSelectedPeers(cfg);
    if (restoredCount > 0) {
      await sleep(Math.min(cfg.initialDelayMs, 3000));
      await this.runCycle(`${reason} warm restore`, false);
      this.scheduleNext(cfg.reconcileIntervalMs, 'periodic reconcile');
      return;
    }

    this.scheduleNext(cfg.initialDelayMs, reason);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.cycleInFlight = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.status.running = false;
    this.status.cycleInFlight = false;
    this.status.nextRunAt = null;
  }

  async reconcileNow(reason: string): Promise<YggdrasilPeerAutoManagerStatus> {
    if (!this.deps.isYggdrasilRunning()) {
      this.recordEvent('warn', '无法立即调度：Yggdrasil 未运行');
      return this.getStatus();
    }

    const cfg = this.getConfig();
    if (!cfg.enabled) {
      this.recordEvent('warn', '无法立即调度：自动 peer 管理已禁用');
      return this.getStatus();
    }

    if (!this.running) {
      await this.start(reason);
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.runCycle(reason, true);
    return this.getStatus();
  }

  private recordEvent(level: 'info' | 'warn', message: string): void {
    const event: YggdrasilPeerAutoManagerEvent = {
      at: Date.now(),
      level,
      message,
    };
    this.status.recentEvents = [event, ...this.status.recentEvents].slice(
      0,
      MAX_RECENT_EVENTS,
    );

    if (level === 'warn') {
      log.warn(`ygg-peer-auto-manager: ${message}`);
      return;
    }
    log.info(`ygg-peer-auto-manager: ${message}`);
  }

  private refreshStaticStatus(): void {
    const cfg = this.getConfig();
    const pinnedPeers = this.getPinnedPeers(cfg);
    this.status.config = cfg;
    this.status.enabled = cfg.enabled;
    this.status.running = this.running;
    this.status.cycleInFlight = this.cycleInFlight;
    this.status.pinnedPeers = [...pinnedPeers];
  }

  private getConfig(): ResolvedAutoPeerConfig {
    const cfg =
      reloadWtbConfig().yggdrasil?.autoPeerManager ||
      defaultYggdrasilAutoPeerManagerConfig();
    const defaults = defaultYggdrasilAutoPeerManagerConfig();
    const targetPeerCount = clampTargetPeerCount(
      cfg.targetPeerCount ?? defaults.targetPeerCount ?? 6,
    );
    return {
      enabled: cfg.enabled ?? defaults.enabled ?? true,
      targetPeerCount,
      initialDelayMs: cfg.initialDelayMs ?? defaults.initialDelayMs ?? 20000,
      reconcileIntervalMs:
        cfg.reconcileIntervalMs ?? defaults.reconcileIntervalMs ?? 900000,
      sampleSize: deriveProbePoolSize(targetPeerCount),
      probeAttempts: typeof cfg.probeAttempts === 'number' ? cfg.probeAttempts : defaults.probeAttempts ?? deriveProbeAttempts(targetPeerCount),
      probeIntervalMs: cfg.probeIntervalMs ?? defaults.probeIntervalMs ?? 1500,
      probeTimeoutMs: cfg.probeTimeoutMs ?? defaults.probeTimeoutMs ?? 5000,
      lastSelectedPeers: (cfg.lastSelectedPeers ?? []).map(normalizeUri),
      probeState: cfg.probeState ?? {},
    } satisfies ResolvedAutoPeerConfig;
  }

  private getManualReservedPeers(): Set<string> {
    const cfg = reloadWtbConfig();
    return new Set((cfg.yggdrasil?.publicPeers ?? []).map(normalizeUri));
  }

  private getPinnedPeers(
    cfg: ResolvedAutoPeerConfig,
    manualReservedPeers?: Set<string>,
  ): Set<string> {
    if (cfg.enabled) return new Set<string>();
    return manualReservedPeers ?? this.getManualReservedPeers();
  }

  private getPersistedSelectedPeers(cfg: ResolvedAutoPeerConfig): string[] {
    return Array.from(
      new Set((cfg.lastSelectedPeers ?? []).map(normalizeUri).filter((uri) => !!uri)),
    );
  }

  private getProbeStateMap(
    cfg: ResolvedAutoPeerConfig,
  ): Map<string, ProbeStateEntry> {
    const out = new Map<string, ProbeStateEntry>();
    for (const [uriRaw, entryRaw] of Object.entries(cfg.probeState ?? {})) {
      const uri = normalizeUri(uriRaw);
      if (!uri) continue;
      const entry = entryRaw as YggdrasilAutoPeerProbeState;
      out.set(uri, {
        region: normalizeRegion(entry.region),
        lastProbedAt:
          typeof entry.lastProbedAt === 'number' ? entry.lastProbedAt : null,
        lastLatencyMs:
          typeof entry.lastLatencyMs === 'number' ? entry.lastLatencyMs : null,
        lastScore: typeof entry.lastScore === 'number' ? entry.lastScore : null,
        reachable: entry.reachable === true,
        successCount:
          typeof entry.successCount === 'number' ? entry.successCount : 0,
        failureCount:
          typeof entry.failureCount === 'number' ? entry.failureCount : 0,
      });
    }
    return out;
  }

  private persistRuntimeState(
    selectedManagedPeers: string[],
    probeState: Map<string, ProbeStateEntry>,
  ): void {
    const normalizedSelected = Array.from(
      new Set(selectedManagedPeers.map(normalizeUri).filter((uri) => !!uri)),
    ).sort();
    const serializedProbeState: Record<string, YggdrasilAutoPeerProbeState> = {};
    for (const [uri, entry] of probeState.entries()) {
      serializedProbeState[uri] = {
        region: entry.region,
        lastProbedAt: entry.lastProbedAt ?? undefined,
        lastLatencyMs: entry.lastLatencyMs,
        lastScore: entry.lastScore,
        reachable: entry.reachable,
        successCount: entry.successCount,
        failureCount: entry.failureCount,
      };
    }

    setWtbYggdrasilAutoPeerManagerRuntimeState({
      lastSelectedPeers: normalizedSelected,
      probeState: serializedProbeState,
    });
  }

  private updateProbeState(
    probeState: Map<string, ProbeStateEntry>,
    uri: string,
    input: {
      region: string;
      reachable: boolean;
      latencyMs: number | null;
      score: number | null;
    },
  ): void {
    const previous = probeState.get(uri);
    probeState.set(uri, {
      region: input.region,
      lastProbedAt: Date.now(),
      lastLatencyMs: input.latencyMs,
      lastScore: input.score,
      reachable: input.reachable,
      successCount: (previous?.successCount ?? 0) + (input.reachable ? 1 : 0),
      failureCount: (previous?.failureCount ?? 0) + (input.reachable ? 0 : 1),
    });
  }

  private async restorePersistedSelectedPeers(
    cfg: ResolvedAutoPeerConfig,
  ): Promise<number> {
    const persistedPeers = this.getPersistedSelectedPeers(cfg);
    if (!persistedPeers.length) return 0;

    const runtimePeers = await this.getRuntimePeers(cfg.probeTimeoutMs).catch(() => []);
    const currentUris = new Set(runtimePeers.map((peer) => peer.uri));
    let restoredCount = 0;

    for (const uri of persistedPeers) {
      if (currentUris.has(uri)) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.addPeer(uri, cfg.probeTimeoutMs);
      restoredCount += 1;
    }

    this.status.selectedManagedPeers = persistedPeers;
    if (restoredCount > 0) {
      this.recordEvent('info', `已恢复上次自动挑选结果 ${restoredCount} 个 peer`);
    }
    return persistedPeers.length;
  }

  private scheduleNext(delayMs: number, reason: string): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);

    this.status.nextRunAt = Date.now() + Math.max(0, delayMs);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.runCycle(reason, true);
      },
      Math.max(0, delayMs),
    );
  }

  private async runCycle(
    reason: string,
    shouldReschedule: boolean,
  ): Promise<void> {
    if ((!this.running && shouldReschedule) || this.cycleInFlight) return;

    const cfg = this.getConfig();
    this.status.config = cfg;
    this.status.enabled = cfg.enabled;
    this.status.lastReason = reason;

    if (!cfg.enabled) {
      this.running = false;
      this.status.running = false;
      this.status.nextRunAt = null;
      return;
    }

    if (!this.deps.isYggdrasilRunning()) {
      this.recordEvent('warn', '跳过调度：Yggdrasil 未运行');
      if (shouldReschedule) {
        this.scheduleNext(cfg.reconcileIntervalMs, 'waiting for yggdrasil');
      }
      return;
    }

    this.cycleInFlight = true;
    this.status.cycleInFlight = true;
    this.status.lastCycleAt = Date.now();
    this.status.nextRunAt = null;

    try {
      const summary = await this.reconcileOnce(reason, cfg);
      this.status.lastCycleSummary = summary;
      this.status.connectedPublicPeers = summary.connectedPublicPeers;
      this.status.managedConnectedPeers = summary.managedConnectedPeers;
      this.status.selectedManagedPeers = summary.selectedManagedPeers;
      this.status.lastSuccessAt = summary.finishedAt;
      this.recordEvent(
        'info',
        `完成调度：固定 ${summary.pinnedUpCount}，目标动态 ${summary.desiredManagedCount}，新增 ${summary.addedPeers.length}，移除 ${summary.removedPeers.length}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.status.lastCycleSummary = {
        reason,
        startedAt: this.status.lastCycleAt ?? Date.now(),
        finishedAt: Date.now(),
        pinnedUpCount: 0,
        desiredManagedCount: 0,
        currentManagedCount: 0,
        selectedManagedPeers: [],
        addedPeers: [],
        removedPeers: [],
        connectedPublicPeers: [],
        managedConnectedPeers: [],
        probeSnapshots: [],
        error: message,
      };
      this.recordEvent('warn', `调度失败：${message}`);
    } finally {
      this.cycleInFlight = false;
      this.status.cycleInFlight = false;
      if (shouldReschedule && this.running) {
        this.scheduleNext(cfg.reconcileIntervalMs, 'periodic reconcile');
      }
    }
  }

  private async reconcileOnce(
    reason: string,
    cfg: ResolvedAutoPeerConfig,
  ): Promise<YggdrasilPeerAutoManagerCycleSummary> {
    const startedAt = Date.now();
    const manualReservedPeers = this.getManualReservedPeers();
    const pinnedPeers = this.getPinnedPeers(cfg, manualReservedPeers);
    this.status.pinnedPeers = [...pinnedPeers];

    const bundled = listPreferredPublicPeerNodes(this.deps.loadBundledPeers());
    if (!bundled.length) {
      const finishedAt = Date.now();
      this.recordEvent('warn', '跳过调度：没有可用的 bundled public peers');
      return {
        reason,
        startedAt,
        finishedAt,
        pinnedUpCount: 0,
        desiredManagedCount: 0,
        currentManagedCount: 0,
        selectedManagedPeers: [],
        addedPeers: [],
        removedPeers: [],
        connectedPublicPeers: [],
        managedConnectedPeers: [],
        probeSnapshots: [],
      };
    }

    const bundledCandidateByUri = new Map<string, PreferredPublicPeerNode>();
    const bundledCandidateByHostKey = new Map<string, PreferredPublicPeerNode>();
    for (const peer of bundled) {
      const uriKey = normalizeUri(peer.address);
      bundledCandidateByUri.set(uriKey, peer);
      try {
        const hostKey = deriveUriHostKey(peer.address);
        bundledCandidateByHostKey.set(hostKey, peer);
      } catch {
        // ignore
      }
    }
    const managedCandidates = bundled.filter((peer) => {
      const uri = normalizeUri(peer.address);
      return !pinnedPeers.has(uri) && !manualReservedPeers.has(uri);
    });
    const managedCandidateByUri = new Map<string, PreferredPublicPeerNode>();
    const managedCandidateByHostKey = new Map<string, PreferredPublicPeerNode>();
    for (const peer of managedCandidates) {
      const uriKey = normalizeUri(peer.address);
      managedCandidateByUri.set(uriKey, peer);
      try {
        const hostKey = deriveUriHostKey(peer.address);
        managedCandidateByHostKey.set(hostKey, peer);
      } catch {
        // ignore
      }
    }
    const findManagedCandidate = (uri: string): PreferredPublicPeerNode | undefined => {
      const byUri = managedCandidateByUri.get(uri);
      if (byUri) return byUri;
      try {
        const hk = deriveUriHostKey(uri);
        return managedCandidateByHostKey.get(hk);
      } catch {
        return undefined;
      }
    };
    const findBundledCandidate = (uri: string): PreferredPublicPeerNode | undefined => {
      const byUri = bundledCandidateByUri.get(uri);
      if (byUri) return byUri;
      try {
        const hk = deriveUriHostKey(uri);
        return bundledCandidateByHostKey.get(hk);
      } catch {
        return undefined;
      }
    };
    const runtimePeers = await this.getRuntimePeers(cfg.probeTimeoutMs);

    const connectedPublicPeers = runtimePeers
      .filter((peer) => {
        if (!peer.up) return false;
        if (bundledCandidateByUri.has(peer.uri)) return true;
        const hostKey = deriveUriHostKey(peer.uri);
        return bundledCandidateByHostKey.has(hostKey);
      })
      .map((peer) => peer.uri)
      .sort();

    const pinnedUpCount = runtimePeers.filter(
      (peer) => pinnedPeers.has(peer.uri) && peer.up,
    ).length;
    const desiredManagedCount = Math.max(
      0,
      cfg.targetPeerCount - pinnedUpCount,
    );

    const currentManagedPeers = runtimePeers.filter((peer) => {
      const uriKey = peer.uri;
      const hostKey = deriveUriHostKey(peer.uri);
      const isManaged = managedCandidateByUri.has(uriKey) || managedCandidateByHostKey.has(hostKey);
      if (!isManaged) return false;
      if (pinnedPeers.has(peer.uri)) return false;
      return true;
    });

    const currentManagedUp = currentManagedPeers
      .filter((peer) => peer.up && !peer.inbound)
      .sort(
        (left, right) =>
          scoreRuntimePeer(right, findManagedCandidate(right.uri)) -
          scoreRuntimePeer(left, findManagedCandidate(left.uri)),
      );

    const probeState = this.getProbeStateMap(cfg);

    const desiredManagedUris = new Set<string>(
      currentManagedUp.slice(0, desiredManagedCount).map((peer) => peer.uri),
    );

    const probeSnapshots: YggdrasilPeerAutoManagerProbeSnapshot[] = [];
    const attemptedUris = new Set<string>();
    if (desiredManagedUris.size < desiredManagedCount) {
      const missingCount = desiredManagedCount - desiredManagedUris.size;
      const bootstrapAttempts = await this.probeCandidatesInRounds(
        managedCandidates,
        currentManagedPeers,
        desiredManagedUris,
        missingCount,
        cfg,
        probeState,
        attemptedUris,
        'bootstrap',
        3,
        cfg.sampleSize,
      );
      for (const attempt of bootstrapAttempts) {
        const uri = normalizeUri(attempt.candidate.address);
        attemptedUris.add(uri);
        if (attempt.result && desiredManagedUris.size < desiredManagedCount) {
          desiredManagedUris.add(attempt.result.uri);
          probeSnapshots.push({
            uri: attempt.result.uri,
            region: attempt.result.region,
            latencyMs: attempt.result.latencyMs,
            cost: attempt.result.cost,
            uptimeSec: attempt.result.uptimeSec,
            score: attempt.result.score,
            outcome: 'selected',
          });
          continue;
        }

        probeSnapshots.push({
          uri,
          region: normalizeRegion(attempt.candidate.region),
          latencyMs: attempt.result?.latencyMs ?? null,
          cost: attempt.result?.cost ?? null,
          uptimeSec: attempt.result?.uptimeSec ?? null,
          score:
            attempt.result?.score ??
            probeState.get(uri)?.lastScore ??
            scorePreferredPeer(attempt.candidate),
          outcome: attempt.result ? 'rejected' : 'failed',
        });
      }
    }

    if (desiredManagedUris.size >= desiredManagedCount && desiredManagedCount > 0) {
      const maintenanceAttempts = await this.probeCandidatesInRounds(
        managedCandidates,
        currentManagedPeers,
        desiredManagedUris,
        Math.max(1, Math.ceil(cfg.targetPeerCount / 2)),
        cfg,
        probeState,
        attemptedUris,
        'maintenance',
        2,
        Math.max(2, Math.ceil(cfg.targetPeerCount / 2)),
      );

      const selectedManagedPeers = currentManagedUp
        .filter((peer) => desiredManagedUris.has(peer.uri))
        .sort(
          (left, right) =>
            scoreRuntimePeer(left, findManagedCandidate(left.uri)) -
            scoreRuntimePeer(right, findManagedCandidate(right.uri)),
        );

      for (const attempt of maintenanceAttempts) {
        const uri = normalizeUri(attempt.candidate.address);
        attemptedUris.add(uri);

        if (!attempt.result) {
          probeSnapshots.push({
            uri,
            region: normalizeRegion(attempt.candidate.region),
            latencyMs: null,
            cost: null,
            uptimeSec: null,
            score:
              probeState.get(uri)?.lastScore ?? scorePreferredPeer(attempt.candidate),
            outcome: 'failed',
          });
          continue;
        }

        const currentWorst = selectedManagedPeers[0];
        const currentWorstScore = currentWorst
          ? scoreRuntimePeer(currentWorst, findManagedCandidate(currentWorst.uri))
          : Number.NEGATIVE_INFINITY;
        const latencyImprovement =
          currentWorst?.latencyMs != null && attempt.result.latencyMs != null
            ? currentWorst.latencyMs - attempt.result.latencyMs
            : 0;
        const shouldReplace =
          !!currentWorst &&
          !desiredManagedUris.has(attempt.result.uri) &&
          (latencyImprovement >= 40 || attempt.result.score >= currentWorstScore + 200);

        if (!shouldReplace) {
          probeSnapshots.push({
            uri: attempt.result.uri,
            region: attempt.result.region,
            latencyMs: attempt.result.latencyMs,
            cost: attempt.result.cost,
            uptimeSec: attempt.result.uptimeSec,
            score: attempt.result.score,
            outcome: 'rejected',
          });
          continue;
        }

        desiredManagedUris.delete(currentWorst.uri);
        desiredManagedUris.add(attempt.result.uri);
        selectedManagedPeers.shift();
        selectedManagedPeers.push(attempt.result);
        selectedManagedPeers.sort(
          (left, right) =>
            scoreRuntimePeer(left, findManagedCandidate(left.uri)) -
            scoreRuntimePeer(right, findManagedCandidate(right.uri)),
        );

        probeSnapshots.push({
          uri: attempt.result.uri,
          region: attempt.result.region,
          latencyMs: attempt.result.latencyMs,
          cost: attempt.result.cost,
          uptimeSec: attempt.result.uptimeSec,
          score: attempt.result.score,
          outcome: 'selected',
        });
        this.recordEvent(
          'info',
          `发现更优 peer，准备使用 ${attempt.result.uri} 替换 ${currentWorst.uri}`,
        );
      }
    }

    // 1) 先移除在 getpeers 中未连接成功的非本地（非 inbound）bundled peers
    const unreachableBundled = runtimePeers.filter((peer) => {
      if (!findBundledCandidate(peer.uri)) return false;
      if (pinnedPeers.has(peer.uri)) return false;
      if (peer.inbound) return false; // 忽略局域网/本地入站连接
      return !peer.up; // 未连接成功的 peer
    });

    const removedPeers: string[] = [];
    for (const peer of unreachableBundled) {
      await this.removePeer(peer.uri, cfg.probeTimeoutMs);
      removedPeers.push(peer.uri);
    }

    // 2) 如果剩余已连接成功的 managed peers 超过目标数量，按延迟从高到低移除多余的 peer
    const connectedManaged = runtimePeers.filter((peer) => {
      if (!findBundledCandidate(peer.uri)) return false;
      if (pinnedPeers.has(peer.uri)) return false;
      if (peer.inbound) return false; // 忽略局域网/本地入站连接
      const isManaged = !!findManagedCandidate(peer.uri);
      return peer.up && isManaged;
    });

    if (connectedManaged.length > desiredManagedCount) {
      const toRemoveCount = connectedManaged.length - desiredManagedCount;
      // 把 latency 为 null 的视作最大延迟，排在前面
      const sortedByLatencyDesc = [...connectedManaged].sort((a, b) => {
        const aLat = a.latencyMs == null ? Number.POSITIVE_INFINITY : a.latencyMs;
        const bLat = b.latencyMs == null ? Number.POSITIVE_INFINITY : b.latencyMs;
        return bLat - aLat;
      });
      for (let i = 0; i < toRemoveCount; i += 1) {
        const peer = sortedByLatencyDesc[i];
        if (!peer) break;
        // 如果该 peer 是期望保留的，跳过
        if (desiredManagedUris.has(peer.uri)) continue;
        await this.removePeer(peer.uri, cfg.probeTimeoutMs);
        removedPeers.push(peer.uri);
      }
    }

    const currentUris = new Set(currentManagedPeers.map((peer) => peer.uri));
    const addedPeers: string[] = [];
    for (const uri of desiredManagedUris) {
      if (currentUris.has(uri)) continue;
      await this.addPeer(uri, cfg.probeTimeoutMs);
      addedPeers.push(uri);
    }

    const finishedAt = Date.now();
    this.persistRuntimeState([...desiredManagedUris].sort(), probeState);
    return {
      reason,
      startedAt,
      finishedAt,
      pinnedUpCount,
      desiredManagedCount,
      currentManagedCount: currentManagedPeers.length,
      selectedManagedPeers: [...desiredManagedUris].sort(),
      addedPeers,
      removedPeers,
      connectedPublicPeers,
      managedConnectedPeers: currentManagedPeers
        .filter((peer) => peer.up)
        .map((peer) => peer.uri)
        .sort(),
      probeSnapshots,
    };
  }

  private buildProbePool(
    candidates: PreferredPublicPeerNode[],
    currentManagedPeers: RuntimePeerEntry[],
    desiredManagedUris: Set<string>,
    sampleSize: number,
    mode: ProbePoolMode,
    probeState: Map<string, ProbeStateEntry>,
    attemptedUris: Set<string>,
  ): PreferredPublicPeerNode[] {
    const currentUris = new Set(currentManagedPeers.map((peer) => peer.uri));

    const availableCandidates = candidates.filter((candidate) => {
      const uri = normalizeUri(candidate.address);
      return !desiredManagedUris.has(uri) && !attemptedUris.has(uri);
    });

    if (mode === 'maintenance') {
      return availableCandidates
        .sort((left, right) => {
          const leftUri = normalizeUri(left.address);
          const rightUri = normalizeUri(right.address);
          const leftState = probeState.get(leftUri);
          const rightState = probeState.get(rightUri);
          const leftProbed = leftState ? 1 : 0;
          const rightProbed = rightState ? 1 : 0;
          if (leftProbed !== rightProbed) return leftProbed - rightProbed;

          const leftLatency = leftState?.lastLatencyMs ?? Number.POSITIVE_INFINITY;
          const rightLatency = rightState?.lastLatencyMs ?? Number.POSITIVE_INFINITY;
          if (leftLatency !== rightLatency) return leftLatency - rightLatency;

          return scorePreferredPeer(right) - scorePreferredPeer(left);
        })
        .slice(0, sampleSize);
    }

    const groups = new Map<string, PreferredPublicPeerNode[]>();

    for (const candidate of availableCandidates) {
      const uri = normalizeUri(candidate.address);
      if (desiredManagedUris.has(uri)) continue;
      const region = normalizeRegion(candidate.region);
      const list = groups.get(region) || [];
      list.push(candidate);
      groups.set(region, list);
    }

    for (const list of groups.values()) {
      list.sort((left, right) => {
        const leftUri = normalizeUri(left.address);
        const rightUri = normalizeUri(right.address);
        const liveBonusLeft = currentUris.has(leftUri) ? 2000 : 0;
        const liveBonusRight = currentUris.has(rightUri) ? 2000 : 0;
        const cachedBonusLeft = probeState.get(leftUri)?.reachable ? 400 : 0;
        const cachedBonusRight = probeState.get(rightUri)?.reachable ? 400 : 0;
        return (
          scorePreferredPeer(right) +
          cachedBonusRight +
          liveBonusRight -
          scorePreferredPeer(left) -
          cachedBonusLeft -
          liveBonusLeft
        );
      });
    }

    const pool: PreferredPublicPeerNode[] = [];
    const regions = [...groups.keys()].sort(
      (left, right) =>
        getBootstrapRegionPriority(left) - getBootstrapRegionPriority(right),
    );
    while (pool.length < sampleSize) {
      let advanced = false;
      for (const region of regions) {
        const list = groups.get(region);
        if (!list?.length) continue;
        pool.push(list.shift()!);
        advanced = true;
        if (pool.length >= sampleSize) break;
      }
      if (!advanced) break;
    }

    return pool;
  }

  private async probeCandidatesInRounds(
    candidates: PreferredPublicPeerNode[],
    currentManagedPeers: RuntimePeerEntry[],
    desiredManagedUris: Set<string>,
    neededCount: number,
    cfg: ResolvedAutoPeerConfig,
    probeState: Map<string, ProbeStateEntry>,
    attemptedUris: Set<string>,
    mode: ProbePoolMode,
    maxRounds: number,
    roundSampleSize: number,
  ): Promise<ProbeAttempt[]> {
    const attempts: ProbeAttempt[] = [];
    let successfulCount = 0;

    for (let round = 0; round < maxRounds; round += 1) {
      if (successfulCount >= neededCount) break;

      const probePool = this.buildProbePool(
        candidates,
        currentManagedPeers,
        desiredManagedUris,
        roundSampleSize,
        mode,
        probeState,
        attemptedUris,
      );
      if (!probePool.length) break;

      log.info(
        `ygg-peer-auto-manager: ${mode} probe round ${round + 1}/${maxRounds} pool=${probePool.length} need=${Math.max(0, neededCount - successfulCount)}`,
      );

      const roundAttempts = await this.probeCandidates(
        probePool,
        neededCount - successfulCount,
        cfg,
        desiredManagedUris,
        probeState,
      );

      for (const attempt of roundAttempts) {
        attempts.push(attempt);
        attemptedUris.add(normalizeUri(attempt.candidate.address));
        if (attempt.result) {
          successfulCount += 1;
        }
      }
    }

    return attempts;
  }

  private async probeCandidates(
    candidates: PreferredPublicPeerNode[],
    neededCount: number,
    cfg: ResolvedAutoPeerConfig,
    alreadySelected: Set<string>,
    probeState: Map<string, ProbeStateEntry>,
  ): Promise<ProbeAttempt[]> {
    const results: ProbeAttempt[] = [];
    // 并发度：不超过候选数量，并受配置上限约束
    const concurrency = Math.min(
      candidates.length,
      Math.max(2, Math.min(8, Math.floor(cfg.sampleSize / 2))),
    );

    const pool: Promise<void>[] = [];
    let stopped = false;

    const runProbe = async (candidate: PreferredPublicPeerNode) => {
      if (stopped) return;
      const uri = normalizeUri(candidate.address);
      if (alreadySelected.has(uri)) return;
      const sampled = await this.probeCandidate(candidate, cfg, probeState);
      results.push(sampled);
      if (sampled.result) {
        const selectedCount = results.filter((r) => !!r.result).length;
        if (selectedCount >= neededCount) {
          stopped = true;
        }
      }
    };

    for (let i = 0; i < candidates.length; i += 1) {
      if (stopped) break;
      const candidate = candidates[i];
      // simple concurrency gate: 当并发达到上限时，等待任一任务完成后再继续
      while (pool.length >= concurrency) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race(pool);
      }
      const p = runProbe(candidate).finally(() => {
        const idx = pool.indexOf(p);
        if (idx >= 0) pool.splice(idx, 1);
      });
      pool.push(p);
      // 不在此处 await p，以便能并行启动更多探测任务
    }

    // 等待所有并发任务完成
    await Promise.allSettled(pool);

    return results.sort(
      (left, right) =>
        (right.result?.score ?? Number.NEGATIVE_INFINITY) -
        (left.result?.score ?? Number.NEGATIVE_INFINITY),
    );
  }

  private async probeCandidate(
    candidate: PreferredPublicPeerNode,
    cfg: ResolvedAutoPeerConfig,
    probeState: Map<string, ProbeStateEntry>,
  ): Promise<ProbeAttempt> {
    const uri = normalizeUri(candidate.address);
    const region = normalizeRegion(candidate.region);
    log.info(
      `ygg-peer-auto-manager: probing candidate (direct network) uri=${uri} region=${region} attempts=${cfg.probeAttempts}`,
    );

    const samples: RuntimePeerEntry[] = [];

    const testOnce = async (): Promise<RuntimePeerEntry | null> => {
      try {
        const start = Date.now();
        let u: URL | null = null;
        try {
          u = new URL(candidate.address);
        } catch {
          u = null;
        }
        if (!u || !u.hostname) return null;
        const scheme = (u.protocol || '').replace(':', '') || candidate.scheme || '';
        let port = Number(u.port || 0) || undefined;
        if (!port) {
          if (scheme === 'tls' || scheme === 'wss') port = 443;
          else if (scheme === 'quic') port = 443;
          else if (scheme === 'ws' || scheme === 'tcp') port = 80;
          else port = 443;
        }

        const host = u.hostname;

        return await new Promise<RuntimePeerEntry | null>(async (resolve) => {
          let settled = false;
          const onSuccess = (latencyMs: number) => {
            if (settled) return;
            settled = true;
            resolve({
              uri,
              up: true,
              inbound: false,
              latencyMs,
              cost: null,
              uptimeSec: null,
              lastError: null,
              lastErrorAgoMs: null,
            });
          };

          const onFail = (errMsg: string) => {
            if (settled) return;
            settled = true;
            resolve({
              uri,
              up: false,
              inbound: false,
              latencyMs: null,
              cost: null,
              uptimeSec: null,
              lastError: errMsg,
              lastErrorAgoMs: Date.now() - start,
            });
          };

          const timeoutHandle = setTimeout(() => {
            onFail('timeout');
          }, cfg.probeTimeoutMs);

          if (scheme === 'tls' || scheme === 'wss') {
            const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false }, () => {
              const latency = Date.now() - start;
              clearTimeout(timeoutHandle);
              socket.end();
              onSuccess(latency);
            });
            // ensure socket won't hang forever
            socket.setTimeout(cfg.probeTimeoutMs, () => {
              try { socket.destroy(); } catch {}
            });
            socket.on('error', (err) => {
              // If TLS handshake fails, treat as TCP-reachable fallback: try raw TCP connect
              const msg = String(err && (err.message || err) || '');
              const isHandshakeFailure = /handshake|SSLV3_ALERT_HANDSHAKE_FAILURE|SSL routines/i.test(msg);
              if (isHandshakeFailure) {
                try {
                  const tcpStart = Date.now();
                  const tcpSock = net.connect({ host, port, timeout: Math.max(250, cfg.probeTimeoutMs) }, () => {
                    const latency = Date.now() - tcpStart;
                    clearTimeout(timeoutHandle);
                    try { tcpSock.end(); } catch {}
                    onSuccess(latency);
                  });
                  tcpSock.on('error', (e) => {
                    clearTimeout(timeoutHandle);
                    onFail(String(e && (e.message || e) || msg));
                  });
                  tcpSock.setTimeout(Math.max(250, cfg.probeTimeoutMs), () => {
                    try { tcpSock.destroy(); } catch {}
                    clearTimeout(timeoutHandle);
                    onFail(msg);
                  });
                } catch (e) {
                  clearTimeout(timeoutHandle);
                  onFail(msg);
                }
                return;
              }
              clearTimeout(timeoutHandle);
              onFail(msg);
            });
          } else if (scheme === 'ws' || scheme === 'tcp') {
            const socket = net.connect({ host, port, timeout: cfg.probeTimeoutMs }, () => {
              const latency = Date.now() - start;
              clearTimeout(timeoutHandle);
              socket.end();
              onSuccess(latency);
            });
            socket.on('error', (err) => {
              clearTimeout(timeoutHandle);
              onFail(String(err.message || err));
            });
          } else if (scheme === 'quic') {
            // QUIC probing: prefer a native QUIC library when available for a proper handshake-based probe.
            try {
              let used = false;
              try {
                // try common node quic libs; this file uses dynamic require so missing module won't crash startup
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const nodeQuic = require('node-quic');
                if (nodeQuic) {
                  // attempt several common APIs
                  if (typeof nodeQuic.connect === 'function') {
                    await Promise.race([
                      nodeQuic.connect({ address: host, port }).then(() => {
                        clearTimeout(timeoutHandle);
                        onSuccess(Date.now() - start);
                      }),
                      new Promise((res) => setTimeout(res, cfg.probeTimeoutMs)),
                    ] as any);
                    used = true;
                  } else if (typeof nodeQuic.createSocket === 'function') {
                    const sock = nodeQuic.createSocket({ endpoint: { address: '0.0.0.0' } });
                    const session = await Promise.race([
                      sock.connect({ address: host, port }),
                      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), cfg.probeTimeoutMs)),
                    ] as any);
                    if (session) {
                      try { session.close(); } catch {}
                      clearTimeout(timeoutHandle);
                      onSuccess(Date.now() - start);
                      used = true;
                    }
                  }
                }
              } catch (e) {
                // fall through to UDP fallback
              }

              if (!used) {
                // UDP fallback: send a small packet and treat no immediate error as reachable (best-effort)
                const dgram = require('dgram');
                const sock = dgram.createSocket('udp4');
                let sent = false;
                sock.send(Buffer.from('ping'), port, host, (err: Error | null) => {
                  if (err) {
                    sent = false;
                    clearTimeout(timeoutHandle);
                    sock.close();
                    onFail(String(err.message || err));
                    return;
                  }
                  sent = true;
                  clearTimeout(timeoutHandle);
                  sock.close();
                  onSuccess(Date.now() - start);
                });
                sock.on('error', (e: Error) => {
                  clearTimeout(timeoutHandle);
                  sock.close();
                  onFail(String(e.message || e));
                });
                // if send didn't call back quickly, rely on timeoutHandle to fire
              }
            } catch (e) {
              clearTimeout(timeoutHandle);
              onFail(String(e || 'quic probe failed'));
            }
          } else {
            // unknown scheme, fallback to TCP
            const socket = net.connect({ host, port, timeout: cfg.probeTimeoutMs }, () => {
              const latency = Date.now() - start;
              clearTimeout(timeoutHandle);
              socket.end();
              onSuccess(latency);
            });
            socket.on('error', (err) => {
              clearTimeout(timeoutHandle);
              onFail(String(err.message || err));
            });
          }
        });
      } catch (err) {
        return null;
      }
    };

    for (let attempt = 0; attempt < cfg.probeAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(cfg.probeIntervalMs);
      }
      // eslint-disable-next-line no-await-in-loop
      const sample = await testOnce();
      if (!sample) continue;
      if (sample.up) {
        samples.push(sample);
        // log.info(
        //   `ygg-peer-auto-manager: probe sample success uri=${uri} attempt=${attempt + 1}/${cfg.probeAttempts} ${formatProbeMetric('latencyMs', sample.latencyMs)}`,
        // );
        continue;
      }
      log.info(
        `ygg-peer-auto-manager: probe sample failed uri=${uri} attempt=${attempt + 1}/${cfg.probeAttempts} lastError=${sample.lastError} configured timeout=${cfg.probeTimeoutMs}ms`,
      );
    }

    if (!samples.length) {
      this.updateProbeState(probeState, uri, {
        region,
        reachable: false,
        latencyMs: null,
        score: null,
      });
      log.warn(
        `ygg-peer-auto-manager: probe candidate unreachable (direct) uri=${uri} region=${region}`,
      );
      return {
        candidate,
        result: null,
      };
    }

    const averaged = this.averageSamples(uri, samples);
    const score = scoreRuntimePeer(averaged, candidate);
    this.updateProbeState(probeState, uri, {
      region,
      reachable: true,
      latencyMs: averaged.latencyMs,
      score,
    });
    log.info(
      `ygg-peer-auto-manager: probe candidate selected (direct) uri=${uri} region=${region} samples=${samples.length}/${cfg.probeAttempts} ${formatProbeMetric('avgLatencyMs', averaged.latencyMs)}`,
    );
    return {
      candidate,
      result: {
        ...averaged,
        address: candidate.address,
        region,
        score,
      },
    };
  }

  private averageSamples(
    uri: string,
    samples: RuntimePeerEntry[],
  ): RuntimePeerEntry {
    const latencyValues = samples
      .map((sample) => sample.latencyMs)
      .filter((value): value is number => value != null);
    const costValues = samples
      .map((sample) => sample.cost)
      .filter((value): value is number => value != null);
    const uptimeValues = samples
      .map((sample) => sample.uptimeSec)
      .filter((value): value is number => value != null);

    const average = (values: number[]): number | null => {
      if (!values.length) return null;
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    };

    return {
      uri,
      up: true,
      inbound: false,
      latencyMs: average(latencyValues),
      cost: average(costValues),
      uptimeSec: average(uptimeValues),
      lastError: null,
      lastErrorAgoMs: null,
    };
  }

  private async getRuntimePeers(
    timeoutMs: number,
  ): Promise<RuntimePeerEntry[]> {
    const result = await this.deps.invokeCtl('getpeersjson', [], { timeoutMs });
    if (!result.ok) {
      throw new Error(result.stderr || 'yggdrasilctl getpeersjson failed');
    }
    return parseGetPeersJson(result.stdout);
  }

  private async addPeer(uri: string, timeoutMs: number): Promise<void> {
    const result = await this.deps.invokeCtl('addpeer', [`uri=${uri}`], {
      timeoutMs,
    });
    if (!result.ok) {
      log.debug(`Failed to add yggdrasil peer at auto_manager: ${uri}`, {
        stderr: result.stderr,
        stdout: result.stdout,
        command: result.command,
      });
    }
    if (result.ok) {
      // log.info(`ygg-peer-auto-manager: added peer uri=${uri} successfully`);
    }
  }

  private async removePeer(uri: string, timeoutMs: number): Promise<void> {
    const result = await this.deps.invokeCtl('removepeer', [`uri=${uri}`], {
      timeoutMs,
    });
    if (!result.ok) {
      log.warn(`Failed to remove yggdrasil peer at auto_manager: ${uri}`, {
        stderr: result.stderr,
        stdout: result.stdout,
        command: result.command,
      });
    }
    if (result.ok) {
      log.info(`ygg-peer-auto-manager: removed peer uri=${uri} successfully`);
    }
  }
}
