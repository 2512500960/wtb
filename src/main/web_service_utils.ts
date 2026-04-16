import * as http from 'http';
import path from 'path';
import { URL } from 'url';

export const escapeHtml = (input: string): string => {
  return (input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(value >= 10 || idx === 0 ? 1 : 2)} ${units[idx]}`;
};

export const guessContentType = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.txt':
    case '.log':
    case '.md':
    case '.ini':
    case '.conf':
    case '.yaml':
    case '.yml':
      return 'text/plain; charset=utf-8';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.ogv':
      return 'video/ogg';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    case '.ogg':
      return 'audio/ogg';
    case '.pdf':
      return 'application/pdf';
    case '.zip':
      return 'application/zip';
    case '.7z':
      return 'application/x-7z-compressed';
    case '.gz':
      return 'application/gzip';
    case '.tar':
      return 'application/x-tar';
    case '.wasm':
      return 'application/wasm';
    default:
      return 'application/octet-stream';
  }
};

export const parseAndNormalizeUrlPath = (rawUrl: string | undefined): string => {
  const url = new URL(rawUrl || '/', 'http://localhost');
  let decodedPath = url.pathname;
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    throw new Error('Bad Request');
  }

  const normalized = path.posix.normalize(decodedPath);
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  if (withSlash === '/..' || withSlash.startsWith('/../')) {
    throw new Error('Forbidden');
  }
  return withSlash;
};

export const urlPathToFsPath = (rootDir: string, urlPath: string): string => {
  const rel = urlPath.replace(/^\/+/, '');
  const segments = rel.split('/').filter(Boolean);
  return path.join(rootDir, ...segments);
};

export const sendJson = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  const text = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(Buffer.byteLength(text)));
  if ((req.method || 'GET').toUpperCase() === 'HEAD') {
    res.end();
    return;
  }
  res.end(text);
};

export const parseByteRange = (
  rangeHeader: string | string[] | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' => {
  const headerValue = Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader;
  if (!headerValue) {
    return null;
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(headerValue.trim());
  if (!match) {
    return 'invalid';
  }

  const [, startText, endText] = match;
  if (!startText && !endText) {
    return 'invalid';
  }

  if (!startText) {
    const suffixLength = Number.parseInt(endText, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0 || size <= 0) {
      return 'invalid';
    }
    const start = Math.max(size - suffixLength, 0);
    return { start, end: size - 1 };
  }

  const start = Number.parseInt(startText, 10);
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return 'invalid';
  }

  if (!endText) {
    return { start, end: size - 1 };
  }

  const end = Number.parseInt(endText, 10);
  if (!Number.isFinite(end) || end < start) {
    return 'invalid';
  }

  return { start, end: Math.min(end, size - 1) };
};

export const renderDirectoryIndexHtml = (opts: {
  urlPath: string;
  entries: Array<{
    name: string;
    isDir: boolean;
    size: number;
    mtimeMs: number;
  }>;
}): string => {
  const { urlPath, entries } = opts;
  const title = `Index of ${urlPath}`;
  const safeTitle = escapeHtml(title);

  const parts = urlPath.split('/').filter(Boolean);
  const crumbs: string[] = ['<a href="/">/</a>'];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    const href = `${acc}/`;
    crumbs.push(`<a href="${href}">${escapeHtml(part)}/</a>`);
  }

  const rows: string[] = [];
  if (urlPath !== '/') {
    const up =
      urlPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '';
    const parentHref = `${up}/` || '/';
    rows.push(
      `<tr><td><a href="${parentHref}">..</a></td><td class="meta">-</td><td class="meta">-</td></tr>`,
    );
  }

  for (const entry of entries) {
    const suffix = entry.isDir ? '/' : '';
    const href = `${urlPath}${encodeURIComponent(entry.name)}${suffix}`;
    const displayName = escapeHtml(entry.name + suffix);
    const mtime = entry.mtimeMs ? new Date(entry.mtimeMs).toLocaleString() : '-';
    const size = entry.isDir ? '-' : formatBytes(entry.size);
    rows.push(
      `<tr><td><a href="${href}">${displayName}</a></td><td class="meta">${escapeHtml(
        String(mtime),
      )}</td><td class="meta">${escapeHtml(String(size))}</td></tr>`,
    );
  }

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 16px; }
      h1 { font-size: 18px; margin: 0 0 12px; }
      .crumbs { margin: 0 0 12px; color: #444; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; }
      th { font-weight: 600; color: #333; }
      a { color: #0b57d0; text-decoration: none; }
      a:hover { text-decoration: underline; }
      .meta { white-space: nowrap; color: #555; font-variant-numeric: tabular-nums; }
      .footer { margin-top: 16px; color: #777; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>${safeTitle}</h1>
    <div class="crumbs">${crumbs.join(' ')}</div>
    <table>
      <thead>
        <tr><th>名称</th><th class="meta">修改时间</th><th class="meta">大小</th></tr>
      </thead>
      <tbody>
        ${rows.join('\n')}
      </tbody>
    </table>
    <div class="footer">WTB Web 索引（目录：wtb-data/web）</div>
  </body>
</html>`;
};
