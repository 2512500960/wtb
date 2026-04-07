import type { App } from 'electron';
import fs from 'fs';
import * as http from 'http';
import path from 'path';
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'child_process';

import { ensureDirExists } from './fs_utils';
import type { ServiceStatus } from './service_types';
import { debug, log } from 'console';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
};

export type IpfsDetailedStatus = {
  running: boolean;
  repoDir: string;
  apiUrl: string;
  gatewayUrl: string;
  pid: number | null;
  peerId?: string;
  addresses: string[];
};

const DEFAULT_API_PORT = 5001;
const DEFAULT_GATEWAY_PORT = 8080;

type PathCacheEntry = {
  cid: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  wrapWithDirectory: boolean;
};

export class IpfsSidecarManager {
  private childProcess: ChildProcess | null = null;

  constructor(
    private readonly options: {
      app: App;
      getWtbDataDir: () => string;
      logger: LoggerLike;
      getYggdrasilAddress?: () => Promise<string>;
    },
  ) {}

  getRepoDir(): string {
    return path.join(this.options.getWtbDataDir(), 'ipfs');
  }

  getApiBaseUrl(): string {
    return this.getApiUrl();
  }

  getGatewayBaseUrl(): string {
    return this.getGatewayUrl();
  }

  getServiceStatus(): ServiceStatus {
    const pid = this.readPidFromFile();
    if (pid && this.isProcessAlive(pid)) {
      return {
        name: 'ipfs',
        state: 'running',
        details: this.buildStatusDetails(pid),
      };
    }

    if (pid) {
      this.clearPidFile();
    }

    return {
      name: 'ipfs',
      state: 'stopped',
      details: this.getMissingBinaryHint(),
    };
  }

  async getDetailedStatus(): Promise<IpfsDetailedStatus> {
    const pid = this.readPidFromFile();
    const running = !!pid && this.isProcessAlive(pid);
    if (!running) {
      if (pid) this.clearPidFile();
      return {
        running: false,
        repoDir: this.getRepoDir(),
        apiUrl: this.getApiUrl(),
        gatewayUrl: this.getGatewayUrl(),
        pid: null,
        addresses: [],
      };
    }

    try {
      const nodeInfo = await this.getNodeInfo();
      return {
        running: true,
        repoDir: this.getRepoDir(),
        apiUrl: this.getApiUrl(),
        gatewayUrl: this.getGatewayUrl(),
        pid,
        peerId: nodeInfo.id,
        addresses: nodeInfo.addresses,
      };
    } catch {
      return {
        running: true,
        repoDir: this.getRepoDir(),
        apiUrl: this.getApiUrl(),
        gatewayUrl: this.getGatewayUrl(),
        pid,
        addresses: [],
      };
    }
  }

  async start(): Promise<ServiceStatus> {
    const missingBinaryHint = this.getMissingBinaryHint();
    if (missingBinaryHint) {
      throw new Error(missingBinaryHint);
    }

    const existingPid = this.readPidFromFile();
    if (existingPid && this.isProcessAlive(existingPid)) {
      await this.waitForApiReady(5_000);
      return {
        name: 'ipfs',
        state: 'running',
        details: this.buildStatusDetails(existingPid),
      };
    }

    if (existingPid) {
      this.clearPidFile();
    }

    ensureDirExists(this.getRepoDir());
    await this.ensureRepoInitialized();
    await this.updateRepoConfig();

    const ipfsExe = this.getExecutablePath();
    const stdoutStream = fs.createWriteStream(this.getStdoutPath(), {
      flags: 'a',
    });
    const stderrStream = fs.createWriteStream(this.getStderrPath(), {
      flags: 'a',
    });
    const child = spawn(ipfsExe, ['daemon', '--migrate=true'], {
      cwd: path.dirname(ipfsExe),
      env: {
        ...process.env,
        IPFS_PATH: this.getRepoDir(),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (!child.pid) {
      throw new Error('Failed to obtain ipfs daemon PID.');
    }

    this.childProcess = child;
    fs.writeFileSync(this.getPidPath(), String(child.pid), 'utf8');

    child.stdout?.pipe(stdoutStream);
    child.stderr?.pipe(stderrStream);

    child.on('close', (code) => {
      stdoutStream.end();
      stderrStream.end();
      if (this.childProcess === child) {
        this.childProcess = null;
      }
      const currentPid = this.readPidFromFile();
      if (currentPid === child.pid) {
        this.clearPidFile();
      }
      this.options.logger.info(`ipfs daemon exited with code=${code}`);
    });

    child.on('error', (error) => {
      this.options.logger.error('ipfs daemon process failed', error);
    });

    await this.waitForApiReady(30_000);
    this.options.logger.info('ipfs daemon started', {
      pid: child.pid,
      repoDir: this.getRepoDir(),
      apiUrl: this.getApiUrl(),
      gatewayUrl: this.getGatewayUrl(),
    });

    return {
      name: 'ipfs',
      state: 'running',
      details: this.buildStatusDetails(child.pid),
    };
  }

  async stop(): Promise<ServiceStatus> {
    const pid = this.readPidFromFile();
    if (!pid) {
      return { name: 'ipfs', state: 'stopped' };
    }

    this.killProcessTree(pid);
    await this.waitForProcessExit(pid, 10_000);
    this.clearPidFile();
    this.childProcess = null;
    this.options.logger.info('ipfs daemon stopped', { pid });
    return { name: 'ipfs', state: 'stopped' };
  }

  async stopSilently(): Promise<void> {
    try {
      await this.stop();
    } catch (error) {
      this.options.logger.warn('Failed to stop ipfs daemon on quit', error);
    }
  }

  async addPath(
    targetPath: string,
    options?: { wrapWithDirectory?: boolean },
  ): Promise<{ cid: string; path: string }> {
    const missingBinaryHint = this.getMissingBinaryHint();
    if (missingBinaryHint) {
      throw new Error(missingBinaryHint);
    }

    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    await this.ensureRepoInitialized();

    const stat = fs.statSync(resolvedPath);
    const args = ['add', '-Q'];
    if (stat.isDirectory()) {
      args.push('-r');
      if (options?.wrapWithDirectory !== false) {
        args.push('-w');
      }
    }
    args.push(resolvedPath);

    const result = spawnSync(this.getExecutablePath(), args, {
      cwd: path.dirname(this.getExecutablePath()),
      env: {
        ...process.env,
        IPFS_PATH: this.getRepoDir(),
      },
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      throw new Error(stderr || `ipfs add failed with exit=${result.status}`);
    }

    const cid = (result.stdout || '')
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();

    if (!cid) {
      throw new Error('ipfs add returned no CID');
    }

    this.updatePathCache(
      resolvedPath,
      stat,
      cid,
      options?.wrapWithDirectory !== false,
    );

    return {
      cid,
      path: resolvedPath,
    };
  }

  async ensurePathCached(
    targetPath: string,
    options?: { wrapWithDirectory?: boolean },
  ): Promise<{ cid: string; path: string; cached: boolean }> {
    const resolvedPath = path.resolve(targetPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Path does not exist: ${resolvedPath}`);
    }

    const stat = fs.statSync(resolvedPath);
    const wrapWithDirectory = options?.wrapWithDirectory !== false;
    const cached = this.getCachedPathEntry(resolvedPath);
    if (
      cached &&
      cached.isDirectory === stat.isDirectory() &&
      cached.size === (stat.isFile() ? stat.size : 0) &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.wrapWithDirectory === wrapWithDirectory
    ) {
      return {
        cid: cached.cid,
        path: resolvedPath,
        cached: true,
      };
    }

    const added = await this.addPath(resolvedPath, { wrapWithDirectory });
    return {
      ...added,
      cached: false,
    };
  }

  async connectToPeers(
    addresses: string[],
  ): Promise<{
    connected: string[];
    failed: Array<{ address: string; error: string }>;
  }> {
    const uniqueAddresses = Array.from(
      new Set(addresses.filter((item) => typeof item === 'string' && item.trim())),
    );
    if (!uniqueAddresses.length) {
      return { connected: [], failed: [] };
    }

    const pid = this.readPidFromFile();
    if (!pid || !this.isProcessAlive(pid)) {
      return { connected: [], failed: [] };
    }

    const connected: string[] = [];
    const failed: Array<{ address: string; error: string }> = [];

    for (const address of uniqueAddresses) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.apiPostArgs('swarm/connect', [address]);
        connected.push(address);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/already connected|connected to/i.test(message)) {
          connected.push(address);
        } else {
          failed.push({ address, error: message });
        }
      }
    }

    return { connected, failed };
  }

  private getExecutablePath(): string {
    return path.join(this.getBaseDir(), 'ipfs.exe');
  }

  private getBaseDir(): string {
    if (process.arch !== 'x64') {
      throw new Error(
        `Unsupported architecture: ${process.arch}. Only Windows x64 is supported.`,
      );
    }

    if (this.options.app.isPackaged) {
      return path.join(process.resourcesPath, 'ipfs', 'amd64');
    }

    return path.resolve(__dirname, '../../ipfs/amd64');
  }

  private getPidPath(): string {
    return path.join(this.getRepoDir(), 'daemon.pid');
  }

  private getStdoutPath(): string {
    return path.join(this.getRepoDir(), 'ipfs.stdout.log');
  }

  private getStderrPath(): string {
    return path.join(this.getRepoDir(), 'ipfs.stderr.log');
  }

  private getConfigPath(): string {
    return path.join(this.getRepoDir(), 'config');
  }

  private getPathCachePath(): string {
    return path.join(this.getRepoDir(), 'wtb-path-cache.json');
  }

  private getApiUrl(): string {
    return `http://127.0.0.1:${DEFAULT_API_PORT}`;
  }

  private getGatewayUrl(): string {
    return `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
  }

  private buildStatusDetails(pid: number): string {
    return `pid=${pid} api=${this.getApiUrl()} gateway=${this.getGatewayUrl()}`;
  }

  private getMissingBinaryHint(): string | undefined {
    try {
      const exePath = this.getExecutablePath();
      if (!fs.existsSync(exePath)) {
        return `ipfs.exe not found at: ${exePath}`;
      }
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private readPidFromFile(): number | null {
    try {
      if (!fs.existsSync(this.getPidPath())) return null;
      const pid = Number(fs.readFileSync(this.getPidPath(), 'utf8').trim());
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private clearPidFile(): void {
    try {
      if (fs.existsSync(this.getPidPath())) {
        fs.unlinkSync(this.getPidPath());
      }
    } catch {
      // ignore
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private killProcessTree(pid: number): void {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });

    if (result.error) {
      throw result.error;
    }

    const stderr = (result.stderr || '').toString().trim();
    if (result.status !== 0 && !/not found|no running instance/i.test(stderr)) {
      throw new Error(stderr || `taskkill failed with exit=${result.status}`);
    }
  }

  private async waitForProcessExit(
    pid: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.isProcessAlive(pid)) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ipfs daemon to exit (pid=${pid})`);
  }

  private async ensureRepoInitialized(): Promise<void> {
    ensureDirExists(this.getRepoDir());
    if (fs.existsSync(this.getConfigPath())) return;

    const result = spawnSync(
      this.getExecutablePath(),
      ['init', '--profile=lowpower'],
      {
        cwd: path.dirname(this.getExecutablePath()),
        env: {
          ...process.env,
          IPFS_PATH: this.getRepoDir(),
        },
        encoding: 'utf8',
        windowsHide: true,
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      const stderr = (result.stderr || '').toString().trim();
      throw new Error(stderr || `ipfs init failed with exit=${result.status}`);
    }
  }

  private async updateRepoConfig(): Promise<void> {
    if (!fs.existsSync(this.getConfigPath())) return;

    const rawText = fs.readFileSync(this.getConfigPath(), 'utf8');
    const config = JSON.parse(rawText) as Record<string, unknown>;
    const addresses =
      config.Addresses && typeof config.Addresses === 'object'
        ? (config.Addresses as Record<string, unknown>)
        : {};

    addresses.API = `/ip4/127.0.0.1/tcp/${DEFAULT_API_PORT}`;
    addresses.Gateway = `/ip4/127.0.0.1/tcp/${DEFAULT_GATEWAY_PORT}`;

    const announce = Array.isArray(addresses.Announce)
      ? addresses.Announce.filter((item): item is string => typeof item === 'string')
      : [];

    if (this.options.getYggdrasilAddress) {
      try {
        const yggAddr = await this.options.getYggdrasilAddress();
        // debug("Got Yggdrasil address for IPFS config: %s", yggAddr);
        const yggMultiaddr = `/ip6/${yggAddr}/tcp/4001`;
        // debug("Constructed Yggdrasil multiaddr for IPFS config: %s", yggMultiaddr);
        if (!announce.includes(yggMultiaddr)) {
          announce.push(yggMultiaddr);
        }
      } catch {
        // ignore when Yggdrasil is not available yet
      }
    }

    addresses.Announce = announce;
    config.Addresses = addresses;

    fs.writeFileSync(this.getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  private getCachedPathEntry(targetPath: string): PathCacheEntry | null {
    try {
      const cache = this.readPathCache();
      return cache[this.getPathCacheKey(targetPath)] || null;
    } catch {
      return null;
    }
  }

  private updatePathCache(
    targetPath: string,
    stat: fs.Stats,
    cid: string,
    wrapWithDirectory: boolean,
  ): void {
    const cache = this.readPathCache();
    cache[this.getPathCacheKey(targetPath)] = {
      cid,
      path: targetPath,
      isDirectory: stat.isDirectory(),
      size: stat.isFile() ? stat.size : 0,
      mtimeMs: stat.mtimeMs,
      wrapWithDirectory,
    };
    fs.writeFileSync(
      this.getPathCachePath(),
      `${JSON.stringify(cache, null, 2)}\n`,
      'utf8',
    );
  }

  private readPathCache(): Record<string, PathCacheEntry> {
    try {
      if (!fs.existsSync(this.getPathCachePath())) return {};
      const raw = fs.readFileSync(this.getPathCachePath(), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, PathCacheEntry>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  private getPathCacheKey(targetPath: string): string {
    return path.resolve(targetPath).toLowerCase();
  }

  private async waitForApiReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | null = null;

    while (Date.now() < deadline) {
      try {
        await this.getNodeInfo();
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(
      lastError?.message || 'Timed out waiting for ipfs API to become ready.',
    );
  }

  private async getNodeInfo(): Promise<{ id: string; addresses: string[] }> {
    const responseText = await this.apiPost('id', { format: '<id>' });
    const parsed = JSON.parse(responseText) as {
      ID?: string;
      Addresses?: unknown[];
    };
    return {
      id: typeof parsed.ID === 'string' ? parsed.ID : '',
      addresses: Array.isArray(parsed.Addresses)
        ? parsed.Addresses.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }

  private async apiPost(
    command: string,
    query?: Record<string, string | number | boolean>,
  ): Promise<string> {
    const params = new URLSearchParams();
    Object.entries(query || {}).forEach(([key, value]) => {
      params.set(key, String(value));
    });

    const pathWithQuery = params.toString()
      ? `/api/v0/${command}?${params.toString()}`
      : `/api/v0/${command}`;

    return await this.apiRequest(pathWithQuery);
  }

  private async apiPostArgs(command: string, args: string[]): Promise<string> {
    const params = new URLSearchParams();
    args.forEach((arg) => params.append('arg', arg));
    const pathWithQuery = params.toString()
      ? `/api/v0/${command}?${params.toString()}`
      : `/api/v0/${command}`;

    return await this.apiRequest(pathWithQuery);
  }

  private async apiRequest(pathWithQuery: string): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: DEFAULT_API_PORT,
          path: pathWithQuery,
          timeout: 2_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode || 500) >= 400) {
              reject(new Error(text || `ipfs API returned ${res.statusCode}`));
              return;
            }
            resolve(text);
          });
        },
      );

      req.on('timeout', () => {
        req.destroy(new Error('ipfs API request timed out'));
      });
      req.on('error', reject);
      req.end();
    });
  }
}
