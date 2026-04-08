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
};

const normalizeManifestPath = (inputPath: string): string => {
  const normalized = path.posix.normalize(inputPath || '/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
};

const getManifestPath = (webRoot: string): string => {
  return path.join(webRoot, MANIFEST_FILE_NAME);
};

const getUrlPathFromFsPath = (webRoot: string, fsPath: string): string => {
  const relativePath = path.relative(webRoot, fsPath);
  const posixPath = relativePath.split(path.sep).join('/');
  return normalizeManifestPath(`/${posixPath}`);
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
}): Promise<ImportManagedWebContentResult> => {
  const normalizedTargetDirectoryPath = parseAndNormalizeUrlPath(
    opts.targetDirectoryPath || '/',
  );
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const importedPaths: string[] = [];
  const overwrittenPaths: string[] = [];

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

  for (const sourceFilePath of opts.sourceFilePaths) {
    const resolvedSourcePath = path.resolve(sourceFilePath);
    if (!fs.existsSync(resolvedSourcePath) || !fs.statSync(resolvedSourcePath).isFile()) {
      throw new Error(`源文件不存在或不是普通文件：${resolvedSourcePath}`);
    }

    const targetPath = parseAndNormalizeUrlPath(
      path.posix.join(normalizedTargetDirectoryPath, path.basename(resolvedSourcePath)),
    );
    const targetEntry = manifest.entries[targetPath];
    if (targetEntry) {
      overwrittenPaths.push(targetPath);
    }

    removeLocalWebPathIfExists(opts.webRoot, targetPath);
    // eslint-disable-next-line no-await-in-loop
    const result = await opts.ipfsManager.ensurePathCached(resolvedSourcePath, {
      wrapWithDirectory: false,
    });
    const stat = fs.statSync(resolvedSourcePath);
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
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  return {
    importedFiles: importedPaths.length,
    importedDirectories: 0,
    overwrittenPaths,
    paths: importedPaths,
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

  return {
    importedFiles: 1,
    importedDirectories: 0,
    overwrittenPaths,
    paths: [normalizedTargetPath],
  };
};

export const importManagedWebDirectory = async (opts: {
  webRoot: string;
  targetDirectoryPath: string;
  sourceDirectoryPath: string;
  ipfsManager: IpfsSidecarManager;
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
  let importedDirectories = 0;

  const rootTargetPath = parseAndNormalizeUrlPath(
    path.posix.join(normalizedTargetDirectoryPath, path.basename(resolvedSourceDirectoryPath)),
  );
  if (!getStoredDirectoryEntryForPath(manifest, rootTargetPath)) {
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

  const files = listSourceFilesRecursively(resolvedSourceDirectoryPath);
  for (const file of files) {
    const relativeDirectory = path.posix.dirname(file.relativePath);
    const targetDirectory =
      relativeDirectory === '.'
        ? rootTargetPath
        : parseAndNormalizeUrlPath(path.posix.join(rootTargetPath, relativeDirectory));

    if (!getStoredDirectoryEntryForPath(manifest, targetDirectory)) {
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
    removeLocalWebPathIfExists(opts.webRoot, targetPath);
    // eslint-disable-next-line no-await-in-loop
    const result = await opts.ipfsManager.ensurePathCached(file.fsPath, {
      wrapWithDirectory: false,
    });
    const stat = fs.statSync(file.fsPath);
    manifest.entries[targetPath] = {
      kind: 'file',
      path: targetPath,
      sourceMode: 'ipfs-backed',
      cid: result.cid,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mime: guessContentType(file.fsPath),
    };
    importedPaths.push(targetPath);
  }

  writeWebContentSourceManifest(opts.webRoot, manifest);
  return {
    importedFiles: importedPaths.length,
    importedDirectories,
    overwrittenPaths,
    paths: importedPaths,
  };
};

export const deleteManagedWebEntry = (opts: {
  webRoot: string;
  requestedPath: string;
}): { removedPaths: string[] } => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');
  if (normalizedPath === '/') {
    throw new Error('不能删除根目录。');
  }

  const manifest = readWebContentSourceManifest(opts.webRoot);
  const prefix = `${normalizedPath}/`;
  const removedPaths = Object.keys(manifest.entries).filter((entryPath) => {
    return entryPath === normalizedPath || entryPath.startsWith(prefix);
  });

  removedPaths.forEach((entryPath) => {
    delete manifest.entries[entryPath];
  });
  writeWebContentSourceManifest(opts.webRoot, manifest);
  removeLocalWebPathIfExists(opts.webRoot, normalizedPath);
  return { removedPaths };
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

export const syncWebContentWithIpfs = async (opts: {
  webRoot: string;
  ipfsManager: IpfsSidecarManager;
  thresholdBytes?: number;
}): Promise<SyncWebContentWithIpfsResult> => {
  const thresholdBytes =
    opts.thresholdBytes ?? SIMPLE_MODE_AUTO_CONVERT_THRESHOLD_BYTES;
  const manifest = readWebContentSourceManifest(opts.webRoot);
  const physicalFiles = listPhysicalFilesRecursively(opts.webRoot);
  const syncedPaths: string[] = [];
  const stalePaths: string[] = [];
  const failures: Array<{ path: string; error: string }> = [];

  let manifestChanged = false;
  let scannedFiles = 0;
  let syncedFiles = 0;
  let unchangedManagedFiles = 0;
  let skippedSmallFiles = 0;

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
      manifest.entries[normalizedPath] = {
        kind: 'file',
        path: normalizedPath,
        sourceMode: 'dual',
        cid: result.cid,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mime,
      };
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
