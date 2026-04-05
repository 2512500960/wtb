import { spawnSync } from 'child_process';
import fs from 'fs';
import * as http from 'http';
import type { Socket } from 'net';
import path from 'path';
import { URL } from 'url';
import type { App } from 'electron';

import { ensureDirExists, isUnderDir } from './fs_utils';
import type { IpfsSidecarManager } from './ipfs_manager';
import { ensureMediaDirs } from './mediaServer';
import type {
  FirewallPortDescriptor,
  FirewallPortStatus,
  ServiceStatus,
} from './service_types';
import { ensureDefaultWebAssets } from './web_assets';
import { buildWebResourceManifest } from './web_resource_manifest';
import {
  guessContentType,
  parseAndNormalizeUrlPath,
  parseByteRange,
  renderDirectoryIndexHtml,
  sendJson,
  urlPathToFsPath,
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

export class WebServiceManager {
  private server: http.Server | null = null;

  private listenAddress: string | null = null;

  private listenPort: number | null = null;

  private readonly openSockets = new Set<Socket>();

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
    ensureMediaDirs(webRoot);

    const server = http.createServer(async (req, res) => {
      try {
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
          const targetPath = urlPathToFsPath(webRoot, normalizedPath);

          if (!isUnderDir(targetPath, webRoot)) {
            sendJson(req, res, 403, { success: false, error: 'Forbidden' });
            return;
          }

          if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
            sendJson(req, res, 404, { success: false, error: 'Not Found' });
            return;
          }

          let entries = fs
            .readdirSync(targetPath, { withFileTypes: true })
            .map((entry) => {
              const childPath = path.join(targetPath, entry.name);
              const childStat = fs.statSync(childPath);
              const childUrlPath = path.posix.join(
                normalizedPath === '/' ? '' : normalizedPath,
                entry.name,
              );
              return {
                name: entry.name,
                path: `/${childUrlPath.replace(/^\/+/, '')}`,
                isDirectory: entry.isDirectory(),
                size: childStat.isFile() ? childStat.size : 0,
                mtimeMs: childStat.mtimeMs,
              };
            })
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
              return a.name.localeCompare(b.name, 'zh-CN', {
                numeric: true,
                sensitivity: 'base',
              });
            });

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

        const fsPath = urlPathToFsPath(webRoot, urlPath);
        if (!isUnderDir(fsPath, webRoot)) {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Forbidden');
          return;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(fsPath);
        } catch {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Not Found');
          return;
        }

        if (stat.isDirectory()) {
          if (!urlPath.endsWith('/')) {
            res.statusCode = 301;
            res.setHeader('Location', `${urlPath}/`);
            res.end();
            return;
          }

          try {
            const indexCandidates = ['index.html', 'index.htm'];
            for (const candidate of indexCandidates) {
              const idxPath = path.join(fsPath, candidate);
              if (!fs.existsSync(idxPath)) continue;
              const idxStat = fs.statSync(idxPath);
              if (!idxStat.isFile()) continue;

              res.statusCode = 200;
              res.setHeader('Content-Type', guessContentType(idxPath));
              res.setHeader('Content-Length', String(idxStat.size));
              res.setHeader('Last-Modified', idxStat.mtime.toUTCString());
              if (method === 'HEAD') {
                res.end();
                return;
              }

              const stream = fs.createReadStream(idxPath);
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
          } catch {
            // ignore and fall back to directory listing
          }

          const dirents = fs.readdirSync(fsPath, { withFileTypes: true });
          const entries = dirents
            .map((entry) => {
              const childPath = path.join(fsPath, entry.name);
              let childStat: fs.Stats | null = null;
              try {
                childStat = fs.statSync(childPath);
              } catch {
                childStat = null;
              }
              return {
                name: entry.name,
                isDir: entry.isDirectory(),
                size: childStat?.isFile() ? childStat.size : 0,
                mtimeMs: childStat?.mtimeMs ?? 0,
              };
            })
            .sort((a, b) => {
              if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
              return a.name.localeCompare(b.name, 'zh-CN', {
                numeric: true,
                sensitivity: 'base',
              });
            });

          const html = renderDirectoryIndexHtml({ urlPath, entries });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(method === 'HEAD' ? undefined : html);
          return;
        }

        if (stat.isFile()) {
          const range = parseByteRange(req.headers.range, stat.size);
          res.setHeader('Content-Type', guessContentType(fsPath));
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
            res.setHeader(
              'Content-Range',
              `bytes ${range.start}-${range.end}/${stat.size}`,
            );
            if (method === 'HEAD') {
              res.end();
              return;
            }

            const stream = fs.createReadStream(fsPath, {
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
          const stream = fs.createReadStream(fsPath);
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
