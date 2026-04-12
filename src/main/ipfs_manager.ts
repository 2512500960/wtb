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
import { getWtbConfig, setWtbIpfsRepoDir } from './wtb_config';

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

export type IpfsSwarmPeer = {
  peerId: string;
  address: string;
  latency: string;
  direction: string;
  muxer: string;
  streams: string[];
};

export type IpfsStorageSummary = {
  running: boolean;
  repoDir: string;
  repoSizeBytes: number;
  storageMaxBytes: number | null;
  numObjects: number | null;
  diskAvailableBytes: number | null;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
};

export type IpfsCidReleaseResult = {
  releasedCids: string[];
  failedCids: Array<{ cid: string; error: string }>;
  gcCompleted: boolean;
  gcError?: string;
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

type AddPathProgress = {
  loadedBytes: number;
  totalBytes: number;
};

type ImportCandidate = {
  path: string;
  content?: NodeJS.ReadableStream;
};

type AddResult = {
  cid: { toString(): string };
};

type KuboRPCClient = {
  add: (
    candidate: ImportCandidate,
    options?: { pin?: boolean },
  ) => Promise<AddResult>;
  addAll: (
    candidates: Iterable<ImportCandidate> | AsyncIterable<ImportCandidate>,
    options?: { pin?: boolean; wrapWithDirectory?: boolean },
  ) => AsyncIterable<AddResult>;
};

const toPosixRelativePath = (inputPath: string): string => {
  return inputPath.split(path.sep).join('/');
};

function* createDirectoryImportCandidates(
  rootPath: string,
): Generator<ImportCandidate> {
  const rootName = path.basename(rootPath);

  yield { path: rootName };

  const visit = function* (currentPath: string): Generator<ImportCandidate> {
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = path.join(currentPath, entry.name);
      const relativePath = toPosixRelativePath(path.relative(rootPath, childPath));
      const importPath = path.posix.join(rootName, relativePath);

      if (entry.isDirectory()) {
        yield { path: importPath };
        yield* visit(childPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      yield {
        path: importPath,
        content: fs.createReadStream(childPath),
      };
    }
  };

  yield* visit(rootPath);
}

export class IpfsSidecarManager {
  private childProcess: ChildProcess | null = null;

  private rpcClient: KuboRPCClient | null = null;

  private resolvedRepoDir: string | null = null;

  constructor(
    private readonly options: {
      app: App;
      getWtbDataDir: () => string;
      logger: LoggerLike;
      getYggdrasilAddress?: () => Promise<string>;
    },
  ) {}

  getRepoDir(): string {
    if (this.resolvedRepoDir) {
      return this.resolvedRepoDir;
    }

    const configuredRepoDir = getWtbConfig().ipfs?.repoDir?.trim();
    if (configuredRepoDir) {
      this.resolvedRepoDir = path.isAbsolute(configuredRepoDir)
        ? configuredRepoDir
        : path.resolve(this.options.getWtbDataDir(), configuredRepoDir);
      return this.resolvedRepoDir;
    }

    this.resolvedRepoDir = this.getDefaultRepoDir();
    return this.resolvedRepoDir;
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

  async listSwarmPeers(): Promise<IpfsSwarmPeer[]> {
    const pid = this.readPidFromFile();
    if (!pid || !this.isProcessAlive(pid)) {
      return [];
    }

    const responseText = await this.apiPost('swarm/peers', {
      verbose: true,
      streams: true,
      direction: true,
      latency: true,
    });
    const parsed = JSON.parse(responseText) as {
      Peers?: Array<Record<string, unknown>>;
    };

    if (!Array.isArray(parsed.Peers)) {
      return [];
    }

    return parsed.Peers.map((item) => {
      const streams = Array.isArray(item.Streams)
        ? item.Streams.map((stream) => {
            if (typeof stream === 'string') return stream;
            try {
              return JSON.stringify(stream);
            } catch {
              return '';
            }
          }).filter((stream): stream is string => !!stream)
        : [];

      return {
        peerId: typeof item.Peer === 'string' ? item.Peer : '',
        address: typeof item.Addr === 'string' ? item.Addr : '',
        latency: typeof item.Latency === 'string' ? item.Latency : '',
        direction: typeof item.Direction === 'string' ? item.Direction : '',
        muxer: typeof item.Muxer === 'string' ? item.Muxer : '',
        streams,
      };
    }).filter((peer) => peer.peerId || peer.address);
  }

  async getStorageSummary(): Promise<IpfsStorageSummary> {
    const repoDir = this.getRepoDir();
    ensureDirExists(repoDir);

    const repoStats = this.readRepoStats();
    const diskStats = this.readDiskStats(repoDir);
    let repoSizeBytes = repoStats.repoSizeBytes;
    if (repoSizeBytes == null) {
      try {
        repoSizeBytes = this.getDirectorySizeBytes(repoDir);
      } catch (error) {
        this.options.logger.warn(
          'Failed to estimate IPFS repo size from directory traversal',
          error,
        );
        repoSizeBytes = 0;
      }
    }

    return {
      running: this.getServiceStatus().state === 'running',
      repoDir,
      repoSizeBytes,
      storageMaxBytes: repoStats.storageMaxBytes,
      numObjects: repoStats.numObjects,
      diskAvailableBytes: diskStats?.availableBytes ?? null,
      diskTotalBytes: diskStats?.totalBytes ?? null,
      diskUsedBytes: diskStats?.usedBytes ?? null,
    };
  }

  async migrateRepo(targetDir: string): Promise<{
    fromDir: string;
    toDir: string;
    restarted: boolean;
  }>;
  async migrateRepo(
    targetDir: string,
    onProgress?: (progress: { current: number; total: number; message: string }) => void,
  ): Promise<{
    fromDir: string;
    toDir: string;
    restarted: boolean;
  }> {
    const currentDir = path.resolve(this.getRepoDir());
    const nextDir = path.resolve(targetDir || '');
    const totalSteps = 3;

    if (!nextDir) {
      throw new Error('目标目录不能为空。');
    }
    if (currentDir === nextDir) {
      return { fromDir: currentDir, toDir: nextDir, restarted: false };
    }
    if (nextDir.startsWith(`${currentDir}${path.sep}`)) {
      throw new Error('目标目录不能位于当前 IPFS 数据目录内部。');
    }
    if (currentDir.startsWith(`${nextDir}${path.sep}`)) {
      throw new Error('目标目录不能是当前 IPFS 数据目录的上级目录。');
    }

    onProgress?.({
      current: 0,
      total: totalSteps,
      message: '正在检查当前 IPFS 数据目录…',
    });

    const wasRunning = this.getServiceStatus().state === 'running';
    if (wasRunning) {
      onProgress?.({
        current: 1,
        total: totalSteps,
        message: '正在停止 IPFS 服务…',
      });
      await this.stop();
    }

    ensureDirExists(path.dirname(nextDir));
    if (fs.existsSync(nextDir)) {
      const nextStats = fs.statSync(nextDir);
      if (!nextStats.isDirectory()) {
        throw new Error('目标路径必须是目录。');
      }
      if (fs.readdirSync(nextDir).length > 0) {
        throw new Error('目标目录必须为空。');
      }
    }

    try {
      onProgress?.({
        current: wasRunning ? 2 : 1,
        total: totalSteps,
        message: '正在迁移 IPFS 数据目录…',
      });
      if (fs.existsSync(currentDir)) {
        try {
          fs.renameSync(currentDir, nextDir);
        } catch (error) {
          const renameMessage = error instanceof Error ? error.message : String(error);
          if (!/cross-device|exdev/i.test(renameMessage)) {
            throw error;
          }

          fs.cpSync(currentDir, nextDir, {
            recursive: true,
            force: false,
            errorOnExist: true,
          });
          fs.rmSync(currentDir, { recursive: true, force: true });
        }
      } else {
        ensureDirExists(nextDir);
      }

      setWtbIpfsRepoDir(nextDir);
      if (wasRunning) {
        onProgress?.({
          current: 3,
          total: totalSteps,
          message: '目录迁移完成，正在恢复 IPFS 服务…',
        });
        await this.start();
      }

      return { fromDir: currentDir, toDir: nextDir, restarted: wasRunning };
    } catch (error) {
      if (wasRunning) {
        try {
          await this.start();
        } catch (restartError) {
          this.options.logger.warn(
            'Failed to restart ipfs after repo migration failure',
            restartError,
          );
        }
      }
      throw error;
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
    options?: {
      wrapWithDirectory?: boolean;
      onProgress?: (progress: AddPathProgress) => void;
    },
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
    const wrapWithDirectory = options?.wrapWithDirectory !== false;
    const cid = await this.addPathViaRpc(
      resolvedPath,
      stat,
      wrapWithDirectory,
      options?.onProgress,
    );

    this.updatePathCache(
      resolvedPath,
      stat,
      cid,
      wrapWithDirectory,
    );

    return {
      cid,
      path: resolvedPath,
    };
  }

  async ensurePathCached(
    targetPath: string,
    options?: {
      wrapWithDirectory?: boolean;
      onProgress?: (progress: AddPathProgress) => void;
    },
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
      if (options?.onProgress && stat.isFile()) {
        options.onProgress({
          loadedBytes: stat.size,
          totalBytes: stat.size,
        });
      }

      return {
        cid: cached.cid,
        path: resolvedPath,
        cached: true,
      };
    }

    const added = await this.addPath(resolvedPath, {
      wrapWithDirectory,
      onProgress: options?.onProgress,
    });
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

  async releaseCids(cids: string[]): Promise<IpfsCidReleaseResult> {
    const uniqueCids = Array.from(
      new Set(cids.map((cid) => cid.trim()).filter(Boolean)),
    );
    if (!uniqueCids.length) {
      return {
        releasedCids: [],
        failedCids: [],
        gcCompleted: false,
      };
    }

    try {
      await this.ensureRpcClientReady();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        releasedCids: [],
        failedCids: uniqueCids.map((cid) => ({ cid, error: message })),
        gcCompleted: false,
      };
    }

    const releasedCids: string[] = [];
    const failedCids: Array<{ cid: string; error: string }> = [];

    for (const cid of uniqueCids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.apiPostArgs('pin/rm', [cid]);
        releasedCids.push(cid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not pinned|not recursively pinned|is not pinned|already unpinned/i.test(message)) {
          releasedCids.push(cid);
          continue;
        }

        failedCids.push({ cid, error: message });
      }
    }

    if (releasedCids.length > 0) {
      this.invalidatePathCacheForCids(releasedCids);
    }

    if (!releasedCids.length) {
      return {
        releasedCids,
        failedCids,
        gcCompleted: false,
      };
    }

    try {
      await this.apiPost('repo/gc');
      return {
        releasedCids,
        failedCids,
        gcCompleted: true,
      };
    } catch (error) {
      return {
        releasedCids,
        failedCids,
        gcCompleted: false,
        gcError: error instanceof Error ? error.message : String(error),
      };
    }
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

  private getDefaultRepoDir(): string {
    const workspaceRepoDir = path.join(this.options.getWtbDataDir(), 'ipfs');
    if (this.options.app.isPackaged) {
      return workspaceRepoDir;
    }

    const userDataRepoDir = path.join(this.options.app.getPath('userData'), 'ipfs');
    const preferredRepoDir = path.resolve(userDataRepoDir);
    const legacyRepoDir = path.resolve(workspaceRepoDir);

    if (preferredRepoDir.toLowerCase() === legacyRepoDir.toLowerCase()) {
      return preferredRepoDir;
    }

    const migratedRepoDir = this.migrateLegacyDevRepoIfNeeded(
      legacyRepoDir,
      preferredRepoDir,
    );
    return migratedRepoDir;
  }

  private migrateLegacyDevRepoIfNeeded(
    legacyRepoDir: string,
    preferredRepoDir: string,
  ): string {
    if (!fs.existsSync(legacyRepoDir)) {
      return preferredRepoDir;
    }

    if (fs.existsSync(preferredRepoDir)) {
      return preferredRepoDir;
    }

    try {
      ensureDirExists(path.dirname(preferredRepoDir));
      try {
        fs.renameSync(legacyRepoDir, preferredRepoDir);
      } catch (error) {
        const errorCode =
          error && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (!/cross-device|exdev/i.test(errorCode) && !/cross-device|exdev/i.test(
          error instanceof Error ? error.message : String(error),
        )) {
          throw error;
        }

        fs.cpSync(legacyRepoDir, preferredRepoDir, {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        fs.rmSync(legacyRepoDir, { recursive: true, force: true });
      }

      this.options.logger.info('Moved development IPFS repo outside the workspace', {
        fromDir: legacyRepoDir,
        toDir: preferredRepoDir,
      });
      return preferredRepoDir;
    } catch (error) {
      this.options.logger.warn(
        'Failed to move development IPFS repo outside the workspace; keeping legacy path',
        error,
      );
      return legacyRepoDir;
    }
  }

  private async getRpcClient(): Promise<KuboRPCClient> {
    if (!this.rpcClient) {
      const kuboRpcClient = (await import('kubo-rpc-client')) as {
        create: (options: { url: string }) => KuboRPCClient;
      };
      this.rpcClient = kuboRpcClient.create({ url: this.getApiUrl() });
    }

    return this.rpcClient;
  }

  private async ensureRpcClientReady(): Promise<KuboRPCClient> {
    await this.ensureRepoInitialized();

    if (this.getServiceStatus().state !== 'running') {
      await this.start();
    } else {
      await this.waitForApiReady(5_000);
    }

    return await this.getRpcClient();
  }

  private async addPathViaRpc(
    resolvedPath: string,
    stat: fs.Stats,
    wrapWithDirectory: boolean,
    onProgress?: (progress: AddPathProgress) => void,
  ): Promise<string> {
    const client = await this.ensureRpcClientReady();

    if (stat.isFile()) {
      const totalBytes = stat.size;
      let loadedBytes = 0;
      const content = fs.createReadStream(resolvedPath);

      content.on('data', (chunk: Buffer | string) => {
        const nextLoadedBytes =
          loadedBytes +
          (Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk));
        loadedBytes = Math.min(nextLoadedBytes, totalBytes);
        onProgress?.({
          loadedBytes,
          totalBytes,
        });
      });

      content.on('end', () => {
        onProgress?.({
          loadedBytes: totalBytes,
          totalBytes,
        });
      });

      const result = await client.add(
        {
          path: path.basename(resolvedPath),
          content,
        },
        {
          pin: true,
        },
      );

      return result.cid.toString();
    }

    if (!stat.isDirectory()) {
      throw new Error(`Only files and directories are supported: ${resolvedPath}`);
    }

    let finalResult: AddResult | null = null;
    for await (const result of client.addAll(
      createDirectoryImportCandidates(resolvedPath),
      {
        pin: true,
        wrapWithDirectory,
      },
    )) {
      finalResult = result;
    }

    if (!finalResult) {
      throw new Error('kubo-rpc-client addAll returned no CID');
    }

    return finalResult.cid.toString();
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

  private readRepoStats(): {
    repoSizeBytes: number | null;
    storageMaxBytes: number | null;
    numObjects: number | null;
  } {
    try {
      if (!fs.existsSync(this.getConfigPath())) {
        return {
          repoSizeBytes: null,
          storageMaxBytes: null,
          numObjects: null,
        };
      }

      const result = spawnSync(this.getExecutablePath(), ['repo', 'stat', '--enc=json'], {
        cwd: path.dirname(this.getExecutablePath()),
        env: {
          ...process.env,
          IPFS_PATH: this.getRepoDir(),
        },
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.error || result.status !== 0) {
        return {
          repoSizeBytes: null,
          storageMaxBytes: null,
          numObjects: null,
        };
      }

      const parsed = JSON.parse((result.stdout || '').toString()) as {
        RepoSize?: number | string;
        StorageMax?: number | string;
        NumObjects?: number | string;
      };
      return {
        repoSizeBytes: this.toFiniteNumber(parsed.RepoSize),
        storageMaxBytes: this.toFiniteNumber(parsed.StorageMax),
        numObjects: this.toFiniteNumber(parsed.NumObjects),
      };
    } catch {
      return {
        repoSizeBytes: null,
        storageMaxBytes: null,
        numObjects: null,
      };
    }
  }

  private readDiskStats(targetPath: string): {
    availableBytes: number;
    totalBytes: number;
    usedBytes: number;
  } | null {
    try {
      const fsWithStatFs = fs as typeof fs & {
        statfsSync?: (path: string) => {
          bavail: number;
          blocks: number;
          bsize: number;
        };
      };
      if (typeof fsWithStatFs.statfsSync !== 'function') {
        return null;
      }

      const existingPath = this.findNearestExistingPath(targetPath);
      const statfs = fsWithStatFs.statfsSync(existingPath);
      const totalBytes = statfs.blocks * statfs.bsize;
      const availableBytes = statfs.bavail * statfs.bsize;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      return { totalBytes, availableBytes, usedBytes };
    } catch {
      return null;
    }
  }

  private findNearestExistingPath(targetPath: string): string {
    let currentPath = path.resolve(targetPath);
    while (!fs.existsSync(currentPath)) {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return this.options.getWtbDataDir();
      }
      currentPath = parentPath;
    }
    return currentPath;
  }

  private shouldSkipRepoSizeEntry(targetPath: string): boolean {
    return path.basename(targetPath) === '.temp';
  }

  private isIgnorableRepoSizeError(error: unknown): boolean {
    const errorCode =
      error && typeof error === 'object' && 'code' in error
        ? String((error as NodeJS.ErrnoException).code || '')
        : '';

    return (
      errorCode === 'ENOENT'
      || errorCode === 'EPERM'
      || errorCode === 'EACCES'
      || errorCode === 'EBUSY'
    );
  }

  private getDirectorySizeBytes(targetPath: string): number {
    if (this.shouldSkipRepoSizeEntry(targetPath)) {
      return 0;
    }

    if (!fs.existsSync(targetPath)) return 0;

    let stats: fs.Stats;
    try {
      stats = fs.statSync(targetPath);
    } catch (error) {
      if (this.isIgnorableRepoSizeError(error)) {
        return 0;
      }
      throw error;
    }

    if (stats.isFile()) {
      return stats.size;
    }

    if (!stats.isDirectory()) {
      return 0;
    }

    let totalBytes = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch (error) {
      if (this.isIgnorableRepoSizeError(error)) {
        return 0;
      }
      throw error;
    }

    entries.forEach((entry) => {
      const childPath = path.join(targetPath, entry.name);
      if (this.shouldSkipRepoSizeEntry(childPath)) {
        return;
      }

      try {
        totalBytes += this.getDirectorySizeBytes(childPath);
      } catch (error) {
        if (this.isIgnorableRepoSizeError(error)) {
          return;
        }
        throw error;
      }
    });
    return totalBytes;
  }

  private toFiniteNumber(value: number | string | undefined): number | null {
    const nextValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(nextValue) ? nextValue : null;
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

  private invalidatePathCacheForCids(cids: string[]): void {
    if (!cids.length) {
      return;
    }

    const staleCids = new Set(cids);
    const cache = this.readPathCache();
    let changed = false;

    Object.entries(cache).forEach(([cacheKey, entry]) => {
      if (!staleCids.has(entry.cid)) {
        return;
      }

      delete cache[cacheKey];
      changed = true;
    });

    if (!changed) {
      return;
    }

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
