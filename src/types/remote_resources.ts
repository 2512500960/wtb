export type RemoteResourceManifestEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  mime?: string;
  httpUrl: string;
  cid?: string;
  sourceMode?: 'local' | 'dual' | 'ipfs-backed';
};

export type RemoteResourceSource = 'http' | 'ipfs';

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
  availableSources: RemoteResourceSource[];
  recommendedSource: RemoteResourceSource;
  recommendedReason: string;
  preferredUrl: string;
  fallbackUrl?: string;
  preferredSource: RemoteResourceSource;
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
