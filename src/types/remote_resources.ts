export type RemoteResourceManifestEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  mime?: string;
  httpUrl: string;
  cid?: string;
};

export type RemoteResourceManifest = {
  path: string;
  generatedAt: string;
  ipfs: {
    enabled: boolean;
    peerId?: string;
    peerAddresses: string[];
  };
  entries: RemoteResourceManifestEntry[];
};

export type RemoteResourcePreparedEntry = RemoteResourceManifestEntry & {
  ipfsUrl?: string;
  preferredUrl: string;
  fallbackUrl?: string;
  preferredSource: 'http' | 'ipfs';
};

export type RemoteResourceFetchResult = {
  baseUrl: string;
  manifestUrl: string;
  path: string;
  manifest: RemoteResourceManifest;
  entries: RemoteResourcePreparedEntry[];
  localIpfs: {
    running: boolean;
    gatewayUrl: string;
    connected: string[];
    failed: Array<{ address: string; error: string }>;
  };
};
