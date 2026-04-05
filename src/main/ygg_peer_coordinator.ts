import type { ServiceStatus } from './service_types';
import type {
  WtbConfigV1,
  YggdrasilAutoPeerManagerConfigInput,
} from './wtb_config';
import type { YggdrasilCtlResult } from './yggdrasil_types';

type RuntimeYggPeerEntry = {
  uri: string;
  up: boolean;
  inbound: boolean;
};

type LoggerLike = {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

type AutoPeerManagerLike = {
  isStarted: () => boolean;
  start: (reason: string) => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => unknown;
  reconcileNow: (reason: string) => Promise<unknown>;
};

type Dependencies = {
  logger: LoggerLike;
  getYggdrasilStatus: () => ServiceStatus;
  getConfig: () => WtbConfigV1;
  setManualPeers: (peers: string[]) => WtbConfigV1;
  setAutoPeerConfig: (
    input: YggdrasilAutoPeerManagerConfigInput,
  ) => WtbConfigV1;
  clearConfigPeersBestEffort: (reason: string) => void;
  loadBundledPublicPeers: () => Array<{ address: string }>;
  runCtlCommand: (
    command: 'addpeer' | 'removepeer' | 'getpeersjson',
    args?: string[],
    options?: { timeoutMs?: number; json?: boolean },
  ) => Promise<YggdrasilCtlResult>;
  autoPeerManager: AutoPeerManagerLike;
};

const normalizeYggPeerUri = (value: string): string => value.trim();

const parseRuntimeYggPeers = (stdout: string): RuntimeYggPeerEntry[] => {
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
    .map((entry: any) => ({
      uri: normalizeYggPeerUri(String(entry.remote || entry.uri || '')),
      up: entry.up === true,
      inbound: entry.inbound === true,
    }))
    .filter((entry: RuntimeYggPeerEntry) => !!entry.uri);
};

export class YggPeerCoordinator {
  constructor(private readonly deps: Dependencies) {}

  scheduleAutoStartIfNeeded(reason: string): void {
    setTimeout(() => {
      this.syncPeerModeBestEffort(reason).catch((err: unknown) => {
        this.deps.logger.debug(`Ygg peer mode sync skipped/failed: ${reason}`, err);
      });
    }, 0);
  }

  prepareRuntimeConfigOnStartup(reason: string): void {
    this.deps.clearConfigPeersBestEffort(reason);
    this.scheduleAutoStartIfNeeded(reason);
  }

  async stopAutoPeerManager(): Promise<void> {
    await this.deps.autoPeerManager.stop();
  }

  getAutoPeerStatus(): unknown {
    return this.deps.autoPeerManager.getStatus();
  }

  getPublicPeerSelection(): string[] {
    const cfg = this.deps.getConfig();
    return (cfg?.yggdrasil?.publicPeers ?? []) as string[];
  }

  async applyPublicPeerSelection(peers: string[]): Promise<{
    publicPeers: string[];
    autoPeerStatus: unknown;
  }> {
    const cfg = this.deps.setManualPeers(peers);
    this.deps.clearConfigPeersBestEffort('manual peer selection saved');
    if (this.deps.getYggdrasilStatus().state === 'running') {
      await this.syncPeerModeBestEffort('manual peer selection updated');
    }
    return {
      publicPeers: cfg?.yggdrasil?.publicPeers ?? peers,
      autoPeerStatus: this.deps.autoPeerManager.getStatus(),
    };
  }

  async applyAutoPeerConfig(input: unknown): Promise<{
    config: unknown;
    status: unknown;
  }> {
    const cfg = this.deps.setAutoPeerConfig(
      input as YggdrasilAutoPeerManagerConfigInput,
    );
    this.deps.clearConfigPeersBestEffort('auto peer settings saved');
    await this.syncPeerModeBestEffort('auto peer settings saved');
    const status =
      cfg.yggdrasil?.autoPeerManager?.enabled !== false &&
      this.deps.getYggdrasilStatus().state === 'running'
        ? await this.deps.autoPeerManager.reconcileNow('auto peer settings saved')
        : this.deps.autoPeerManager.getStatus();
    return {
      config: cfg.yggdrasil?.autoPeerManager,
      status,
    };
  }

  async reconcileAutoPeerNow(): Promise<unknown> {
    await this.syncAutoPeerManagerBestEffort('manual reconcile requested');
    return await this.deps.autoPeerManager.reconcileNow(
      'manual reconcile requested',
    );
  }

  private getConfiguredManualYggPeers(): string[] {
    const cfg = this.deps.getConfig();
    const peers = cfg?.yggdrasil?.publicPeers ?? [];
    if (!Array.isArray(peers)) return [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of peers) {
      if (typeof value !== 'string') continue;
      const uri = normalizeYggPeerUri(value);
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);
      normalized.push(uri);
    }
    return normalized;
  }

  private async addYggPeerRuntime(
    uri: string,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const result = await this.deps.runCtlCommand('addpeer', [`uri=${uri}`], {
      timeoutMs,
    });
    if (!result.ok) {
      this.deps.logger.debug(`Failed to add yggdrasil peer at runtime: ${uri}`, {
        stderr: result.stderr,
        stdout: result.stdout,
      });
    }
  }

  private async removeYggPeerRuntime(
    uri: string,
    timeoutMs: number = 5000,
  ): Promise<void> {
    const result = await this.deps.runCtlCommand('removepeer', [`uri=${uri}`], {
      timeoutMs,
    });
    if (!result.ok && !/not found|unknown/i.test(result.stderr || '')) {
      throw new Error(result.stderr || `removepeer failed: ${uri}`);
    }
  }

  private async listRuntimeYggPeers(
    timeoutMs: number = 5000,
  ): Promise<RuntimeYggPeerEntry[]> {
    const result = await this.deps.runCtlCommand('getpeersjson', [], {
      timeoutMs,
      json: true,
    });
    if (!result.ok) {
      throw new Error(result.stderr || 'yggdrasilctl getpeersjson failed');
    }
    return parseRuntimeYggPeers(result.stdout);
  }

  private async syncManualYggPeersBestEffort(reason: string): Promise<void> {
    const ygg = this.deps.getYggdrasilStatus();
    if (ygg.state !== 'running') return;

    const desiredManualPeers = new Set(this.getConfiguredManualYggPeers());
    const runtimePeers = await this.listRuntimeYggPeers(5000);
    const bundledPublicPeerUris = new Set(
      this.deps
        .loadBundledPublicPeers()
        .map((peer) => normalizeYggPeerUri(peer.address))
        .filter((value) => !!value),
    );

    for (const peer of runtimePeers) {
      if (!bundledPublicPeerUris.has(peer.uri)) continue;
      if (desiredManualPeers.has(peer.uri)) continue;
      if (peer.inbound) continue;
      await this.removeYggPeerRuntime(peer.uri, 5000);
    }

    const currentUris = new Set(runtimePeers.map((peer) => peer.uri));
    for (const uri of desiredManualPeers) {
      if (currentUris.has(uri)) continue;
      await this.addYggPeerRuntime(uri, 5000);
    }

    this.deps.logger.info(
      `Applied manual yggdrasil peers at runtime (${reason}). count=${desiredManualPeers.size}`,
    );
  }

  private async syncPeerModeBestEffort(reason: string): Promise<void> {
    const cfg = this.deps.getConfig();
    const enabled = cfg.yggdrasil?.autoPeerManager?.enabled !== false;
    const ygg = this.deps.getYggdrasilStatus();

    if (ygg.state !== 'running') {
      await this.deps.autoPeerManager.stop();
      return;
    }

    if (!enabled) {
      await this.deps.autoPeerManager.stop();
      await this.syncManualYggPeersBestEffort(reason);
      return;
    }

    if (!this.deps.autoPeerManager.isStarted()) {
      await this.deps.autoPeerManager.start(reason);
    }
  }

  private async syncAutoPeerManagerBestEffort(reason: string): Promise<void> {
    await this.syncPeerModeBestEffort(reason);
  }
}
