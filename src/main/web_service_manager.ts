import { spawnSync } from 'child_process';
import fs from 'fs';
import * as http from 'http';
import type { Socket } from 'net';
import path from 'path';
import { URL } from 'url';
import type { App } from 'electron';

import { ensureDirExists } from './fs_utils';
import type { IpfsSidecarManager } from './ipfs_manager';
import { ensureMediaDirs } from './mediaServer';
import type {
  FirewallPortDescriptor,
  FirewallPortStatus,
  ServiceStatus,
} from './service_types';
import { ensureDefaultWebAssets } from './web_assets';
import {
  listWebContentDirectoryEntries,
  migrateWebContentToManagedIpfs,
  normalizeReservedLocalWebPaths,
  resolveWebContentPath,
} from './web_content_sources';
import { buildWebResourceManifest } from './web_resource_manifest';
import {
  guessContentType,
  parseAndNormalizeUrlPath,
  parseByteRange,
  renderDirectoryIndexHtml,
  sendJson,
} from './web_service_utils';
import { getWtbConfig } from './wtb_config';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

const isWindows = process.platform === 'win32';

const psSingleQuote = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};

export type WebServiceRequestRecord = {
  id: number;
  at: string;
  method: string;
  path: string;
  remoteAddress: string;
  userAgent: string;
  statusCode: number;
};

export type WebServiceActiveClient = {
  remoteAddress: string;
  lastSeenAt: string;
  requestCount: number;
  recentPaths: string[];
  userAgent: string;
};

export type WebServiceActivitySnapshot = {
  activeWindowMinutes: number;
  activeClients: WebServiceActiveClient[];
  recentRequests: WebServiceRequestRecord[];
};

const WEB_ACTIVITY_MAX_RECORDS = 120;
const WEB_ACTIVITY_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
const WTB_SERVICE_HEADER_VALUE = 'web; version=1';

const isResponseClosed = (res: http.ServerResponse): boolean => {
  return res.writableEnded || res.destroyed;
};

const endProxyErrorResponse = (
  res: http.ServerResponse,
  method: string,
): void => {
  if (isResponseClosed(res)) {
    return;
  }

  if (res.headersSent) {
    res.destroy();
    return;
  }

  res.statusCode = 502;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(method === 'HEAD' ? undefined : 'Bad Gateway');
};

export class WebServiceManager {
  private server: http.Server | null = null;

  private listenAddress: string | null = null;

  private listenPort: number | null = null;

  private readonly openSockets = new Set<Socket>();

  private readonly requestRecords: WebServiceRequestRecord[] = [];

  private requestSequence = 0;

  constructor(
    private readonly options: {
      app: App;
      logger: LoggerLike;
      getWtbDataDir: () => string;
      getYggdrasilStatus: () => ServiceStatus;
      getYggdrasilAddress: () => Promise<string>;
      ipfsManager: IpfsSidecarManager;
    },
  ) {}

  getStatus(): ServiceStatus {
    if (this.server && this.server.listening && this.listenAddress && this.listenPort) {
      return {
        name: 'web',
        state: 'running',
        details: `http://[${this.listenAddress}]:${this.listenPort}`,
      };
    }
    return { name: 'web', state: 'stopped' };
  }

  getRootDir(): string {
    try {
      const cfg = getWtbConfig();
      const override =
        cfg?.web?.assetsDir && cfg.web.assetsDir.trim()
          ? cfg.web.assetsDir.trim()
          : '';
      if (override) return path.resolve(override);
    } catch {
      // ignore
    }

    this.options.logger.debug('Using default web root directory under data dir');
    this.options.logger.debug('WTB data directory:', this.options.getWtbDataDir());
    return path.join(this.options.getWtbDataDir(), 'web');
  }

  getActivitySnapshot(): WebServiceActivitySnapshot {
    const recentRequests = this.requestRecords
      .slice()
      .sort((left, right) => right.id - left.id);
    const activeSince = Date.now() - WEB_ACTIVITY_ACTIVE_WINDOW_MS;
    const clients = new Map<
      string,
      {
        remoteAddress: string;
        lastSeenAt: string;
        lastSeenMs: number;
        requestCount: number;
        recentPaths: string[];
        userAgent: string;
      }
    >();

    recentRequests.forEach((record) => {
      const atMs = Date.parse(record.at);
      if (!Number.isFinite(atMs) || atMs < activeSince) return;

      const existing = clients.get(record.remoteAddress);
      if (!existing) {
        clients.set(record.remoteAddress, {
          remoteAddress: record.remoteAddress,
          lastSeenAt: record.at,
          lastSeenMs: atMs,
          requestCount: 1,
          recentPaths: [record.path],
          userAgent: record.userAgent,
        });
        return;
      }

      existing.requestCount += 1;
      if (!existing.recentPaths.includes(record.path) && existing.recentPaths.length < 4) {
        existing.recentPaths.push(record.path);
      }
      if (!existing.userAgent && record.userAgent) {
        existing.userAgent = record.userAgent;
      }
    });

    return {
      activeWindowMinutes: Math.floor(WEB_ACTIVITY_ACTIVE_WINDOW_MS / 60_000),
      activeClients: Array.from(clients.values())
        .sort((left, right) => {
          if (right.lastSeenMs !== left.lastSeenMs) {
            return right.lastSeenMs - left.lastSeenMs;
          }
          return right.requestCount - left.requestCount;
        })
        .map(({ lastSeenMs: _lastSeenMs, ...client }) => client),
      recentRequests,
    };
  }

  async start(): Promise<ServiceStatus> {
    this.ensureWindowsOrThrow();

    const existing = this.getStatus();
    if (existing.state === 'running') return existing;

    const ygg = this.options.getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error('需要先启动 Yggdrasil 服务才能启动 Web 服务。');
    }

    const host = await this.options.getYggdrasilAddress();
    const port = this.getWebPort();
    const webRoot = this.getRootDir();

    ensureDirExists(webRoot);
    await ensureDefaultWebAssets(this.options.app, webRoot);
    await normalizeReservedLocalWebPaths({
      webRoot,
      ipfsManager: this.options.ipfsManager,
    });
    ensureMediaDirs(webRoot);
    await migrateWebContentToManagedIpfs({
      webRoot,
      ipfsManager: this.options.ipfsManager,
    });

    const server = http.createServer(async (req, res) => {
      try {
        this.applyWtbResponseHeaders(res);

        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405;
          res.setHeader('Allow', 'GET, HEAD');
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Method Not Allowed');
          return;
        }

        const urlPath = parseAndNormalizeUrlPath(req.url);
        const requestUrl = new URL(req.url || '/', 'http://localhost');
        this.recordRequestActivity(req, res, req.url || urlPath);

        if (urlPath === '/health') {
          const body = JSON.stringify({
            ok: true,
            service: 'web',
            time: new Date().toISOString(),
            root: webRoot,
          });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(method === 'HEAD' ? undefined : body);
          return;
        }

        if (urlPath === '/api/list') {
          const requestedPath = requestUrl.searchParams.get('path') || '/';
          const normalizedPath = parseAndNormalizeUrlPath(requestedPath);
          try {
            let entries = listWebContentDirectoryEntries({
              webRoot,
              requestedPath: normalizedPath,
            }).map((entry) => ({
              name: entry.name,
              path: entry.path,
              isDirectory: entry.isDirectory,
              size: entry.isDirectory ? 0 : entry.size,
              mtimeMs: entry.mtimeMs,
              cid: entry.cid,
              sourceMode: entry.sourceMode,
            }));

            entries = entries.filter((entry) => {
              const lower = entry.name.toLowerCase();
              return (
                lower !== 'index.html' &&
                lower !== 'index.json' &&
                lower !== 'vendor' &&
                lower !== 'hls'
              );
            });

            sendJson(req, res, 200, {
              success: true,
              data: {
                path: normalizedPath,
                entries,
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const statusCode =
              message === 'Forbidden' ? 403 : message === 'Not Found' ? 404 : 500;
            sendJson(req, res, statusCode, {
              success: false,
              error: message,
            });
          }
          return;
        }

        if (urlPath === '/api/firewall/ports') {
          sendJson(req, res, 200, {
            success: true,
            data: {
              checkedAt: new Date().toISOString(),
              items: this.getWindowsFirewallPortStatuses(
                this.getRequiredFirewallPorts(),
              ),
            },
          });
          return;
        }

        if (urlPath === '/api/resources') {
          try {
            const manifest = await buildWebResourceManifest({
              hostHeader: req.headers.host,
              webRoot,
              requestedPath: requestUrl.searchParams.get('path') || '/',
              ipfsManager: this.options.ipfsManager,
            });
            sendJson(req, res, 200, {
              success: true,
              data: manifest,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const statusCode =
              message === 'Forbidden' ? 403 : message === 'Not Found' ? 404 : 500;
            sendJson(req, res, statusCode, {
              success: false,
              error: message,
            });
          }
          return;
        }

        let resolvedPath;
        try {
          resolvedPath = resolveWebContentPath({
            webRoot,
            requestedPath: urlPath,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.statusCode =
            message === 'Forbidden' ? 403 : message === 'Not Found' ? 404 : 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end(message);
          return;
        }

        if (resolvedPath.kind === 'directory') {
          if (!urlPath.endsWith('/')) {
            res.statusCode = 301;
            res.setHeader('Location', `${urlPath}/`);
            res.end();
            return;
          }

          try {
            const indexResolvedPath = resolveWebContentPath({
              webRoot,
              requestedPath: path.posix.join(urlPath, 'index.html'),
            });
            if (indexResolvedPath.kind === 'ipfs-file') {
              await this.respondWithIpfsBackedFile(
                req,
                res,
                method,
                indexResolvedPath.cid,
                indexResolvedPath.entry.mime,
              );
              return;
            }
            if (indexResolvedPath.kind === 'local-file') {
              this.respondWithLocalFile(
                req,
                res,
                method,
                indexResolvedPath.fsPath,
                indexResolvedPath.stat,
              );
              return;
            }
          } catch {
            // ignore missing index.html and fall back to physical index or directory listing
          }

          if (resolvedPath.physical && resolvedPath.entry.fsPath) {
            const indexCandidates = ['index.html', 'index.htm'];
            for (const candidate of indexCandidates) {
              const idxPath = path.join(resolvedPath.entry.fsPath, candidate);
              if (!fs.existsSync(idxPath)) continue;
              const idxStat = fs.statSync(idxPath);
              if (!idxStat.isFile()) continue;
              this.respondWithLocalFile(req, res, method, idxPath, idxStat);
              return;
            }
          }

          const entries = listWebContentDirectoryEntries({
            webRoot,
            requestedPath: urlPath,
          }).map((entry) => ({
            name: entry.name,
            isDir: entry.isDirectory,
            size: entry.isDirectory ? 0 : entry.size,
            mtimeMs: entry.mtimeMs,
          }));

          const html = renderDirectoryIndexHtml({ urlPath, entries });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(method === 'HEAD' ? undefined : html);
          return;
        }

        if (resolvedPath.kind === 'ipfs-file') {
          await this.respondWithIpfsBackedFile(
            req,
            res,
            method,
            resolvedPath.cid,
            resolvedPath.entry.mime,
          );
          return;
        }

        if (resolvedPath.kind === 'local-file') {
          this.respondWithLocalFile(
            req,
            res,
            method,
            resolvedPath.fsPath,
            resolvedPath.stat,
          );
          return;
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
      } catch {
        try {
          res.statusCode = 500;
          res.end('Internal Server Error');
        } catch {
          // ignore
        }
      }
    });

    server.on('connection', (socket: Socket) => {
      this.openSockets.add(socket);
      socket.on('close', () => this.openSockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host, port }, () => resolve());
    });

    this.server = server;
    this.listenAddress = host;
    this.listenPort = port;

    try {
      const firewallPorts = this.getWindowsFirewallPortStatuses(
        this.getRequiredFirewallPorts(),
      );
      const blocked = firewallPorts.filter((item) => item.checked && !item.allowed);
      if (blocked.length) {
        this.options.logger.warn(
          `Windows 防火墙可能未放行端口: ${blocked
            .map((item) => `${item.name}:${item.port}`)
            .join(', ')}`,
        );
      }
    } catch (error) {
      this.options.logger.debug(
        'Failed to inspect Windows firewall port status',
        error,
      );
    }

    this.options.logger.info(`web service listening on http://[${host}]:${port}`);
    return this.getStatus();
  }

  async stop(): Promise<ServiceStatus> {
    const server = this.server;
    if (!server) return { name: 'web', state: 'stopped' };

    this.destroyAllSockets();

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      try {
        server.close(() => finish());
      } catch {
        finish();
        return;
      }

      setTimeout(() => finish(), 1500);
    });

    this.server = null;
    this.listenAddress = null;
    this.listenPort = null;
    this.options.logger.info('web service stopped');
    return { name: 'web', state: 'stopped' };
  }

  dispose(): void {
    try {
      this.destroyAllSockets();
      this.server?.close();
    } catch {
      // ignore
    } finally {
      this.server = null;
      this.listenAddress = null;
      this.listenPort = null;
    }
  }

  private recordRequestActivity(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    requestPath: string,
  ): void {
    const trimmedPath = (requestPath || '/').trim() || '/';
    if (trimmedPath === '/health') return;

    const remoteAddress = this.normalizeRemoteAddress(req.socket.remoteAddress);
    const rawUserAgent = req.headers['user-agent'] as
      | string
      | string[]
      | undefined;
    let userAgent = '';
    if (typeof rawUserAgent === 'string') {
      userAgent = rawUserAgent.trim().slice(0, 160);
    } else if (Array.isArray(rawUserAgent)) {
      const firstUserAgent = rawUserAgent.find(
        (value): value is string => typeof value === 'string',
      );
      userAgent = firstUserAgent ? firstUserAgent.trim().slice(0, 160) : '';
    }
    const method = (req.method || 'GET').toUpperCase();
    const pathText = trimmedPath.slice(0, 240);

    res.once('finish', () => {
      this.requestSequence += 1;
      this.requestRecords.push({
        id: this.requestSequence,
        at: new Date().toISOString(),
        method,
        path: pathText,
        remoteAddress,
        userAgent,
        statusCode: res.statusCode || 0,
      });

      if (this.requestRecords.length > WEB_ACTIVITY_MAX_RECORDS) {
        this.requestRecords.splice(
          0,
          this.requestRecords.length - WEB_ACTIVITY_MAX_RECORDS,
        );
      }
    });
  }

  private normalizeRemoteAddress(value: string | undefined): string {
    const trimmed = (value || '').trim();
    if (!trimmed) return 'unknown';
    if (trimmed.startsWith('::ffff:')) {
      return trimmed.slice('::ffff:'.length);
    }
    return trimmed;
  }

  private applyWtbResponseHeaders(res: http.ServerResponse): void {
    const ipfsStatus = this.options.ipfsManager.getServiceStatus().state;
    res.setHeader('WTB-Service', WTB_SERVICE_HEADER_VALUE);
    res.setHeader(
      'WTB-Features',
      ['resource-manifest', 'dual-source', 'http-fallback', 'ipfs'].join(','),
    );
    res.setHeader('WTB-IPFS-Status', ipfsStatus);
  }

  private respondWithLocalFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    filePath: string,
    stat: fs.Stats,
  ): void {
    this.applyWtbResponseHeaders(res);
    const range = parseByteRange(req.headers.range, stat.size);
    res.setHeader('Content-Type', guessContentType(filePath));
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Accept-Ranges', 'bytes');

    if (range === 'invalid') {
      res.statusCode = 416;
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end(method === 'HEAD' ? undefined : 'Requested Range Not Satisfiable');
      return;
    }

    if (range) {
      const chunkSize = range.end - range.start + 1;
      res.statusCode = 206;
      res.setHeader('Content-Length', String(chunkSize));
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      if (method === 'HEAD') {
        res.end();
        return;
      }

      const stream = fs.createReadStream(filePath, {
        start: range.start,
        end: range.end,
      });
      stream.on('error', () => {
        try {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Internal Server Error');
        } catch {
          // ignore
        }
      });
      stream.pipe(res);
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', String(stat.size));
    if (method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Internal Server Error');
      } catch {
        // ignore
      }
    });
    stream.pipe(res);
  }

  private async respondWithIpfsBackedFile(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    cid: string,
    contentType?: string,
  ): Promise<void> {
    this.applyWtbResponseHeaders(res);
    if (this.options.ipfsManager.getServiceStatus().state !== 'running') {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('IPFS service is not running');
      return;
    }

    const gatewayUrl = new URL(`/ipfs/${encodeURIComponent(cid)}`, this.options.ipfsManager.getGatewayBaseUrl());
    console.log('[web][ipfs-proxy] start', {
      method,
      cid,
      range: req.headers.range || null,
      accept: req.headers.accept || null,
      gatewayUrl: gatewayUrl.toString(),
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const resolveOnce = () => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      const failProxyRequest = (error?: unknown) => {
        console.warn('[web][ipfs-proxy] fail', {
          method,
          cid,
          range: req.headers.range || null,
          error:
            error instanceof Error ? error.message : error != null ? String(error) : 'unknown',
        });
        try {
          endProxyErrorResponse(res, method);
        } catch {
          // ignore
        }
        resolveOnce();
      };

      const upstream = http.request(
        {
          method,
          host: gatewayUrl.hostname,
          port: gatewayUrl.port ? Number(gatewayUrl.port) : 80,
          path: `${gatewayUrl.pathname}${gatewayUrl.search}`,
          headers: {
            ...(req.headers.range ? { range: req.headers.range } : {}),
            ...(req.headers.accept ? { accept: req.headers.accept } : {}),
          },
          timeout: 5_000,
        },
        (upstreamRes) => {
          console.log('[web][ipfs-proxy] response', {
            method,
            cid,
            statusCode: upstreamRes.statusCode || 0,
            contentType: upstreamRes.headers['content-type'] || null,
            contentLength: upstreamRes.headers['content-length'] || null,
            contentRange: upstreamRes.headers['content-range'] || null,
            acceptRanges: upstreamRes.headers['accept-ranges'] || null,
          });
          this.copyProxyHeaders(upstreamRes, res);
          if (contentType) {
            res.setHeader('Content-Type', contentType);
          }
          res.statusCode = upstreamRes.statusCode || 502;

          if (method === 'HEAD') {
            upstreamRes.resume();
            if (!isResponseClosed(res)) {
              res.end();
            }
            resolveOnce();
            return;
          }

          upstreamRes.once('error', () => {
            upstream.destroy();
            failProxyRequest(new Error('upstream response stream error'));
          });

          upstreamRes.pipe(res);
          upstreamRes.once('end', () => {
            console.log('[web][ipfs-proxy] end', {
              method,
              cid,
              statusCode: upstreamRes.statusCode || 0,
            });
            resolveOnce();
          });
        },
      );

      res.once('close', () => {
        console.log('[web][ipfs-proxy] client closed', {
          method,
          cid,
        });
        upstream.destroy();
        resolveOnce();
      });

      upstream.on('timeout', () => {
        console.warn('[web][ipfs-proxy] timeout', {
          method,
          cid,
          timeoutMs: 5000,
          range: req.headers.range || null,
        });
        upstream.destroy(new Error('ipfs gateway request timed out'));
      });

      upstream.once('error', (error) => {
        failProxyRequest(error);
      });

      upstream.end();
    });
  }

  private copyProxyHeaders(
    upstreamRes: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    Object.entries(upstreamRes.headers).forEach(([key, value]) => {
      if (value == null) return;
      const lower = key.toLowerCase();
      if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive') {
        return;
      }
      res.setHeader(key, value);
    });
  }

  private getWebPort(): number {
    const raw = (process.env.WTB_WEB_PORT || '').trim();
    if (!raw) return 8137;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
      throw new Error(`Invalid WTB_WEB_PORT: ${raw}`);
    }
    return parsed;
  }

  private getRequiredFirewallPorts(): FirewallPortDescriptor[] {
    return [{ name: 'web', port: this.getWebPort(), protocol: 'TCP' }];
  }

  private getWindowsFirewallPortStatuses(
    descriptors: FirewallPortDescriptor[],
  ): FirewallPortStatus[] {
    const uniqueDescriptors = descriptors.filter(
      (item, index, arr) =>
        arr.findIndex(
          (candidate) =>
            candidate.port === item.port && candidate.protocol === item.protocol,
        ) === index,
    );

    if (!isWindows) {
      return uniqueDescriptors.map((item) => ({
        ...item,
        allowed: false,
        rules: [],
        checked: false,
        error: 'unsupported platform',
      }));
    }

    const ports = uniqueDescriptors.map((item) => item.port);
    if (!ports.length) return [];

    const script = [
      `$ports = @(${ports.map((port) => psSingleQuote(String(port))).join(',')})`,
      '$results = @()',
      '$rules = Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue',
      'foreach ($rule in $rules) {',
      '  $filters = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue',
      '  foreach ($filter in $filters) {',
      "    if (([string]$filter.Protocol) -ne 'TCP') { continue }",
      '    $localPort = ([string]$filter.LocalPort).Trim()',
      "    if (-not $localPort) { continue }",
      "    if ($localPort -eq 'Any') { foreach ($requested in $ports) { $results += [pscustomobject]@{ Port = [int]$requested; Rule = $rule.DisplayName } }; continue }",
      "    foreach ($segment in ($localPort -split ',')) {",
      '      $item = $segment.Trim()',
      "      if (-not $item) { continue }",
      "      if ($item -match '^(\\d+)-(\\d+)$') {",
      '        $start = [int]$matches[1]',
      '        $end = [int]$matches[2]',
      '        foreach ($requested in $ports) { $requestedInt = [int]$requested; if ($requestedInt -ge $start -and $requestedInt -le $end) { $results += [pscustomobject]@{ Port = $requestedInt; Rule = $rule.DisplayName } } }',
      "      } elseif ($ports -contains $item) {",
      '        $results += [pscustomobject]@{ Port = [int]$item; Rule = $rule.DisplayName }',
      '      }',
      '    }',
      '  }',
      '}',
      '$out = foreach ($requested in $ports) {',
      '  $requestedInt = [int]$requested',
      '  $matched = @($results | Where-Object { $_.Port -eq $requestedInt } | Select-Object -ExpandProperty Rule -Unique)',
      '  [pscustomobject]@{ port = $requestedInt; allowed = ($matched.Count -gt 0); rules = @($matched) }',
      '}',
      '$out | ConvertTo-Json -Compress -Depth 4',
    ].join(' ');

    try {
      const { stdout } = this.runPowerShell(script);
      const raw = (stdout || '').trim();
      const parsed = raw ? (JSON.parse(raw) as any) : [];
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const byPort = new Map<number, { allowed: boolean; rules: string[] }>();
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const port = Number(item.port);
        if (!Number.isFinite(port)) continue;
        const rules = Array.isArray(item.rules)
          ? item.rules.filter(
              (rule: unknown): rule is string => typeof rule === 'string',
            )
          : [];
        byPort.set(port, {
          allowed: item.allowed === true,
          rules,
        });
      }

      return uniqueDescriptors.map((descriptor) => {
        const matched = byPort.get(descriptor.port);
        return {
          ...descriptor,
          allowed: matched?.allowed === true,
          rules: matched?.rules ?? [],
          checked: true,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return uniqueDescriptors.map((item) => ({
        ...item,
        allowed: false,
        rules: [],
        checked: false,
        error: message,
      }));
    }
  }

  private runPowerShell(
    command: string,
    options?: { ignoreStdio?: boolean },
  ): { stdout: string; stderr: string } {
    this.ensureWindowsOrThrow();
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      {
        encoding: 'utf8',
        windowsHide: true,
        stdio: options?.ignoreStdio ? 'ignore' : undefined,
      },
    );

    if (result.error) {
      throw result.error;
    }

    return {
      stdout: (result.stdout || '').toString(),
      stderr: (result.stderr || '').toString(),
    };
  }

  private destroyAllSockets(): void {
    for (const socket of Array.from(this.openSockets)) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.openSockets.clear();
  }

  private ensureWindowsOrThrow(): void {
    if (!isWindows) {
      throw new Error('This app currently only supports Windows.');
    }
  }
}
