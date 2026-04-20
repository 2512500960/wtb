import type { IpfsSidecarManager } from './ipfs_manager';
import { getWtbConfig } from './wtb_config';
import { listWebContentDirectoryEntries } from './web_content_sources';
import { parseAndNormalizeUrlPath } from './web_service_utils';
import type { RemoteResourceManifest } from '../types/remote_resources';

const IPFS_SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024;

const extractIp4FromMultiaddr = (address: string): string | null => {
  const match = address.match(/\/ip4\/([^/]+)/i);
  return match?.[1] || null;
};

const extractIp6FromMultiaddr = (address: string): string | null => {
  const match = address.match(/\/ip6\/([^/]+)/i);
  return match?.[1] || null;
};

const isLoopbackOrLinkLocalIpv4 = (ip: string): boolean => {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  if (first === 127) return true;
  if (first === 169 && second === 254) return true;
  return false;
};

const isPrivateIpv4 = (ip: string): boolean => {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  return false;
};

const normalizeIpv6 = (ip: string): string => ip.trim().toLowerCase();

const isLoopbackOrLinkLocalIpv6 = (ip: string): boolean => {
  const normalized = normalizeIpv6(ip);
  if (!normalized) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9')) return true;
  if (normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  return false;
};

const isPrivateIpv6 = (ip: string): boolean => {
  const normalized = normalizeIpv6(ip);
  if (!normalized) return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
};

const shouldExposePeerAddress = (
  address: string,
  allowPrivateAddresses: boolean,
): boolean => {
  const trimmed = address.trim();
  if (!trimmed) return false;

  if (/\/dns(?:4|6)?\/localhost(?:\/|$)/i.test(trimmed)) {
    return false;
  }

  const ip4 = extractIp4FromMultiaddr(trimmed);
  if (ip4) {
    if (isLoopbackOrLinkLocalIpv4(ip4)) return false;
    if (!allowPrivateAddresses && isPrivateIpv4(ip4)) return false;
    return true;
  }

  const ip6 = extractIp6FromMultiaddr(trimmed);
  if (ip6) {
    if (isLoopbackOrLinkLocalIpv6(ip6)) return false;
    if (!allowPrivateAddresses && isPrivateIpv6(ip6)) return false;
    return true;
  }

  return true;
};

const filterPeerAddressesForManifest = (addresses: string[]): string[] => {
  const allowPrivateAddresses =
    getWtbConfig().ipfs?.allowPrivateAddressesInResourceManifest ?? true;

  return Array.from(
    new Set(
      addresses.filter((address) =>
        shouldExposePeerAddress(address, allowPrivateAddresses),
      ),
    ),
  );
};

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
      peerAddresses: filterPeerAddressesForManifest(ipfsStatus.addresses),
    },
    entries,
  };
};
