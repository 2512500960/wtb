import fs from 'fs';
import * as http from 'http';
import type { Socket } from 'net';
import path from 'path';
import { URL } from 'url';

import { pathExists } from './fs_utils';

const isWindows = process.platform === 'win32';

const contentTypeFromPath = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.webmanifest':
      return 'application/manifest+json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.woff':
      return 'font/woff';
    case '.ttf':
      return 'font/ttf';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.wasm':
      return 'application/wasm';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
};

export class EmbeddedStaticServer {
  private server: http.Server | null = null;

  private listenPort: number | null = null;

  private rootDir: string | null = null;

  private openSockets = new Set<Socket>();

  constructor(
    private readonly options?: {
      fallbackConfigJson?: boolean;
    },
  ) {}

  async start(rootDir: string): Promise<number> {
    const resolvedRoot = path.resolve(rootDir);
    if (this.server && this.listenPort && this.rootDir === resolvedRoot) {
      return this.listenPort;
    }

    this.stop();

    const server = http.createServer(async (req, res) => {
      try {
        const method = (req.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
          res.statusCode = 405;
          res.end('Method Not Allowed');
          return;
        }

        const requestUrl = req.url || '/';
        const parsed = new URL(requestUrl, 'http://127.0.0.1');
        let pathname = parsed.pathname || '/';

        pathname = pathname.replace(/\\/g, '/');
        if (!pathname.startsWith('/')) pathname = `/${pathname}`;

        let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
        if (!rel || pathname.endsWith('/')) {
          rel = 'index.html';
        }
        const safeRel = path.normalize(rel).replace(/^([A-Za-z]:)?[\\/]+/, '');

        const fileResolved = path.resolve(resolvedRoot, safeRel);
        const rootPrefix = resolvedRoot + path.sep;
        const inRoot = isWindows
          ? fileResolved.toLowerCase().startsWith(rootPrefix.toLowerCase())
          : fileResolved.startsWith(rootPrefix);
        if (!inRoot) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        let filePath = fileResolved;

        if (!(await pathExists(filePath))) {
          const shouldTryFallback = this.options?.fallbackConfigJson === true;
          const base = path.basename(filePath).toLowerCase();
          if (
            shouldTryFallback &&
            base.startsWith('config.') &&
            base.endsWith('.json')
          ) {
            const fallback = path.join(resolvedRoot, 'config.json');
            if (await pathExists(fallback)) {
              filePath = fallback;
            } else {
              res.statusCode = 404;
              res.setHeader('Content-Type', 'text/plain; charset=utf-8');
              res.end('Not Found');
              return;
            }
          } else {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('Not Found');
            return;
          }
        }

        const contentType = contentTypeFromPath(filePath);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');

        if (method === 'HEAD') {
          res.statusCode = 200;
          res.end();
          return;
        }

        const buf = await fs.promises.readFile(filePath);
        res.statusCode = 200;
        res.end(buf);
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(error instanceof Error ? error.message : 'Internal Server Error');
      }
    });

    server.on('connection', (socket: Socket) => {
      this.openSockets.add(socket);
      socket.on('close', () => this.openSockets.delete(socket));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      server.close();
      throw new Error('Embedded static server failed to start');
    }

    this.server = server;
    this.listenPort = addr.port;
    this.rootDir = resolvedRoot;
    return addr.port;
  }

  stop(): void {
    if (!this.server) return;

    try {
      for (const socket of Array.from(this.openSockets)) {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
      this.openSockets.clear();
      this.server.close();
    } catch {
      // ignore
    } finally {
      this.server = null;
      this.listenPort = null;
      this.rootDir = null;
    }
  }
}
