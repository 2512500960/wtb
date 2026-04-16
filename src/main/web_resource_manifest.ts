import type { IpfsSidecarManager } from './ipfs_manager';
import { listWebContentDirectoryEntries } from './web_content_sources';
import { parseAndNormalizeUrlPath } from './web_service_utils';
import type { RemoteResourceManifest } from '../types/remote_resources';

const IPFS_SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024;

const shouldExposeViaIpfs = (opts: {
  relativeUrlPath: string;
  size: number;
  mime?: string;
}): boolean => {
  const relativePath = opts.relativeUrlPath.toLowerCase();
  if (relativePath.startsWith('/video/') || relativePath.startsWith('/files/')) {
    return true;
  }
  if ((opts.mime || '').startsWith('video/')) return true;
  if ((opts.mime || '').startsWith('audio/')) return true;
  return opts.size >= IPFS_SIZE_THRESHOLD_BYTES;
};

export const buildWebResourceManifest = async (opts: {
  hostHeader: string | undefined;
  webRoot: string;
  requestedPath: string | undefined;
  ipfsManager: IpfsSidecarManager;
}): Promise<RemoteResourceManifest> => {
  const normalizedPath = parseAndNormalizeUrlPath(opts.requestedPath || '/');

  const ipfsStatus = await opts.ipfsManager.getDetailedStatus();
  const origin = opts.hostHeader ? `http://${opts.hostHeader}` : '';

  const entries = await Promise.all(
    listWebContentDirectoryEntries({
      webRoot: opts.webRoot,
      requestedPath: normalizedPath,
    }).map(async (entry) => {
      const normalizedChildPath = entry.path;
      const httpUrl = origin
        ? new URL(normalizedChildPath, `${origin}/`).toString()
        : normalizedChildPath;
      const mime = entry.isDirectory ? undefined : entry.mime;

      let cid: string | undefined = entry.cid;
      if (
        ipfsStatus.running &&
        !entry.isDirectory &&
        entry.fsPath &&
        shouldExposeViaIpfs({
          relativeUrlPath: normalizedChildPath,
          size: entry.size,
          mime,
        })
      ) {
        try {
          const result = await opts.ipfsManager.ensurePathCached(entry.fsPath, {
            wrapWithDirectory: false,
          });
          cid = result.cid;
        } catch {
          cid = undefined;
        }
      }

      return {
        name: entry.name,
        path: normalizedChildPath,
        isDirectory: entry.isDirectory,
        size: entry.isDirectory ? 0 : entry.size,
        mtimeMs: entry.mtimeMs,
        mime,
        httpUrl,
        cid,
        sourceMode: entry.sourceMode,
      };
    }),
  );

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    });
  });

  return {
    path: normalizedPath,
    generatedAt: new Date().toISOString(),
    ipfs: {
      enabled: ipfsStatus.running,
      peerId: ipfsStatus.peerId,
      peerAddresses: ipfsStatus.addresses,
    },
    entries,
  };
};
