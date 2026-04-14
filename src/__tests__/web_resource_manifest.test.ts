jest.mock('../main/web_content_sources', () => ({
  listWebContentDirectoryEntries: jest.fn(() => []),
}));

const mockGetWtbConfig = jest.fn();

jest.mock('../main/wtb_config', () => ({
  getWtbConfig: () => mockGetWtbConfig(),
}));

import { buildWebResourceManifest } from '../main/web_resource_manifest';

describe('buildWebResourceManifest', () => {
  beforeEach(() => {
    mockGetWtbConfig.mockReset();
  });

  test('keeps private addresses by default while filtering loopback and link-local', async () => {
    mockGetWtbConfig.mockReturnValue({});

    const manifest = await buildWebResourceManifest({
      hostHeader: 'example.test',
      webRoot: 'C:/tmp/wtb-web',
      requestedPath: '/',
      ipfsManager: {
        getDetailedStatus: jest.fn().mockResolvedValue({
          running: true,
          repoDir: 'C:/tmp/ipfs',
          apiUrl: 'http://127.0.0.1:5001',
          gatewayUrl: 'http://127.0.0.1:8080',
          pid: 123,
          peerId: '12D3KooWExamplePeer',
          addresses: [
            '/ip4/127.0.0.1/tcp/4001',
            '/ip4/169.254.10.20/tcp/4001',
            '/ip4/192.168.1.8/tcp/4001',
            '/ip4/203.0.113.10/tcp/4001',
            '/ip6/::1/tcp/4001',
            '/ip6/fe80::1/tcp/4001',
            '/ip6/fd00::1234/tcp/4001',
            '/ip6/202:3027:c5ea:df54:85e8:4156:4dd3:7abb/tcp/4001',
            '/dns4/localhost/tcp/4001/ws',
          ],
        }),
      } as never,
    });

    expect(manifest.ipfs.peerAddresses).toEqual([
      '/ip4/192.168.1.8/tcp/4001',
      '/ip4/203.0.113.10/tcp/4001',
      '/ip6/fd00::1234/tcp/4001',
      '/ip6/202:3027:c5ea:df54:85e8:4156:4dd3:7abb/tcp/4001',
    ]);
  });

  test('can disable private address exposure in the manifest', async () => {
    mockGetWtbConfig.mockReturnValue({
      ipfs: {
        allowPrivateAddressesInResourceManifest: false,
      },
    });

    const manifest = await buildWebResourceManifest({
      hostHeader: 'example.test',
      webRoot: 'C:/tmp/wtb-web',
      requestedPath: '/',
      ipfsManager: {
        getDetailedStatus: jest.fn().mockResolvedValue({
          running: true,
          repoDir: 'C:/tmp/ipfs',
          apiUrl: 'http://127.0.0.1:5001',
          gatewayUrl: 'http://127.0.0.1:8080',
          pid: 123,
          peerId: '12D3KooWExamplePeer',
          addresses: [
            '/ip4/192.168.1.8/tcp/4001',
            '/ip4/203.0.113.10/tcp/4001',
            '/ip6/fd00::1234/tcp/4001',
            '/ip6/202:3027:c5ea:df54:85e8:4156:4dd3:7abb/tcp/4001',
          ],
        }),
      } as never,
    });

    expect(manifest.ipfs.peerAddresses).toEqual([
      '/ip4/203.0.113.10/tcp/4001',
      '/ip6/202:3027:c5ea:df54:85e8:4156:4dd3:7abb/tcp/4001',
    ]);
  });
});