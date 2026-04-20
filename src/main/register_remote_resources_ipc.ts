import { ipcMain } from 'electron';

import type { IpfsSidecarManager } from './ipfs_manager';
import type {
  RemoteResourceFetchResult,
  RemoteResourceManifest,
  RemoteResourceManifestEntry,
  RemoteResourceSource,
} from '../types/remote_resources';

const REMOTE_IPFS_SIZE_THRESHOLD_BYTES = 5 * 1024 * 1024;

const shouldPreferIpfs = (entry: RemoteResourceManifestEntry): boolean => {
  if (entry.isDirectory || !entry.cid) return false;
  const mime = entry.mime || '';
  if (mime.startsWith('video/')) return true;
  if (mime.startsWith('audio/')) return true;
  return entry.size >= REMOTE_IPFS_SIZE_THRESHOLD_BYTES;
};

const normalizeBaseUrl = (input: string): URL => {
  const text = (input || '').trim();
  if (!text) {
    throw new Error('请输入远端 WTB Web 服务地址。');
  }

  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  const url = new URL(withScheme);
  if (!(url.protocol === 'http:' || url.protocol === 'https:')) {
    throw new Error('仅支持 http/https 地址。');
  }
  url.hash = '';
  return url;
};

export const registerRemoteResourcesIpc = (opts: {
  ipfsManager: IpfsSidecarManager;
}): void => {
  ipcMain.handle(
    'remote-resources:fetchManifest',
    async (_event, baseUrlInput: string, requestedPath: string = '/') => {
      const baseUrl = normalizeBaseUrl(baseUrlInput);
      const manifestUrl = new URL('/api/resources', baseUrl);
      manifestUrl.searchParams.set('path', requestedPath || '/');

      const response = await fetch(manifestUrl.toString(), {
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = (await response.json()) as {
        success?: boolean;
        data?: RemoteResourceManifest;
        error?: string;
      };

      if (!response.ok || payload.success !== true || !payload.data) {
        throw new Error(
          payload.error || `资源清单请求失败（HTTP ${response.status}）`,
        );
      }

      const localIpfs = await opts.ipfsManager.getDetailedStatus();
      console.log('[remote-resources] manifest ipfs peers', {
        baseUrl: `${baseUrl.protocol}//${baseUrl.host}`,
        requestedPath: requestedPath || '/',
        localIpfsRunning: localIpfs.running,
        peerAddresses: payload.data.ipfs.peerAddresses,
      });
      const peerConnect = localIpfs.running
        ? await opts.ipfsManager.connectToPeers(payload.data.ipfs.peerAddresses)
        : { connected: [], failed: [] as Array<{ address: string; error: string }> };
      if (!localIpfs.running) {
        console.log('[remote-resources] skipped ipfs peer connect because local ipfs is not running');
      } else {
        // console.log('[remote-resources] ipfs peer connect result', {
        //   connected: peerConnect.connected,
        //   failed: peerConnect.failed,
        // });
      }

      const entries = payload.data.entries.map((entry) => {
        const ipfsUrl =
          localIpfs.running && entry.cid
            ? `${localIpfs.gatewayUrl}/ipfs/${entry.cid}`
            : undefined;
        const availableSources = ipfsUrl ? (['http', 'ipfs'] as const) : (['http'] as const);
        const recommendedSource: RemoteResourceSource =
          shouldPreferIpfs(entry) && ipfsUrl ? 'ipfs' : 'http';
        const recommendedReason = !ipfsUrl
          ? '本地 IPFS 不可用或远端条目未提供 CID，使用 HTTP。'
          : recommendedSource === 'ipfs'
            ? '媒体或大文件优先尝试 IPFS，失败时回退到 HTTP。'
            : '当前条目更适合先走 HTTP，IPFS 可作为补充来源。';

        const preferredUrl = recommendedSource === 'ipfs' && ipfsUrl ? ipfsUrl : entry.httpUrl;
        const fallbackUrl =
          preferredUrl === entry.httpUrl ? ipfsUrl : entry.httpUrl;

        return {
          ...entry,
          ipfsUrl,
          availableSources: [...availableSources],
          recommendedSource,
          recommendedReason,
          preferredUrl,
          fallbackUrl,
          preferredSource: recommendedSource,
        };
      });

      const result: RemoteResourceFetchResult = {
        baseUrl: `${baseUrl.protocol}//${baseUrl.host}`,
        manifestUrl: manifestUrl.toString(),
        path: payload.data.path,
        manifest: payload.data,
        entries,
        localIpfs: {
          running: localIpfs.running,
          gatewayUrl: localIpfs.gatewayUrl,
          connected: peerConnect.connected,
          failed: peerConnect.failed,
        },
      };

      return result;
    },
  );
};
