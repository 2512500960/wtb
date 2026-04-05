import fs from 'fs';
import path from 'path';

import { isUnderDir } from './fs_utils';
import type { IpfsSidecarManager } from './ipfs_manager';
import {
  guessContentType,
  parseAndNormalizeUrlPath,
  urlPathToFsPath,
} from './web_service_utils';
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
  const targetPath = urlPathToFsPath(opts.webRoot, normalizedPath);

  if (!isUnderDir(targetPath, opts.webRoot)) {
    throw new Error('Forbidden');
  }

  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error('Not Found');
  }

  const ipfsStatus = await opts.ipfsManager.getDetailedStatus();
  const origin = opts.hostHeader ? `http://${opts.hostHeader}` : '';

  const dirEntries = fs.readdirSync(targetPath, { withFileTypes: true });
  const entries = await Promise.all(
    dirEntries.map(async (entry) => {
      const childFsPath = path.join(targetPath, entry.name);
      const childStat = fs.statSync(childFsPath);
      const childUrlPath = path.posix.join(
        normalizedPath === '/' ? '' : normalizedPath,
        entry.name,
      );
      const normalizedChildPath = `/${childUrlPath.replace(/^\/+/, '')}`;
      const httpUrl = origin
        ? new URL(normalizedChildPath, `${origin}/`).toString()
        : normalizedChildPath;
      const mime = childStat.isFile() ? guessContentType(childFsPath) : undefined;

      let cid: string | undefined;
      if (
        ipfsStatus.running &&
        childStat.isFile() &&
        shouldExposeViaIpfs({
          relativeUrlPath: normalizedChildPath,
          size: childStat.size,
          mime,
        })
      ) {
        try {
          const result = await opts.ipfsManager.ensurePathCached(childFsPath, {
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
        isDirectory: entry.isDirectory(),
        size: childStat.isFile() ? childStat.size : 0,
        mtimeMs: childStat.mtimeMs,
        mime,
        httpUrl,
        cid,
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
