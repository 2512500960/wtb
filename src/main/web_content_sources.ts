import fs from 'fs';
import path from 'path';

import { isUnderDir } from './fs_utils';
import type { IpfsSidecarManager } from './ipfs_manager';
import {
  guessContentType,
  parseAndNormalizeUrlPath,
  urlPathToFsPath,
} from './web_service_utils';

export type WebContentSourceMode = 'local' | 'dual' | 'ipfs-backed';

type StoredWebContentSourceEntry = {
  path: string;
  sourceMode: Exclude<WebContentSourceMode, 'local'>;
  cid: string;
  size: number;
  mtimeMs: number;
  mime?: string;
};

type WebContentSourceManifest = {
  version: 1;
  entries: Record<string, StoredWebContentSourceEntry>;
};

export type WebContentDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  mime?: string;
  cid?: string;
  sourceMode: WebContentSourceMode;
  fsPath?: string;
  localPresent: boolean;
  virtual?: boolean;
};

export type ResolvedWebContentPath =
  | {
      kind: 'directory';
      entry: WebContentDirectoryEntry;
      physical: boolean;
    }
  | {
      kind: 'local-file';
      entry: WebContentDirectoryEntry;
      fsPath: string;
      stat: fs.Stats;
    }
  | {
      kind: 'ipfs-file';
      entry: WebContentDirectoryEntry;
      cid: string;
    };

const MANIFEST_FILE_NAME = '.wtb-content-sources.json';

const normalizeManifestPath = (inputPath: string): string => {
  const normalized = path.posix.normalize(inputPath || '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

const getManifestPath = (webRoot: string): string => {
  return path.join(webRoot, MANIFEST_FILE_NAME);
};

const writeWebContentSourceManifest = (
  webRoot: string,
  manifest: WebContentSourceManifest,
): void => {
  const manifestPath = getManifestPath(webRoot);
  const tmpPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, manifestPath);
};

const getDefaultManifest = (): WebContentSourceManifest => ({
  version: 1,
  entries: {},
});

export const readWebContentSourceManifest = (
  webRoot: string,
): WebContentSourceManifest => {
  const manifestPath = getManifestPath(webRoot);
  try {
    if (!fs.existsSync(manifestPath)) return getDefaultManifest();
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WebContentSourceManifest>;
    const entries =
      parsed && parsed.entries && typeof parsed.entries === 'object'
        ? (parsed.entries as Record<string, StoredWebContentSourceEntry>)
        : {};

    const normalizedEntries: Record<string, StoredWebContentSourceEntry> = {};
    Object.values(entries).forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      if (!entry.cid || typeof entry.cid !== 'string') return;
      if (entry.sourceMode !== 'dual' && entry.sourceMode !== 'ipfs-backed')
        return;
      const normalizedPath = normalizeManifestPath(entry.path);
      normalizedEntries[normalizedPath] = {
        path: normalizedPath,
        sourceMode: entry.sourceMode,
        cid: entry.cid,
        size: Number.isFinite(entry.size) ? entry.size : 0,
        mtimeMs: Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : 0,
        mime: typeof entry.mime === 'string' ? entry.mime : undefined,
      };
    });

    return {
      version: 1,
      entries: normalizedEntries,
    };
  } catch {
    return getDefaultManifest();
  }
};

const getStoredEntryForPath = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentSourceEntry | null => {
  return manifest.entries[normalizedPath] || null;
};

const listStoredChildren = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentSourceEntry[] => {
  return Object.values(manifest.entries).filter((entry) => {
    return path.posix.dirname(entry.path) === normalizedPath;
  });
};

const hasStoredDescendants = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): boolean => {
  const prefix = normalizedPath === '/' ? '/' : `${normalizedPath}/`;
  return Object.keys(manifest.entries).some((entryPath) => {
    return entryPath !== normalizedPath && entryPath.startsWith(prefix);
  });
};

const listVirtualDirectories = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): WebContentDirectoryEntry[] => {
  const prefix = normalizedPath === '/' ? '/' : `${normalizedPath}/`;
  const virtualDirs = new Map<string, WebContentDirectoryEntry>();

  Object.keys(manifest.entries).forEach((entryPath) => {
    if (!entryPath.startsWith(prefix)) return;
    const remainder = entryPath.slice(prefix.length);
    if (!remainder || !remainder.includes('/')) return;
    const [firstSegment] = remainder.split('/');
    if (!firstSegment || virtualDirs.has(firstSegment)) return;
    const childPath = path.posix.join(
      normalizedPath === '/' ? '' : normalizedPath,
      firstSegment,
    );
    const normalizedChildPath = `/${childPath.replace(/^\/+/, '')}`;
    virtualDirs.set(firstSegment, {
      name: firstSegment,
      path: normalizedChildPath,
      isDirectory: true,
      size: 0,
      mtimeMs: 0,
      sourceMode: 'local',
      localPresent: false,
      virtual: true,
    });
  });

  return [...virtualDirs.values()];
};

export const listWebContentDirectoryEntries = (opts: {
  webRoot: string;
  requestedPath: string | undefined;
}): WebContentDirectoryEntry[] => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  const targetDir = urlPathToFsPath(opts.webRoot, normalizedPath);
  if (!isUnderDir(targetDir, opts.webRoot)) {
    throw new Error('Forbidden');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);

  let physicalDirExists = false;
  if (fs.existsSync(targetDir)) {
    const stat = fs.statSync(targetDir);
    if (!stat.isDirectory()) {
      throw new Error('Not Found');
    }
    physicalDirExists = true;
  }

  const storedChildren = listStoredChildren(manifest, normalizedPath);
  const virtualDirectories = listVirtualDirectories(manifest, normalizedPath);

  if (
    !physicalDirExists &&
    storedChildren.length === 0 &&
    virtualDirectories.length === 0
  ) {
    throw new Error('Not Found');
  }

  const entriesByName = new Map<string, WebContentDirectoryEntry>();

  if (physicalDirExists) {
    const dirEntries = fs.readdirSync(targetDir, { withFileTypes: true });
    dirEntries.forEach((entry) => {
      if (entry.name === MANIFEST_FILE_NAME) return;
      const childPath = path.join(targetDir, entry.name);
      let childStat: fs.Stats | null = null;
      try {
        childStat = fs.statSync(childPath);
      } catch {
        childStat = null;
      }

      const entryUrlPath = path.posix.join(
        normalizedPath === '/' ? '' : normalizedPath,
        entry.name,
      );
      const normalizedEntryPath = `/${entryUrlPath.replace(/^\/+/, '')}`;
      entriesByName.set(entry.name, {
        name: entry.name,
        path: normalizedEntryPath,
        isDirectory: entry.isDirectory(),
        size: childStat?.isFile() ? childStat.size : 0,
        mtimeMs: childStat?.mtimeMs ?? 0,
        mime:
          childStat?.isFile() && !entry.isDirectory()
            ? guessContentType(childPath)
            : undefined,
        sourceMode: 'local',
        fsPath: childPath,
        localPresent: childStat != null,
      });
    });
  }

  storedChildren.forEach((stored) => {
    const entryName = path.posix.basename(stored.path);
    const localFsPath = urlPathToFsPath(opts.webRoot, stored.path);
    const localStat =
      fs.existsSync(localFsPath) && fs.statSync(localFsPath).isFile()
        ? fs.statSync(localFsPath)
        : null;
    const existing = entriesByName.get(entryName);
    if (existing && existing.isDirectory) return;

    entriesByName.set(entryName, {
      name: entryName,
      path: stored.path,
      isDirectory: false,
      size: stored.size || localStat?.size || 0,
      mtimeMs: stored.mtimeMs || localStat?.mtimeMs || 0,
      mime: stored.mime || guessContentType(localFsPath),
      cid: stored.cid,
      sourceMode: stored.sourceMode,
      fsPath: localStat ? localFsPath : undefined,
      localPresent: !!localStat,
    });
  });

  virtualDirectories.forEach((entry) => {
    if (entriesByName.has(entry.name)) return;
    entriesByName.set(entry.name, entry);
  });

  return [...entriesByName.values()].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  });
};

export const resolveWebContentPath = (opts: {
  webRoot: string;
  requestedPath: string | undefined;
}): ResolvedWebContentPath => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  const fsPath = urlPathToFsPath(opts.webRoot, normalizedPath);
  if (!isUnderDir(fsPath, opts.webRoot)) {
    throw new Error('Forbidden');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const stored = getStoredEntryForPath(manifest, normalizedPath);

  if (fs.existsSync(fsPath)) {
    const stat = fs.statSync(fsPath);
    if (stat.isDirectory()) {
      return {
        kind: 'directory',
        physical: true,
        entry: {
          name: path.posix.basename(normalizedPath) || '/',
          path: normalizedPath,
          isDirectory: true,
          size: 0,
          mtimeMs: stat.mtimeMs,
          sourceMode: 'local',
          fsPath,
          localPresent: true,
        },
      };
    }

    if (stat.isFile()) {
      if (stored?.sourceMode === 'ipfs-backed' && stored.cid) {
        return {
          kind: 'ipfs-file',
          cid: stored.cid,
          entry: {
            name: path.posix.basename(normalizedPath),
            path: normalizedPath,
            isDirectory: false,
            size: stored.size || stat.size,
            mtimeMs: stored.mtimeMs || stat.mtimeMs,
            mime: stored.mime || guessContentType(fsPath),
            cid: stored.cid,
            sourceMode: stored.sourceMode,
            fsPath,
            localPresent: true,
          },
        };
      }

      return {
        kind: 'local-file',
        fsPath,
        stat,
        entry: {
          name: path.posix.basename(normalizedPath),
          path: normalizedPath,
          isDirectory: false,
          size: stored?.size || stat.size,
          mtimeMs: stored?.mtimeMs || stat.mtimeMs,
          mime: stored?.mime || guessContentType(fsPath),
          cid: stored?.cid,
          sourceMode: stored?.sourceMode || 'local',
          fsPath,
          localPresent: true,
        },
      };
    }
  }

  if (stored?.cid) {
    return {
      kind: 'ipfs-file',
      cid: stored.cid,
      entry: {
        name: path.posix.basename(normalizedPath),
        path: normalizedPath,
        isDirectory: false,
        size: stored.size,
        mtimeMs: stored.mtimeMs,
        mime: stored.mime || guessContentType(fsPath),
        cid: stored.cid,
        sourceMode: stored.sourceMode,
        localPresent: false,
      },
    };
  }

  if (hasStoredDescendants(manifest, normalizedPath)) {
    return {
      kind: 'directory',
      physical: false,
      entry: {
        name: path.posix.basename(normalizedPath) || '/',
        path: normalizedPath,
        isDirectory: true,
        size: 0,
        mtimeMs: 0,
        sourceMode: 'local',
        localPresent: false,
        virtual: true,
      },
    };
  }

  throw new Error('Not Found');
};

export const upsertWebContentSourceEntry = (opts: {
  webRoot: string;
  path: string;
  sourceMode: Exclude<WebContentSourceMode, 'local'>;
  cid: string;
  size: number;
  mtimeMs: number;
  mime?: string;
}): void => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const normalizedPath = parseAndNormalizeUrlPath(opts.path);
  manifest.entries[normalizedPath] = {
    path: normalizedPath,
    sourceMode: opts.sourceMode,
    cid: opts.cid,
    size: opts.size,
    mtimeMs: opts.mtimeMs,
    mime: opts.mime,
  };
  writeWebContentSourceManifest(opts.webRoot, manifest);
};

export const removeWebContentSourceEntry = (opts: {
  webRoot: string;
  path: string;
}): void => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const normalizedPath = parseAndNormalizeUrlPath(opts.path);
  if (!manifest.entries[normalizedPath]) return;
  delete manifest.entries[normalizedPath];
  writeWebContentSourceManifest(opts.webRoot, manifest);
};

export const convertLocalFileToIpfsSource = async (opts: {
  webRoot: string;
  requestedPath: string;
  ipfsManager: IpfsSidecarManager;
  removeLocalFile?: boolean;
}): Promise<{
  path: string;
  cid: string;
  sourceMode: Exclude<WebContentSourceMode, 'local'>;
  removedLocalFile: boolean;
}> => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  const fsPath = urlPathToFsPath(opts.webRoot, normalizedPath);
  if (!isUnderDir(fsPath, opts.webRoot)) {
    throw new Error('Forbidden');
  }
  if (!fs.existsSync(fsPath)) {
    throw new Error('Not Found');
  }

  const stat = fs.statSync(fsPath);
  if (!stat.isFile()) {
    throw new Error('仅支持将文件转换为 IPFS 内容源。');
  }

  const result = await opts.ipfsManager.ensurePathCached(fsPath, {
    wrapWithDirectory: false,
  });
  const sourceMode = opts.removeLocalFile ? 'ipfs-backed' : 'dual';

  upsertWebContentSourceEntry({
    webRoot: opts.webRoot,
    path: normalizedPath,
    sourceMode,
    cid: result.cid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: guessContentType(fsPath),
  });

  if (opts.removeLocalFile) {
    fs.unlinkSync(fsPath);
  }

  return {
    path: normalizedPath,
    cid: result.cid,
    sourceMode,
    removedLocalFile: opts.removeLocalFile === true,
  };
};
