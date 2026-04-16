import fs from 'fs';
import path from 'path';

import { isUnderDir } from './fs_utils';
import type { IpfsCidReleaseResult, IpfsSidecarManager } from './ipfs_manager';
import {
  guessContentType,
  parseAndNormalizeUrlPath,
  urlPathToFsPath,
} from './web_service_utils';

export type WebContentSourceMode = 'local' | 'dual' | 'ipfs-backed';

type StoredWebContentFileEntry = {
  kind: 'file';
  path: string;
  sourceMode: Exclude<WebContentSourceMode, 'local'>;
  cid: string;
  size: number;
  mtimeMs: number;
  mime?: string;
};

type StoredWebContentDirectoryRecord = {
  kind: 'directory';
  path: string;
  mtimeMs: number;
};

type StoredWebContentEntry =
  | StoredWebContentFileEntry
  | StoredWebContentDirectoryRecord;

type WebContentSourceManifest = {
  version: 2;
  entries: Record<string, StoredWebContentEntry>;
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
const SIMPLE_MODE_AUTO_CONVERT_THRESHOLD_BYTES = 5 * 1024 * 1024;
const RESERVED_LOCAL_WEB_FILE_PATHS = new Set(['/index.html']);
const RESERVED_LOCAL_WEB_DIRECTORY_PATH = '/vendor';

export type SyncWebContentWithIpfsResult = {
  thresholdBytes: number;
  scannedFiles: number;
  syncedFiles: number;
  unchangedManagedFiles: number;
  skippedSmallFiles: number;
  staleManifestEntries: number;
  syncedPaths: string[];
  stalePaths: string[];
  failures: Array<{ path: string; error: string }>;
};

export type ImportManagedWebContentResult = {
  importedFiles: number;
  importedDirectories: number;
  overwrittenPaths: string[];
  paths: string[];
  releasedCids?: string[];
  cleanupIssues?: string[];
};

type ManagedWebCidCleanupResult = {
  releasedCids: string[];
  cleanupIssues: string[];
};

type ManagedWebImportProgress = {
  current: number;
  total: number;
  message: string;
  currentBytes?: number;
  totalBytes?: number;
};

export type ManagedWebPasteOperation = 'copy' | 'move';

export type PasteManagedWebContentResult = {
  operationType: ManagedWebPasteOperation;
  paths: string[];
};

const normalizeManifestPath = (inputPath: string): string => {
  const normalized = path.posix.normalize(inputPath || '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

export const isReservedLocalWebPath = (inputPath: string): boolean => {
  const normalizedPath = normalizeManifestPath(inputPath);
  return (
    RESERVED_LOCAL_WEB_FILE_PATHS.has(normalizedPath)
    || normalizedPath === RESERVED_LOCAL_WEB_DIRECTORY_PATH
    || normalizedPath.startsWith(`${RESERVED_LOCAL_WEB_DIRECTORY_PATH}/`)
  );
};

const getParentPath = (inputPath: string): string => {
  const normalizedPath = normalizeManifestPath(inputPath);
  if (normalizedPath === '/') {
    return '/';
  }

  const parentPath = path.posix.dirname(normalizedPath);
  return normalizeManifestPath(parentPath === '.' ? '/' : parentPath);
};

const getManifestPath = (webRoot: string): string => {
  return path.join(webRoot, MANIFEST_FILE_NAME);
};

const getUrlPathFromFsPath = (webRoot: string, fsPath: string): string => {
  const relativePath = path.relative(webRoot, fsPath);
  const posixPath = relativePath.split(path.sep).join('/');
  return normalizeManifestPath(`/${posixPath}`);
};

const ensureSafeManagedName = (name: string): string => {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('名称不能为空。');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('名称不能包含路径分隔符。');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('名称无效。');
  }
  return trimmed;
};

const listPhysicalFilesRecursively = (rootDir: string): string[] => {
  const files: string[] = [];

  const visit = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      if (entry.name === MANIFEST_FILE_NAME) return;

      const childPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(childPath);
        return;
      }

      if (entry.isFile()) {
        files.push(childPath);
      }
    });
  };

  if (fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory()) {
    visit(rootDir);
  }

  return files;
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
  version: 2,
  entries: {},
});

const EMPTY_MANAGED_WEB_CID_CLEANUP_RESULT: ManagedWebCidCleanupResult = {
  releasedCids: [],
  cleanupIssues: [],
};

const isStoredWebContentFileEntry = (
  entry: StoredWebContentEntry | null | undefined,
): entry is StoredWebContentFileEntry => {
  return !!entry && entry.kind === 'file';
};

const isStoredWebContentDirectoryRecord = (
  entry: StoredWebContentEntry | null | undefined,
): entry is StoredWebContentDirectoryRecord => {
  return !!entry && entry.kind === 'directory';
};

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
        ? (parsed.entries as Record<string, Record<string, unknown>>)
        : {};

    const normalizedEntries: Record<string, StoredWebContentEntry> = {};
    Object.values(entries).forEach((entry) => {
      if (!entry || typeof entry !== 'object') return;
      const normalizedPath = normalizeManifestPath(String(entry.path || '/'));
      if (entry.kind === 'directory') {
        if (normalizedPath === '/') return;
        normalizedEntries[normalizedPath] = {
          kind: 'directory',
          path: normalizedPath,
          mtimeMs:
            typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
              ? entry.mtimeMs
              : 0,
        };
        return;
      }

      if (typeof entry.cid !== 'string' || !entry.cid) return;
      if (entry.sourceMode !== 'dual' && entry.sourceMode !== 'ipfs-backed') {
        return;
      }
      normalizedEntries[normalizedPath] = {
        kind: 'file',
        path: normalizedPath,
        sourceMode: entry.sourceMode,
        cid: entry.cid,
        size:
          typeof entry.size === 'number' && Number.isFinite(entry.size)
            ? entry.size
            : 0,
        mtimeMs:
          typeof entry.mtimeMs === 'number' && Number.isFinite(entry.mtimeMs)
            ? entry.mtimeMs
            : 0,
        mime: typeof entry.mime === 'string' ? entry.mime : undefined,
      };
    });

    return {
      version: 2,
      entries: normalizedEntries,
    };
  } catch {
    return getDefaultManifest();
  }
};

const getStoredManifestEntryForPath = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentEntry | null => {
  return manifest.entries[normalizedPath] || null;
};

const getStoredFileEntryForPath = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentFileEntry | null => {
  const entry = getStoredManifestEntryForPath(manifest, normalizedPath);
  return isStoredWebContentFileEntry(entry) ? entry : null;
};

const getStoredDirectoryEntryForPath = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentDirectoryRecord | null => {
  const entry = getStoredManifestEntryForPath(manifest, normalizedPath);
  return isStoredWebContentDirectoryRecord(entry) ? entry : null;
};

const listStoredChildren = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): StoredWebContentEntry[] => {
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
    if (isStoredWebContentDirectoryRecord(stored)) {
      const localFsPath = urlPathToFsPath(opts.webRoot, stored.path);
      const localDirExists =
        fs.existsSync(localFsPath) && fs.statSync(localFsPath).isDirectory();
      entriesByName.set(entryName, {
        name: entryName,
        path: stored.path,
        isDirectory: true,
        size: 0,
        mtimeMs: stored.mtimeMs,
        sourceMode: 'local',
        fsPath: localDirExists ? localFsPath : undefined,
        localPresent: localDirExists,
        virtual: !localDirExists,
      });
      return;
    }

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

export const listAllWebContentEntries = (opts: {
  webRoot: string;
}): WebContentDirectoryEntry[] => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const entriesByPath = new Map<string, WebContentDirectoryEntry>();

  const visitPhysical = (currentDir: string): void => {
    const dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
    dirEntries.forEach((entry) => {
      if (entry.name === MANIFEST_FILE_NAME) return;
      const childPath = path.join(currentDir, entry.name);
      const normalizedPath = getUrlPathFromFsPath(opts.webRoot, childPath);
      const stat = fs.statSync(childPath);

      entriesByPath.set(normalizedPath, {
        name: entry.name,
        path: normalizedPath,
        isDirectory: entry.isDirectory(),
        size: stat.isFile() ? stat.size : 0,
        mtimeMs: stat.mtimeMs,
        mime: stat.isFile() ? guessContentType(childPath) : undefined,
        sourceMode: 'local',
        fsPath: childPath,
        localPresent: true,
      });

      if (entry.isDirectory()) {
        visitPhysical(childPath);
      }
    });
  };

  if (fs.existsSync(opts.webRoot) && fs.statSync(opts.webRoot).isDirectory()) {
    visitPhysical(opts.webRoot);
  }

  Object.values(manifest.entries).forEach((stored) => {
    const localFsPath = urlPathToFsPath(opts.webRoot, stored.path);
    const localExists = fs.existsSync(localFsPath);

    if (isStoredWebContentDirectoryRecord(stored)) {
      entriesByPath.set(stored.path, {
        name: path.posix.basename(stored.path),
        path: stored.path,
        isDirectory: true,
        size: 0,
        mtimeMs: stored.mtimeMs,
        sourceMode: 'local',
        fsPath: localExists ? localFsPath : undefined,
        localPresent: localExists,
        virtual: !localExists,
      });
      return;
    }

    const localStat =
      localExists && fs.statSync(localFsPath).isFile() ? fs.statSync(localFsPath) : null;
    entriesByPath.set(stored.path, {
      name: path.posix.basename(stored.path),
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

  return [...entriesByPath.values()].sort((a, b) => a.path.localeCompare(b.path));
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
  const storedFile = getStoredFileEntryForPath(manifest, normalizedPath);
  const storedDirectory = getStoredDirectoryEntryForPath(manifest, normalizedPath);

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
      if (storedFile?.sourceMode === 'ipfs-backed' && storedFile.cid) {
        return {
          kind: 'ipfs-file',
          cid: storedFile.cid,
          entry: {
            name: path.posix.basename(normalizedPath),
            path: normalizedPath,
            isDirectory: false,
            size: storedFile.size || stat.size,
            mtimeMs: storedFile.mtimeMs || stat.mtimeMs,
            mime: storedFile.mime || guessContentType(fsPath),
            cid: storedFile.cid,
            sourceMode: storedFile.sourceMode,
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
          size: storedFile?.size || stat.size,
          mtimeMs: storedFile?.mtimeMs || stat.mtimeMs,
          mime: storedFile?.mime || guessContentType(fsPath),
          cid: storedFile?.cid,
          sourceMode: storedFile?.sourceMode || 'local',
          fsPath,
          localPresent: true,
        },
      };
    }
  }

  if (storedFile?.cid) {
    return {
      kind: 'ipfs-file',
      cid: storedFile.cid,
      entry: {
        name: path.posix.basename(normalizedPath),
        path: normalizedPath,
        isDirectory: false,
        size: storedFile.size,
        mtimeMs: storedFile.mtimeMs,
        mime: storedFile.mime || guessContentType(fsPath),
        cid: storedFile.cid,
        sourceMode: storedFile.sourceMode,
        localPresent: false,
      },
    };
  }

  if (storedDirectory) {
    return {
      kind: 'directory',
      physical: false,
      entry: {
        name: path.posix.basename(normalizedPath) || '/',
        path: normalizedPath,
        isDirectory: true,
        size: 0,
        mtimeMs: storedDirectory.mtimeMs,
        sourceMode: 'local',
        localPresent: false,
        virtual: true,
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
    kind: 'file',
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

const ensureManagedDirectoryChain = (
  manifest: WebContentSourceManifest,
  normalizedPath: string,
): number => {
  const createdPaths = new Set<string>();
  const parentPath = path.posix.dirname(normalizedPath);
  const segments = parentPath.split('/').filter(Boolean);
  let currentPath = '';

  segments.forEach((segment) => {
    currentPath = `${currentPath}/${segment}`;
    if (manifest.entries[currentPath]) return;
    manifest.entries[currentPath] = {
      kind: 'directory',
      path: currentPath,
      mtimeMs: Date.now(),
    };
    createdPaths.add(currentPath);
  });

  return createdPaths.size;
};

const removeLocalWebPathIfExists = (webRoot: string, normalizedPath: string): void => {
  const fsPath = urlPathToFsPath(webRoot, normalizedPath);
  if (!isUnderDir(fsPath, webRoot)) {
    throw new Error('Forbidden');
  }
  if (!fs.existsSync(fsPath)) return;

  const stat = fs.statSync(fsPath);
  if (stat.isDirectory()) {
    fs.rmSync(fsPath, { recursive: true, force: true });
    return;
  }

  fs.unlinkSync(fsPath);
};

const writeLocalWebFileFromSource = (
  webRoot: string,
  normalizedPath: string,
  sourceFilePath: string,
): void => {
  const targetPath = urlPathToFsPath(webRoot, normalizedPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourceFilePath, targetPath);
};

const getEntryCid = (
  entry: StoredWebContentEntry | undefined | null,
): string | null => {
  if (!entry || !isStoredWebContentFileEntry(entry) || !entry.cid) {
    return null;
  }

  return entry.cid;
};

const collectReferencedCids = (manifest: WebContentSourceManifest): Set<string> => {
  const referencedCids = new Set<string>();

  Object.values(manifest.entries).forEach((entry) => {
    const cid = getEntryCid(entry);
    if (cid) {
      referencedCids.add(cid);
    }
  });

  return referencedCids;
};

const mapCidReleaseResultToCleanup = (
  result: IpfsCidReleaseResult,
): ManagedWebCidCleanupResult => {
  const cleanupIssues = result.failedCids.map(({ cid, error }) => `${cid}: ${error}`);
  if (result.gcError) {
    cleanupIssues.push(`repo gc: ${result.gcError}`);
  }

  return {
    releasedCids: result.releasedCids,
    cleanupIssues,
  };
};

const releaseOrphanedManagedWebCids = async (opts: {
  manifest: WebContentSourceManifest;
  candidateCids: Iterable<string>;
  ipfsManager: IpfsSidecarManager;
}): Promise<ManagedWebCidCleanupResult> => {
  const referencedCids = collectReferencedCids(opts.manifest);
  const orphanedCids = Array.from(
    new Set(
      Array.from(opts.candidateCids)
        .map((cid) => cid.trim())
        .filter((cid) => !!cid && !referencedCids.has(cid)),
    ),
  );

  if (!orphanedCids.length) {
    return EMPTY_MANAGED_WEB_CID_CLEANUP_RESULT;
  }

  const releaseResult = await opts.ipfsManager.releaseCids(orphanedCids);
  return mapCidReleaseResultToCleanup(releaseResult);
};

export const normalizeReservedLocalWebPaths = async (opts: {
  webRoot: string;
  ipfsManager: IpfsSidecarManager;
}): Promise<{
  normalizedPaths: string[];
  releasedCids: string[];
  cleanupIssues: string[];
}> => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const candidateReleasedCids = new Set<string>();
  const normalizedPaths: string[] = [];

  Object.keys(manifest.entries).forEach((entryPath) => {
    if (!isReservedLocalWebPath(entryPath)) {
      return;
    }

    const previousCid = getEntryCid(manifest.entries[entryPath]);
    if (previousCid) {
      candidateReleasedCids.add(previousCid);
    }

    delete manifest.entries[entryPath];
    normalizedPaths.push(entryPath);
  });

  if (!normalizedPaths.length) {
    return {
      normalizedPaths: [],
      releasedCids: [],
      cleanupIssues: [],
    };
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  const cleanup = await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: candidateReleasedCids,
    ipfsManager: opts.ipfsManager,
  });

  return {
    normalizedPaths,
    releasedCids: cleanup.releasedCids,
    cleanupIssues: cleanup.cleanupIssues,
  };
};

const removeEmptyPhysicalParents = (webRoot: string, normalizedPath: string): void => {
  let currentPath = getParentPath(normalizedPath);
  while (currentPath !== '/') {
    const fsPath = urlPathToFsPath(webRoot, currentPath);
    if (!fs.existsSync(fsPath) || !fs.statSync(fsPath).isDirectory()) return;
    if (fs.readdirSync(fsPath).length > 0) return;
    fs.rmdirSync(fsPath);
    currentPath = getParentPath(currentPath);
  }
};

const cloneManifestEntryToPath = (
  entry: StoredWebContentEntry,
  nextPath: string,
): StoredWebContentEntry => {
  if (isStoredWebContentDirectoryRecord(entry)) {
    return {
      kind: 'directory',
      path: nextPath,
      mtimeMs: Date.now(),
    };
  }

  return {
    kind: 'file',
    path: nextPath,
    sourceMode: entry.sourceMode,
    cid: entry.cid,
    size: entry.size,
    mtimeMs: Date.now(),
    mime: entry.mime,
  };
};

const listSourceFilesRecursively = (rootDir: string): Array<{ fsPath: string; relativePath: string }> => {
  const files: Array<{ fsPath: string; relativePath: string }> = [];

  const visit = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const childPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(childPath);
        return;
      }
      if (!entry.isFile()) return;

      files.push({
        fsPath: childPath,
        relativePath: path.relative(rootDir, childPath).split(path.sep).join('/'),
      });
    });
  };

  visit(rootDir);
  return files;
};

export const createManagedWebDirectory = (opts: {
  webRoot: string;
  parentPath: string;
  directoryName: string;
}): { path: string; created: boolean } => {
  const name = (opts.directoryName || '').trim();
  if (!name) {
    throw new Error('目录名称不能为空。');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('目录名称不能包含路径分隔符。');
  }

  const normalizedParentPath = parseAndNormalizeUrlPath(opts.parentPath || '/');
  const targetPath = parseAndNormalizeUrlPath(
    path.posix.join(normalizedParentPath, name),
  );

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const existing = getStoredDirectoryEntryForPath(manifest, targetPath);
  if (existing) {
    return { path: targetPath, created: false };
  }

  ensureManagedDirectoryChain(manifest, targetPath);
  manifest.entries[targetPath] = {
    kind: 'directory',
    path: targetPath,
    mtimeMs: Date.now(),
  };
  writeWebContentSourceManifest(opts.webRoot, manifest);
  return { path: targetPath, created: true };
};

export const importManagedWebFiles = async (opts: {
  webRoot: string;
  targetDirectoryPath: string;
  sourceFilePaths: string[];
  ipfsManager: IpfsSidecarManager;
  onProgress?: (progress: ManagedWebImportProgress) => void;
}): Promise<ImportManagedWebContentResult> => {
  const normalizedTargetDirectoryPath = parseAndNormalizeUrlPath(
    opts.targetDirectoryPath || '/',
  );
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const importedPaths: string[] = [];
  const overwrittenPaths: string[] = [];
  const candidateReleasedCids = new Set<string>();
  const sourceFiles = opts.sourceFilePaths.map((sourceFilePath) => {
    const resolvedSourcePath = path.resolve(sourceFilePath);
    if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
      throw new Error(`源文件不存在或不是普通文件：${resolvedSourcePath}`);
    }

    const stat = fs.statSync(resolvedSourcePath);
    return {
      resolvedSourcePath,
      stat,
      basename: path.basename(resolvedSourcePath),
    };
  });
  const totalFiles = sourceFiles.length;
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.stat.size, 0);
  let completedBytes = 0;

  opts.onProgress?.({
    current: 0,
    total: totalFiles,
    currentBytes: 0,
    totalBytes,
    message: totalFiles > 0 ? '正在准备上传文件…' : '没有可上传的文件。',
  });

  if (normalizedTargetDirectoryPath !== '/') {
    ensureManagedDirectoryChain(
      manifest,
      path.posix.join(normalizedTargetDirectoryPath, '__placeholder__'),
    );
    if (!getStoredDirectoryEntryForPath(manifest, normalizedTargetDirectoryPath)) {
      manifest.entries[normalizedTargetDirectoryPath] = {
        kind: 'directory',
        path: normalizedTargetDirectoryPath,
        mtimeMs: Date.now(),
      };
    }
  }

  for (const sourceFile of sourceFiles) {
    const { resolvedSourcePath, stat, basename } = sourceFile;
    const targetPath = parseAndNormalizeUrlPath(
      path.posix.join(normalizedTargetDirectoryPath, basename),
    );
    const targetEntry = manifest.entries[targetPath];
    if (targetEntry) {
      overwrittenPaths.push(targetPath);
    }
    const previousCid = getEntryCid(targetEntry);
    if (previousCid) {
      candidateReleasedCids.add(previousCid);
    }

    if (isReservedLocalWebPath(targetPath)) {
      writeLocalWebFileFromSource(opts.webRoot, targetPath, resolvedSourcePath);
      delete manifest.entries[targetPath];
      importedPaths.push(targetPath);
      completedBytes += stat.size;
      opts.onProgress?.({
        current: importedPaths.length,
        total: totalFiles,
        currentBytes: completedBytes,
        totalBytes,
        message: `正在上传文件 ${importedPaths.length}/${totalFiles}：${basename}`,
      });
      continue;
    }

    removeLocalWebPathIfExists(opts.webRoot, targetPath);
    // eslint-disable-next-line no-await-in-loop
    const result = await opts.ipfsManager.ensurePathCached(resolvedSourcePath, {
      wrapWithDirectory: false,
      onProgress: ({ loadedBytes, totalBytes: fileTotalBytes }) => {
        opts.onProgress?.({
          current: importedPaths.length,
          total: totalFiles,
          currentBytes: completedBytes + loadedBytes,
          totalBytes,
          message: `正在上传文件 ${importedPaths.length + 1}/${totalFiles}：${basename}`,
        });

        if (fileTotalBytes <= 0) {
          return;
        }
      },
    });
    manifest.entries[targetPath] = {
      kind: 'file',
      path: targetPath,
      sourceMode: 'ipfs-backed',
      cid: result.cid,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mime: guessContentType(resolvedSourcePath),
    };
    importedPaths.push(targetPath);
    completedBytes += stat.size;
    opts.onProgress?.({
      current: importedPaths.length,
      total: totalFiles,
      currentBytes: completedBytes,
      totalBytes,
      message: `正在上传文件 ${importedPaths.length}/${totalFiles}：${basename}`,
    });
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  const cleanup = await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: candidateReleasedCids,
    ipfsManager: opts.ipfsManager,
  });
  return {
    importedFiles: importedPaths.length,
    importedDirectories: 0,
    overwrittenPaths,
    paths: importedPaths,
    releasedCids: cleanup.releasedCids,
    cleanupIssues: cleanup.cleanupIssues,
  };
};

export const replaceManagedWebFile = async (opts: {
  webRoot: string;
  targetPath: string;
  sourceFilePath: string;
  ipfsManager: IpfsSidecarManager;
}): Promise<ImportManagedWebContentResult> => {
  const normalizedTargetPath = parseAndNormalizeUrlPath(opts.targetPath || '/');
  const resolvedSourcePath = path.resolve(opts.sourceFilePath);
  if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
    throw new Error('替换源文件不存在。');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const overwrittenPaths = manifest.entries[normalizedTargetPath]
    ? [normalizedTargetPath]
    : [];
  const previousCid = getEntryCid(manifest.entries[normalizedTargetPath]);

  if (isReservedLocalWebPath(normalizedTargetPath)) {
    writeLocalWebFileFromSource(opts.webRoot, normalizedTargetPath, resolvedSourcePath);
    delete manifest.entries[normalizedTargetPath];
    writeWebContentSourceManifest(opts.webRoot, manifest);
    const cleanup = await releaseOrphanedManagedWebCids({
      manifest,
      candidateCids: previousCid ? [previousCid] : [],
      ipfsManager: opts.ipfsManager,
    });

    return {
      importedFiles: 1,
      importedDirectories: 0,
      overwrittenPaths,
      paths: [normalizedTargetPath],
      releasedCids: cleanup.releasedCids,
      cleanupIssues: cleanup.cleanupIssues,
    };
  }

  ensureManagedDirectoryChain(manifest, normalizedTargetPath);
  removeLocalWebPathIfExists(opts.webRoot, normalizedTargetPath);
  const result = await opts.ipfsManager.ensurePathCached(resolvedSourcePath, {
    wrapWithDirectory: false,
  });
  const stat = fs.statSync(resolvedSourcePath);
  manifest.entries[normalizedTargetPath] = {
    kind: 'file',
    path: normalizedTargetPath,
    sourceMode: 'ipfs-backed',
    cid: result.cid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: guessContentType(resolvedSourcePath),
  };
  writeWebContentSourceManifest(opts.webRoot, manifest);
  const cleanup = await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: previousCid ? [previousCid] : [],
    ipfsManager: opts.ipfsManager,
  });

  return {
    importedFiles: 1,
    importedDirectories: 0,
    overwrittenPaths,
    paths: [normalizedTargetPath],
    releasedCids: cleanup.releasedCids,
    cleanupIssues: cleanup.cleanupIssues,
  };
};

export const importManagedWebDirectory = async (opts: {
  webRoot: string;
  targetDirectoryPath: string;
  sourceDirectoryPath: string;
  ipfsManager: IpfsSidecarManager;
  onProgress?: (progress: ManagedWebImportProgress) => void;
}): Promise<ImportManagedWebContentResult> => {
  const normalizedTargetDirectoryPath = parseAndNormalizeUrlPath(
    opts.targetDirectoryPath || '/',
  );
  const resolvedSourceDirectoryPath = path.resolve(opts.sourceDirectoryPath);
  if (
    !fs.existsSync(resolvedSourceDirectoryPath) ||
    !fs.statSync(resolvedSourceDirectoryPath).isDirectory()
  ) {
    throw new Error('导入目录不存在。');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const importedPaths: string[] = [];
  const overwrittenPaths: string[] = [];
  const candidateReleasedCids = new Set<string>();
  let importedDirectories = 0;

  const rootTargetPath = parseAndNormalizeUrlPath(
    path.posix.join(normalizedTargetDirectoryPath, path.basename(resolvedSourceDirectoryPath)),
  );
  if (
    !isReservedLocalWebPath(rootTargetPath)
    && !getStoredDirectoryEntryForPath(manifest, rootTargetPath)
  ) {
    ensureManagedDirectoryChain(
      manifest,
      path.posix.join(rootTargetPath, '__placeholder__'),
    );
    manifest.entries[rootTargetPath] = {
      kind: 'directory',
      path: rootTargetPath,
      mtimeMs: Date.now(),
    };
    importedDirectories += 1;
  }

  const files = listSourceFilesRecursively(resolvedSourceDirectoryPath).map((file) => {
    const stat = fs.statSync(file.fsPath);
    return {
      ...file,
      stat,
    };
  });
  const totalFiles = files.length;
  const totalBytes = files.reduce((sum, file) => sum + file.stat.size, 0);
  let completedBytes = 0;
  opts.onProgress?.({
    current: 0,
    total: totalFiles,
    currentBytes: 0,
    totalBytes,
    message: totalFiles > 0 ? '正在准备导入目录…' : '目录中没有可导入的文件。',
  });
  for (const file of files) {
    const relativeDirectory = path.posix.dirname(file.relativePath);
    const targetDirectory =
      relativeDirectory === '.'
        ? rootTargetPath
        : parseAndNormalizeUrlPath(path.posix.join(rootTargetPath, relativeDirectory));

    if (
      !isReservedLocalWebPath(targetDirectory)
      && !getStoredDirectoryEntryForPath(manifest, targetDirectory)
    ) {
      ensureManagedDirectoryChain(
        manifest,
        path.posix.join(targetDirectory, '__placeholder__'),
      );
      manifest.entries[targetDirectory] = {
        kind: 'directory',
        path: targetDirectory,
        mtimeMs: Date.now(),
      };
      importedDirectories += 1;
    }

    const targetPath = parseAndNormalizeUrlPath(
      path.posix.join(targetDirectory, path.posix.basename(file.relativePath)),
    );
    if (manifest.entries[targetPath]) {
      overwrittenPaths.push(targetPath);
    }
    const previousCid = getEntryCid(manifest.entries[targetPath]);
    if (previousCid) {
      candidateReleasedCids.add(previousCid);
    }

    if (isReservedLocalWebPath(targetPath)) {
      writeLocalWebFileFromSource(opts.webRoot, targetPath, file.fsPath);
      delete manifest.entries[targetPath];
      importedPaths.push(targetPath);
      completedBytes += file.stat.size;
      opts.onProgress?.({
        current: importedPaths.length,
        total: totalFiles,
        currentBytes: completedBytes,
        totalBytes,
        message: `正在导入目录 ${importedPaths.length}/${totalFiles}：${file.relativePath}`,
      });
      continue;
    }

    removeLocalWebPathIfExists(opts.webRoot, targetPath);
    // eslint-disable-next-line no-await-in-loop
    const result = await opts.ipfsManager.ensurePathCached(file.fsPath, {
      wrapWithDirectory: false,
      onProgress: ({ loadedBytes }) => {
        opts.onProgress?.({
          current: importedPaths.length,
          total: totalFiles,
          currentBytes: completedBytes + loadedBytes,
          totalBytes,
          message: `正在导入目录 ${importedPaths.length + 1}/${totalFiles}：${file.relativePath}`,
        });
      },
    });
    manifest.entries[targetPath] = {
      kind: 'file',
      path: targetPath,
      sourceMode: 'ipfs-backed',
      cid: result.cid,
      size: file.stat.size,
      mtimeMs: file.stat.mtimeMs,
      mime: guessContentType(file.fsPath),
    };
    importedPaths.push(targetPath);
    completedBytes += file.stat.size;
    opts.onProgress?.({
      current: importedPaths.length,
      total: totalFiles,
      currentBytes: completedBytes,
      totalBytes,
      message: `正在导入目录 ${importedPaths.length}/${totalFiles}：${file.relativePath}`,
    });
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  const cleanup = await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: candidateReleasedCids,
    ipfsManager: opts.ipfsManager,
  });
  return {
    importedFiles: importedPaths.length,
    importedDirectories,
    overwrittenPaths,
    paths: importedPaths,
    releasedCids: cleanup.releasedCids,
    cleanupIssues: cleanup.cleanupIssues,
  };
};

export const deleteManagedWebEntry = async (opts: {
  webRoot: string;
  requestedPath: string;
  ipfsManager: IpfsSidecarManager;
}): Promise<{
  removedPaths: string[];
  releasedCids: string[];
  cleanupIssues: string[];
}> => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  if (normalizedPath === '/') {
    throw new Error('不能删除根目录。');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const prefix = `${normalizedPath}/`;
  const removedPaths = Object.keys(manifest.entries).filter((entryPath) => {
    return entryPath === normalizedPath || entryPath.startsWith(prefix);
  });
  const candidateReleasedCids = new Set<string>();

  removedPaths.forEach((entryPath) => {
    const cid = getEntryCid(manifest.entries[entryPath]);
    if (cid) {
      candidateReleasedCids.add(cid);
    }
    delete manifest.entries[entryPath];
  });
  writeWebContentSourceManifest(opts.webRoot, manifest);
  removeLocalWebPathIfExists(opts.webRoot, normalizedPath);
  removeEmptyPhysicalParents(opts.webRoot, normalizedPath);
  const cleanup = await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: candidateReleasedCids,
    ipfsManager: opts.ipfsManager,
  });
  return {
    removedPaths,
    releasedCids: cleanup.releasedCids,
    cleanupIssues: cleanup.cleanupIssues,
  };
};

export const renameManagedWebEntry = (opts: {
  webRoot: string;
  requestedPath: string;
  newName: string;
}): { fromPath: string; toPath: string; movedPaths: string[] } => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  if (normalizedPath === '/') {
    throw new Error('不能重命名根目录。');
  }

  const safeName = ensureSafeManagedName(opts.newName);
  const nextPath = parseAndNormalizeUrlPath(
    path.posix.join(getParentPath(normalizedPath), safeName),
  );
  if (nextPath === normalizedPath) {
    return { fromPath: normalizedPath, toPath: nextPath, movedPaths: [] };
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  if (manifest.entries[nextPath]) {
    throw new Error('目标路径已存在。');
  }

  const prefix = `${normalizedPath}/`;
  const movedPaths = Object.keys(manifest.entries).filter((entryPath) => {
    return entryPath === normalizedPath || entryPath.startsWith(prefix);
  });

  const updates = movedPaths.map((entryPath) => {
    const entry = manifest.entries[entryPath];
    const suffix = entryPath.slice(normalizedPath.length);
    const targetPath = `${nextPath}${suffix}`;
    return { entryPath, targetPath, entry };
  });
  updates.forEach(({ entryPath }) => {
    delete manifest.entries[entryPath];
  });
  updates.forEach(({ targetPath, entry }) => {
    manifest.entries[targetPath] = cloneManifestEntryToPath(entry, targetPath);
  });
  writeWebContentSourceManifest(opts.webRoot, manifest);

  const currentFsPath = urlPathToFsPath(opts.webRoot, normalizedPath);
  const nextFsPath = urlPathToFsPath(opts.webRoot, nextPath);
  if (fs.existsSync(currentFsPath)) {
    fs.mkdirSync(path.dirname(nextFsPath), { recursive: true });
    fs.renameSync(currentFsPath, nextFsPath);
  }

  return { fromPath: normalizedPath, toPath: nextPath, movedPaths };
};

export const pasteManagedWebEntries = (opts: {
  webRoot: string;
  requestedPaths: string[];
  destinationDirectoryPath: string;
  operationType: ManagedWebPasteOperation;
}): PasteManagedWebContentResult => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const destinationDirectoryPath = parseAndNormalizeUrlPath(
    opts.destinationDirectoryPath || '/',
  );
  const createdPaths: string[] = [];

  opts.requestedPaths.forEach((requestedPathRaw) => {
    const requestedPath = parseAndNormalizeUrlPath(requestedPathRaw);
    if (requestedPath === '/' || requestedPath === destinationDirectoryPath) {
      return;
    }

    const basename = path.posix.basename(requestedPath);
    const targetPath = parseAndNormalizeUrlPath(
      path.posix.join(destinationDirectoryPath, basename),
    );
    if (targetPath === requestedPath) return;
    if (targetPath.startsWith(`${requestedPath}/`)) {
      throw new Error('不能把目录移动到自己的子目录中。');
    }
    if (manifest.entries[targetPath]) {
      throw new Error(`目标路径已存在：${targetPath}`);
    }

    const prefix = `${requestedPath}/`;
    const matchedPaths = Object.keys(manifest.entries).filter((entryPath) => {
      return entryPath === requestedPath || entryPath.startsWith(prefix);
    });

    matchedPaths.forEach((entryPath) => {
      const entry = manifest.entries[entryPath];
      const suffix = entryPath.slice(requestedPath.length);
      const nextPath = `${targetPath}${suffix}`;
      manifest.entries[nextPath] = cloneManifestEntryToPath(entry, nextPath);
      createdPaths.push(nextPath);
    });

    const sourceFsPath = urlPathToFsPath(opts.webRoot, requestedPath);
    const targetFsPath = urlPathToFsPath(opts.webRoot, targetPath);
    if (fs.existsSync(sourceFsPath)) {
      if (opts.operationType === 'copy') {
        fs.mkdirSync(path.dirname(targetFsPath), { recursive: true });
        fs.cpSync(sourceFsPath, targetFsPath, { recursive: true, force: true });
      } else {
        fs.mkdirSync(path.dirname(targetFsPath), { recursive: true });
        fs.renameSync(sourceFsPath, targetFsPath);
      }
    }

    if (opts.operationType === 'move') {
      matchedPaths.forEach((entryPath) => {
        delete manifest.entries[entryPath];
      });
      removeEmptyPhysicalParents(opts.webRoot, requestedPath);
    }
  });

  writeWebContentSourceManifest(opts.webRoot, manifest);
  return {
    operationType: opts.operationType,
    paths: createdPaths,
  };
};

export const migrateWebContentToManagedIpfs = async (opts: {
  webRoot: string;
  ipfsManager: IpfsSidecarManager;
  onProgress?: (progress: { current: number; total: number; message: string }) => void;
}): Promise<{ migratedFiles: number; migratedDirectories: number }> => {
  const manifest = readWebContentSourceManifest(opts.webRoot);
  let migratedFiles = 0;
  let migratedDirectories = 0;
  const physicalFiles =
    fs.existsSync(opts.webRoot) && fs.statSync(opts.webRoot).isDirectory()
      ? listPhysicalFilesRecursively(opts.webRoot).filter(
          (fsPath) => !isReservedLocalWebPath(getUrlPathFromFsPath(opts.webRoot, fsPath)),
        )
      : [];
  const totalFiles = physicalFiles.length;

  opts.onProgress?.({
    current: 0,
    total: totalFiles,
    message:
      totalFiles > 0 ? '正在将本地站点内容吸收进 IPFS 存储…' : '没有需要迁移的本地文件。',
  });

  const visit = async (currentDir: string): Promise<void> => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === MANIFEST_FILE_NAME) continue;
      const childPath = path.join(currentDir, entry.name);
      const normalizedPath = getUrlPathFromFsPath(opts.webRoot, childPath);

      if (entry.isDirectory()) {
        if (
          !isReservedLocalWebPath(normalizedPath)
          && !manifest.entries[normalizedPath]
        ) {
          manifest.entries[normalizedPath] = {
            kind: 'directory',
            path: normalizedPath,
            mtimeMs: fs.statSync(childPath).mtimeMs,
          };
          migratedDirectories += 1;
        }
        // eslint-disable-next-line no-await-in-loop
        await visit(childPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isReservedLocalWebPath(normalizedPath)) {
        continue;
      }

      const stat = fs.statSync(childPath);
      const existing = getStoredFileEntryForPath(manifest, normalizedPath);
      if (
        existing?.sourceMode === 'ipfs-backed' &&
        existing.size === stat.size &&
        existing.mtimeMs === stat.mtimeMs
      ) {
        fs.unlinkSync(childPath);
        migratedFiles += 1;
        opts.onProgress?.({
          current: migratedFiles,
          total: totalFiles,
          message: `正在清理已托管文件 ${migratedFiles}/${totalFiles}：${entry.name}`,
        });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const result = await opts.ipfsManager.ensurePathCached(childPath, {
        wrapWithDirectory: false,
      });
      manifest.entries[normalizedPath] = {
        kind: 'file',
        path: normalizedPath,
        sourceMode: 'ipfs-backed',
        cid: result.cid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mime: guessContentType(childPath),
      };
      fs.unlinkSync(childPath);
      migratedFiles += 1;
      opts.onProgress?.({
        current: migratedFiles,
        total: totalFiles,
        message: `正在迁移本地文件 ${migratedFiles}/${totalFiles}：${entry.name}`,
      });
    }
  };

  if (fs.existsSync(opts.webRoot) && fs.statSync(opts.webRoot).isDirectory()) {
    await visit(opts.webRoot);
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  return { migratedFiles, migratedDirectories };
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
  if (isReservedLocalWebPath(normalizedPath)) {
    throw new Error('静态壳文件必须保留为本地文件。');
  }

  const stat = fs.statSync(fsPath);
  if (!stat.isFile()) {
    throw new Error('仅支持将文件转换为 IPFS 内容源。');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const previousCid = getEntryCid(manifest.entries[normalizedPath]);
  const result = await opts.ipfsManager.ensurePathCached(fsPath, {
    wrapWithDirectory: false,
  });
  const sourceMode = opts.removeLocalFile ? 'ipfs-backed' : 'dual';

  manifest.entries[normalizedPath] = {
    kind: 'file',
    path: normalizedPath,
    sourceMode,
    cid: result.cid,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mime: guessContentType(fsPath),
  };
  writeWebContentSourceManifest(opts.webRoot, manifest);

  if (opts.removeLocalFile) {
    fs.unlinkSync(fsPath);
  }

  await releaseOrphanedManagedWebCids({
    manifest,
    candidateCids: previousCid && previousCid !== result.cid ? [previousCid] : [],
    ipfsManager: opts.ipfsManager,
  });

  return {
    path: normalizedPath,
    cid: result.cid,
    sourceMode,
    removedLocalFile: opts.removeLocalFile === true,
  };
};

export const syncWebContentWithIpfs = async (opts: {
  webRoot: string;
  ipfsManager: IpfsSidecarManager;
  thresholdBytes?: number;
}): Promise<SyncWebContentWithIpfsResult> => {
  const thresholdBytes =
    opts.thresholdBytes ?? SIMPLE_MODE_AUTO_CONVERT_THRESHOLD_BYTES;
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const physicalFiles = listPhysicalFilesRecursively(opts.webRoot).filter(
    (fsPath) => !isReservedLocalWebPath(getUrlPathFromFsPath(opts.webRoot, fsPath)),
  );
  const syncedPaths: string[] = [];
  const stalePaths: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  let manifestChanged = false;
  let scannedFiles = 0;
  let syncedFiles = 0;
  let unchangedManagedFiles = 0;
  let skippedSmallFiles = 0;
  const candidateReleasedCids = new Set<string>();

  Object.values(manifest.entries).forEach((stored) => {
    if (!isStoredWebContentFileEntry(stored)) return;
    if (stored.sourceMode !== 'dual') return;
    const localFsPath = urlPathToFsPath(opts.webRoot, stored.path);
    const localExists =
      fs.existsSync(localFsPath) && fs.statSync(localFsPath).isFile();
    if (!localExists) {
      stalePaths.push(stored.path);
    }
  });

  for (const fsPath of physicalFiles) {
    scannedFiles += 1;
    const stat = fs.statSync(fsPath);
    const normalizedPath = getUrlPathFromFsPath(opts.webRoot, fsPath);
    const stored = getStoredFileEntryForPath(manifest, normalizedPath);
    const shouldManage = stat.size >= thresholdBytes || !!stored?.cid;

    if (!shouldManage) {
      skippedSmallFiles += 1;
      continue;
    }

    const mime = guessContentType(fsPath);
    const alreadyCurrent =
      stored?.sourceMode === 'dual' &&
      stored.size === stat.size &&
      stored.mtimeMs === stat.mtimeMs &&
      stored.mime === mime;

    if (alreadyCurrent) {
      unchangedManagedFiles += 1;
      continue;
    }

    try {
      // Simple mode keeps local files editable, so managed files are normalized to dual mode.
      // eslint-disable-next-line no-await-in-loop
      const result = await opts.ipfsManager.ensurePathCached(fsPath, {
        wrapWithDirectory: false,
      });
      const previousCid = getEntryCid(stored);
      manifest.entries[normalizedPath] = {
        kind: 'file',
        path: normalizedPath,
        sourceMode: 'dual',
        cid: result.cid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mime,
      };
      if (previousCid && previousCid !== result.cid) {
        candidateReleasedCids.add(previousCid);
      }
      manifestChanged = true;
      syncedFiles += 1;
      syncedPaths.push(normalizedPath);
    } catch (error) {
      failures.push({
        path: normalizedPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (manifestChanged) {
    writeWebContentSourceManifest(opts.webRoot, manifest);
    await releaseOrphanedManagedWebCids({
      manifest,
      candidateCids: candidateReleasedCids,
      ipfsManager: opts.ipfsManager,
    });
  }

  return {
    thresholdBytes,
    scannedFiles,
    syncedFiles,
    unchangedManagedFiles,
    skippedSmallFiles,
    staleManifestEntries: stalePaths.length,
    syncedPaths,
    stalePaths,
    failures,
  };
};
