import { ipcMain } from 'electron';

import type { IpfsSidecarManager } from './ipfs_manager';
import type {
  RemoteResourceFetchResult,
  RemoteResourceManifest,
} from '../types/remote_resources';

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
      const peerConnect = localIpfs.running
        ? await opts.ipfsManager.connectToPeers(payload.data.ipfs.peerAddresses)
        : { connected: [], failed: [] as Array<{ address: string; error: string }> };

      const entries = payload.data.entries.map((entry) => {
        const ipfsUrl =
          localIpfs.running && entry.cid
            ? `${localIpfs.gatewayUrl}/ipfs/${entry.cid}`
            : undefined;
        return {
          ...entry,
          ipfsUrl,
          preferredUrl: ipfsUrl || entry.httpUrl,
          fallbackUrl: ipfsUrl ? entry.httpUrl : undefined,
          preferredSource: ipfsUrl ? ('ipfs' as const) : ('http' as const),
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
