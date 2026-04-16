import fs from 'fs';
import os from 'os';
import path from 'path';

import type { IpfsCidReleaseResult, IpfsSidecarManager } from '../main/ipfs_manager';
import {
  deleteManagedWebEntry,
  migrateWebContentToManagedIpfs,
  normalizeReservedLocalWebPaths,
} from '../main/web_content_sources';

const MANIFEST_FILE_NAME = '.wtb-content-sources.json';

const writeManifest = (
  webRoot: string,
  entries: Record<string, unknown>,
): void => {
  fs.writeFileSync(
    path.join(webRoot, MANIFEST_FILE_NAME),
    `${JSON.stringify({ version: 2, entries }, null, 2)}\n`,
    'utf8',
  );
};

const readManifestEntries = (webRoot: string): Record<string, unknown> => {
  const manifestText = fs.readFileSync(path.join(webRoot, MANIFEST_FILE_NAME), 'utf8');
  return (JSON.parse(manifestText) as { entries: Record<string, unknown> }).entries;
};

const createMockIpfsManager = (
  result?: Partial<IpfsCidReleaseResult>,
): {
  ipfsManager: IpfsSidecarManager;
  releaseCids: jest.Mock;
  ensurePathCached: jest.Mock;
} => {
  const releaseCids = jest.fn().mockResolvedValue({
    releasedCids: [],
    failedCids: [],
    gcCompleted: false,
    ...result,
  });
  const ensurePathCached = jest.fn().mockResolvedValue({
    cid: 'cid-default',
    path: '',
    cached: false,
  });

  return {
    ipfsManager: {
      releaseCids,
      ensurePathCached,
    } as unknown as IpfsSidecarManager,
    releaseCids,
    ensurePathCached,
  };
};

describe('reserved local web assets', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-web-shell-'));
  });

  afterEach(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  test('normalizes reserved shell entries back to local files', async () => {
    writeManifest(webRoot, {
      '/index.html': {
        kind: 'file',
        path: '/index.html',
        sourceMode: 'ipfs-backed',
        cid: 'cid-index',
        size: 10,
        mtimeMs: 1,
      },
      '/vendor': {
        kind: 'directory',
        path: '/vendor',
        mtimeMs: 1,
      },
      '/vendor/plyr.css': {
        kind: 'file',
        path: '/vendor/plyr.css',
        sourceMode: 'ipfs-backed',
        cid: 'cid-css',
        size: 20,
        mtimeMs: 1,
      },
      '/video/movie.mp4': {
        kind: 'file',
        path: '/video/movie.mp4',
        sourceMode: 'ipfs-backed',
        cid: 'cid-video',
        size: 30,
        mtimeMs: 1,
      },
    });
    const { ipfsManager, releaseCids } = createMockIpfsManager({
      releasedCids: ['cid-index', 'cid-css'],
      gcCompleted: true,
    });

    const result = await normalizeReservedLocalWebPaths({
      webRoot,
      ipfsManager,
    });

    expect(releaseCids).toHaveBeenCalledWith(['cid-index', 'cid-css']);
    expect(result.normalizedPaths).toEqual([
      '/index.html',
      '/vendor',
      '/vendor/plyr.css',
    ]);
    expect(readManifestEntries(webRoot)).toEqual({
      '/video/movie.mp4': {
        kind: 'file',
        path: '/video/movie.mp4',
        sourceMode: 'ipfs-backed',
        cid: 'cid-video',
        size: 30,
        mtimeMs: 1,
      },
    });
  });

  test('keeps reserved shell files local during migration', async () => {
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<html></html>\n', 'utf8');
    fs.mkdirSync(path.join(webRoot, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'vendor', 'plyr.css'), 'body {}\n', 'utf8');
    fs.mkdirSync(path.join(webRoot, 'video'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'video', 'movie.mp4'), Buffer.alloc(8));

    const { ipfsManager, ensurePathCached } = createMockIpfsManager();
    ensurePathCached.mockResolvedValue({
      cid: 'cid-video',
      path: path.join(webRoot, 'video', 'movie.mp4'),
      cached: false,
    });

    const result = await migrateWebContentToManagedIpfs({
      webRoot,
      ipfsManager,
    });

    expect(result.migratedFiles).toBe(1);
    expect(ensurePathCached).toHaveBeenCalledTimes(1);
    expect(ensurePathCached).toHaveBeenCalledWith(
      path.join(webRoot, 'video', 'movie.mp4'),
      { wrapWithDirectory: false },
    );
    expect(fs.existsSync(path.join(webRoot, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'vendor', 'plyr.css'))).toBe(true);
    expect(fs.existsSync(path.join(webRoot, 'video', 'movie.mp4'))).toBe(false);
    expect(readManifestEntries(webRoot)).toEqual({
      '/video': {
        kind: 'directory',
        path: '/video',
        mtimeMs: expect.any(Number),
      },
      '/video/movie.mp4': {
        kind: 'file',
        path: '/video/movie.mp4',
        sourceMode: 'ipfs-backed',
        cid: 'cid-video',
        size: 8,
        mtimeMs: expect.any(Number),
        mime: 'video/mp4',
      },
    });
  });
});

describe('deleteManagedWebEntry', () => {
  let webRoot: string;

  beforeEach(() => {
    webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-web-content-'));
  });

  afterEach(() => {
    fs.rmSync(webRoot, { recursive: true, force: true });
  });

  test('releases orphaned cid after deleting an ipfs-backed file', async () => {
    writeManifest(webRoot, {
      '/keep.txt': {
        kind: 'file',
        path: '/keep.txt',
        sourceMode: 'ipfs-backed',
        cid: 'cid-keep',
        size: 10,
        mtimeMs: 1,
      },
      '/remove.txt': {
        kind: 'file',
        path: '/remove.txt',
        sourceMode: 'ipfs-backed',
        cid: 'cid-remove',
        size: 20,
        mtimeMs: 2,
      },
    });
    const { ipfsManager, releaseCids } = createMockIpfsManager({
      releasedCids: ['cid-remove'],
      gcCompleted: true,
    });

    const result = await deleteManagedWebEntry({
      webRoot,
      requestedPath: '/remove.txt',
      ipfsManager,
    });

    expect(releaseCids).toHaveBeenCalledTimes(1);
    expect(releaseCids).toHaveBeenCalledWith(['cid-remove']);
    expect(result.removedPaths).toEqual(['/remove.txt']);
    expect(result.releasedCids).toEqual(['cid-remove']);
    expect(result.cleanupIssues).toEqual([]);
    expect(readManifestEntries(webRoot)).toEqual({
      '/keep.txt': {
        kind: 'file',
        path: '/keep.txt',
        sourceMode: 'ipfs-backed',
        cid: 'cid-keep',
        size: 10,
        mtimeMs: 1,
      },
    });
  });

  test('does not release a cid that is still referenced by another entry', async () => {
    writeManifest(webRoot, {
      '/first.txt': {
        kind: 'file',
        path: '/first.txt',
        sourceMode: 'ipfs-backed',
        cid: 'cid-shared',
        size: 10,
        mtimeMs: 1,
      },
      '/second.txt': {
        kind: 'file',
        path: '/second.txt',
        sourceMode: 'dual',
        cid: 'cid-shared',
        size: 10,
        mtimeMs: 1,
      },
    });
    const { ipfsManager, releaseCids } = createMockIpfsManager();

    const result = await deleteManagedWebEntry({
      webRoot,
      requestedPath: '/first.txt',
      ipfsManager,
    });

    expect(releaseCids).not.toHaveBeenCalled();
    expect(result.removedPaths).toEqual(['/first.txt']);
    expect(result.releasedCids).toEqual([]);
    expect(result.cleanupIssues).toEqual([]);
    expect(readManifestEntries(webRoot)).toEqual({
      '/second.txt': {
        kind: 'file',
        path: '/second.txt',
        sourceMode: 'dual',
        cid: 'cid-shared',
        size: 10,
        mtimeMs: 1,
      },
    });
  });
});
