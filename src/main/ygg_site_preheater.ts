import net from 'net';

import { WebsiteIndexService, extractWebsiteIndexUrls } from './website_index_service';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

export type YggSitePreheaterSeedTarget = {
  url: string;
  probeTimeoutMs?: number;
  probeAttempts?: number;
};

export type YggSitePreheaterStaticTarget = {
  url: string;
  probeTimeoutMs?: number;
  probeAttempts?: number;
};

type ProbeSource = 'seed' | 'static' | 'index';

type ProbeTarget = {
  key: string;
  host: string;
  port: number;
  sources: Set<ProbeSource>;
  lastProbedAt: number | null;
  lastSucceededAt: number | null;
  failureCount: number;
  nextProbeAt: number;
  probeTimeoutMs: number;
  probeAttempts: number;
};

export type YggSitePreheaterStatus = {
  enabled: boolean;
  running: boolean;
  activeWorkers: number;
  knownTargets: number;
  queuedTargets: number;
  seedTargets: number;
  staticTargets: number;
  discoveredTargets: number;
  lastDiscoveryAt: number | null;
  lastProbeAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
};

const DISCOVERY_INTERVAL_MS = 30 * 60_000;
const PROBE_TICK_MS = 5_000;
const INITIAL_DELAY_MS = 15_000;
const PROBE_TIMEOUT_MS = 3_500;
const PROBE_CONCURRENCY = 3;
const PROBE_RETRY_DELAY_MS = 1_500;
const SUCCESS_BACKOFF_MS = 30 * 60_000;
const FAILURE_BASE_BACKOFF_MS = 2 * 60_000;
const FAILURE_MAX_BACKOFF_MS = 60 * 60_000;

const dedupeSeedTargets = (
  values: YggSitePreheaterSeedTarget[],
): YggSitePreheaterSeedTarget[] => {
  const map = new Map<string, YggSitePreheaterSeedTarget>();
  values.forEach((value) => {
    const key = (value.url || '').trim();
    if (!key) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, value);
      return;
    }
    map.set(key, {
      url: key,
      probeTimeoutMs: Math.max(
        existing.probeTimeoutMs ?? 0,
        value.probeTimeoutMs ?? 0,
      ) || undefined,
      probeAttempts: Math.max(
        existing.probeAttempts ?? 0,
        value.probeAttempts ?? 0,
      ) || undefined,
    });
  });
  return Array.from(map.values());
};

const normalizeTargetFromUrl = (
  rawUrl: string,
): { key: string; host: string; port: number } | null => {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const host = (parsed.hostname || '').trim();
    if (!host) return null;
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return null;
    }
    return {
      key: `${host}:${port}`,
      host,
      port,
    };
  } catch {
    return null;
  }
};

export class YggSitePreheater {
  private readonly targets = new Map<string, ProbeTarget>();

  private running = false;

  private enabled = false;

  private activeWorkers = 0;

  private discoverTimer: NodeJS.Timeout | null = null;

  private probeTimer: NodeJS.Timeout | null = null;

  private lastDiscoveryAt: number | null = null;

  private lastProbeAt: number | null = null;

  private lastSuccessAt: number | null = null;

  private lastError: string | null = null;

  constructor(
    private readonly options: {
      logger: LoggerLike;
      websiteIndexService: WebsiteIndexService;
      seedTargets: YggSitePreheaterSeedTarget[];
      staticTargets: YggSitePreheaterStaticTarget[];
      isYggdrasilRunning: () => boolean;
      isEnabled: () => boolean;
    },
  ) {}

  getStatus(): YggSitePreheaterStatus {
    const values = Array.from(this.targets.values());
    const now = Date.now();
    return {
      enabled: this.enabled,
      running: this.running,
      activeWorkers: this.activeWorkers,
      knownTargets: values.length,
      queuedTargets: values.filter((item) => item.nextProbeAt <= now).length,
      seedTargets: values.filter((item) => item.sources.has('seed')).length,
      staticTargets: values.filter((item) => item.sources.has('static')).length,
      discoveredTargets: values.filter((item) => item.sources.has('index')).length,
      lastDiscoveryAt: this.lastDiscoveryAt,
      lastProbeAt: this.lastProbeAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  syncEnabled(reason: string): void {
    this.enabled = this.options.isEnabled();
    if (!this.enabled) {
      this.stop(`${reason}: disabled`);
      return;
    }

    if (!this.options.isYggdrasilRunning()) {
      this.stop(`${reason}: waiting for yggdrasil`);
      return;
    }

    this.start(reason);
  }

  start(reason: string): void {
    this.enabled = this.options.isEnabled();
    if (!this.enabled || !this.options.isYggdrasilRunning()) {
      return;
    }
    if (this.running) return;

    this.running = true;
    this.lastError = null;
    this.configureTargets();
    this.scheduleDiscovery(Math.min(INITIAL_DELAY_MS, DISCOVERY_INTERVAL_MS));
    this.scheduleProbeTick(PROBE_TICK_MS);
    this.options.logger.info(`ygg site preheater started (${reason})`);
  }

  stop(reason: string): void {
    if (!this.running && !this.discoverTimer && !this.probeTimer) {
      this.enabled = this.options.isEnabled();
      return;
    }

    this.running = false;
    if (this.discoverTimer) {
      clearTimeout(this.discoverTimer);
      this.discoverTimer = null;
    }
    if (this.probeTimer) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.options.logger.info(`ygg site preheater stopped (${reason})`);
  }

  private scheduleDiscovery(delayMs: number): void {
    if (!this.running) return;
    if (this.discoverTimer) clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => {
      this.discoverTimer = null;
      void this.refreshDiscoveredTargets();
    }, Math.max(0, delayMs));
  }

  private scheduleProbeTick(delayMs: number): void {
    if (!this.running) return;
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.runProbeTick();
    }, Math.max(0, delayMs));
  }

  private configureTargets(): void {
    dedupeSeedTargets(this.options.seedTargets)
      .map((target) => {
        const normalized = normalizeTargetFromUrl(target.url);
        if (!normalized) return null;
        return {
          ...normalized,
          probeTimeoutMs: target.probeTimeoutMs,
          probeAttempts: target.probeAttempts,
        };
      })
      .filter(
        (
          item,
        ): item is {
          key: string;
          host: string;
          port: number;
          probeTimeoutMs?: number;
          probeAttempts?: number;
        } => !!item,
      )
      .forEach((target) => {
        this.upsertTarget(target.host, target.port, 'seed', {
          probeTimeoutMs: target.probeTimeoutMs,
          probeAttempts: target.probeAttempts,
        });
      });

    dedupeSeedTargets(this.options.staticTargets)
      .map((target) => {
        const normalized = normalizeTargetFromUrl(target.url);
        if (!normalized) return null;
        return {
          ...normalized,
          probeTimeoutMs: target.probeTimeoutMs,
          probeAttempts: target.probeAttempts,
        };
      })
      .filter(
        (
          item,
        ): item is {
          key: string;
          host: string;
          port: number;
          probeTimeoutMs?: number;
          probeAttempts?: number;
        } => !!item,
      )
      .forEach((target) => {
        this.upsertTarget(target.host, target.port, 'static', {
          probeTimeoutMs: target.probeTimeoutMs,
          probeAttempts: target.probeAttempts,
        });
      });
  }

  private async refreshDiscoveredTargets(): Promise<void> {
    if (!this.running || !this.options.isYggdrasilRunning()) {
      this.scheduleDiscovery(DISCOVERY_INTERVAL_MS);
      return;
    }

    this.configureTargets();

    try {
      const result = await this.options.websiteIndexService.loadIndex();
      const urls = extractWebsiteIndexUrls(result.data);
      urls
        .map((url) => normalizeTargetFromUrl(url))
        .filter((item): item is { key: string; host: string; port: number } => !!item)
        .forEach((target) => {
          this.upsertTarget(target.host, target.port, 'index');
        });
      this.lastDiscoveryAt = Date.now();
      this.lastError = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.options.logger.warn('ygg site preheater discovery failed', error);
    } finally {
      this.scheduleDiscovery(DISCOVERY_INTERVAL_MS);
    }
  }

  private upsertTarget(
    host: string,
    port: number,
    source: ProbeSource,
    policy?: { probeTimeoutMs?: number; probeAttempts?: number },
  ): void {
    const key = `${host}:${port}`;
    const existing = this.targets.get(key);
    if (existing) {
      existing.sources.add(source);
      existing.nextProbeAt = Math.min(existing.nextProbeAt, Date.now());
      existing.probeTimeoutMs = Math.max(
        existing.probeTimeoutMs,
        policy?.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      );
      existing.probeAttempts = Math.max(
        existing.probeAttempts,
        policy?.probeAttempts ?? 1,
      );
      return;
    }

    this.targets.set(key, {
      key,
      host,
      port,
      sources: new Set<ProbeSource>([source]),
      lastProbedAt: null,
      lastSucceededAt: null,
      failureCount: 0,
      nextProbeAt: Date.now(),
      probeTimeoutMs: Math.max(PROBE_TIMEOUT_MS, policy?.probeTimeoutMs ?? 0),
      probeAttempts: Math.max(1, policy?.probeAttempts ?? 1),
    });
  }

  private async runProbeTick(): Promise<void> {
    if (!this.running || !this.options.isYggdrasilRunning()) {
      this.scheduleProbeTick(PROBE_TICK_MS);
      return;
    }

    const now = Date.now();
    const readyTargets = Array.from(this.targets.values())
      .filter((item) => item.nextProbeAt <= now)
      .sort((left, right) => left.nextProbeAt - right.nextProbeAt);

    while (this.activeWorkers < PROBE_CONCURRENCY && readyTargets.length > 0) {
      const next = readyTargets.shift();
      if (!next) break;
      this.activeWorkers += 1;
      void this.probeTarget(next)
        .catch(() => {
          // ignore; probeTarget updates state
        })
        .finally(() => {
          this.activeWorkers = Math.max(0, this.activeWorkers - 1);
        });
    }

    this.scheduleProbeTick(PROBE_TICK_MS);
  }

  private async probeTarget(target: ProbeTarget): Promise<void> {
    const startedAt = Date.now();
    this.lastProbeAt = startedAt;
    try {
      await this.tcpProbe(
        target.host,
        target.port,
        target.probeTimeoutMs,
        target.probeAttempts,
      );
      target.lastProbedAt = startedAt;
      target.lastSucceededAt = startedAt;
      target.failureCount = 0;
      target.nextProbeAt = startedAt + SUCCESS_BACKOFF_MS;
      this.lastSuccessAt = startedAt;
      this.lastError = null;
    } catch (error) {
      target.lastProbedAt = startedAt;
      target.failureCount += 1;
      const backoff = Math.min(
        FAILURE_MAX_BACKOFF_MS,
        FAILURE_BASE_BACKOFF_MS * 2 ** Math.max(0, target.failureCount - 1),
      );
      target.nextProbeAt = startedAt + backoff;
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.options.logger.debug(
        `ygg site preheater probe failed ${target.key}`,
        error,
      );
    }
  }

  private async tcpProbe(
    host: string,
    port: number,
    timeoutMs: number,
    attempts: number,
  ): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect({ host, port });
          let done = false;

          const finish = (error?: Error) => {
            if (done) return;
            done = true;
            socket.removeAllListeners();
            socket.destroy();
            if (error) {
              reject(error);
              return;
            }
            resolve();
          };

          socket.setTimeout(timeoutMs);
          socket.once('connect', () => finish());
          socket.once('timeout', () => finish(new Error('probe timeout')));
          socket.once('timeout', () => finish(new Error('probe timeout')));
          socket.once('error', (error) => finish(error));
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= Math.max(1, attempts) - 1) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
          setTimeout(resolve, PROBE_RETRY_DELAY_MS);
        });
      }
    }

    throw lastError ?? new Error('probe failed');
  }
}