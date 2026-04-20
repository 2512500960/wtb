import fs from 'fs';
import os from 'os';
import path from 'path';

const mockSetWtbIpfsRepoDir = jest.fn();
let mockConfig: { ipfs?: { repoDir?: string } } = {};

jest.mock('../main/wtb_config', () => ({
  getWtbConfig: () => mockConfig,
  setWtbIpfsRepoDir: mockSetWtbIpfsRepoDir,
}));

import { IpfsSidecarManager } from '../main/ipfs_manager';

describe('IpfsSidecarManager repo size fallback', () => {
  let repoRoot: string;
  let userDataRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-ipfs-repo-'));
    userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-user-data-'));
    mockConfig = {};
    mockSetWtbIpfsRepoDir.mockReset();
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(userDataRoot, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('uses an out-of-workspace repo by default in development', () => {
    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: false,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });

    expect(manager.getRepoDir()).toBe(path.join(userDataRoot, 'ipfs'));
  });

  test('migrates a legacy development repo out of the workspace when possible', () => {
    const legacyRepoDir = path.join(repoRoot, 'ipfs');
    const preferredRepoDir = path.join(userDataRoot, 'ipfs');
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    fs.mkdirSync(legacyRepoDir, { recursive: true });
    fs.writeFileSync(path.join(legacyRepoDir, 'config'), '{"Identity":{}}\n', 'utf8');

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: false,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      logger,
    });

    expect(manager.getRepoDir()).toBe(preferredRepoDir);
    expect(fs.existsSync(path.join(preferredRepoDir, 'config'))).toBe(true);
    expect(fs.existsSync(legacyRepoDir)).toBe(false);
    expect(logger.info).toHaveBeenCalled();
  });

  test('falls back to recursive copy when moving a legacy development repo across devices', () => {
    const legacyRepoDir = path.join(repoRoot, 'ipfs');
    const preferredRepoDir = path.join(userDataRoot, 'ipfs');
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    fs.mkdirSync(path.join(legacyRepoDir, 'datastore'), { recursive: true });
    fs.writeFileSync(path.join(legacyRepoDir, 'config'), '{"Identity":{}}\n', 'utf8');
    fs.writeFileSync(path.join(legacyRepoDir, 'datastore', 'value.bin'), Buffer.from('abc'));

    const originalRenameSync = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (
        path.resolve(String(oldPath)) === path.resolve(legacyRepoDir) &&
        path.resolve(String(newPath)) === path.resolve(preferredRepoDir)
      ) {
        const error = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV',
        });
        throw error;
      }

      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync);

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: false,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      logger,
    });

    expect(manager.getRepoDir()).toBe(preferredRepoDir);
    expect(fs.readFileSync(path.join(preferredRepoDir, 'datastore', 'value.bin'))).toEqual(Buffer.from('abc'));
    expect(fs.existsSync(legacyRepoDir)).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('skips transient .temp batch files when estimating repo size', () => {
    const blocksDir = path.join(repoRoot, 'blocks');
    const tempDir = path.join(blocksDir, '.temp');
    const stableFilePath = path.join(blocksDir, 'stable.data');
    const transientFilePath = path.join(tempDir, 'batch.data');

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(stableFilePath, Buffer.alloc(11));
    fs.writeFileSync(transientFilePath, Buffer.alloc(29));

    const originalStatSync = fs.statSync;
    jest.spyOn(fs, 'statSync').mockImplementation(((targetPath: fs.PathLike) => {
      if (path.resolve(String(targetPath)) === path.resolve(transientFilePath)) {
        const error = Object.assign(
          new Error(`EPERM: operation not permitted, stat '${transientFilePath}'`),
          { code: 'EPERM' },
        );
        throw error;
      }

      return originalStatSync(targetPath);
    }) as typeof fs.statSync);

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: false,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => path.dirname(repoRoot),
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });

    const repoSizeBytes = (manager as unknown as {
      getDirectorySizeBytes: (targetPath: string) => number;
    }).getDirectorySizeBytes(repoRoot);

    expect(repoSizeBytes).toBe(11);
  });

  test('updates the cached repo path before restarting after migration', async () => {
    const currentRepoDir = path.join(repoRoot, 'current-ipfs');
    const nextRepoDir = path.join(userDataRoot, 'migrated-ipfs');
    mockConfig = { ipfs: { repoDir: currentRepoDir } };

    fs.mkdirSync(currentRepoDir, { recursive: true });
    fs.writeFileSync(path.join(currentRepoDir, 'config'), '{"Identity":{}}\n', 'utf8');

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: true,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });

    expect(manager.getRepoDir()).toBe(currentRepoDir);

    jest.spyOn(manager, 'getServiceStatus').mockReturnValue({
      name: 'ipfs',
      state: 'running',
    });
    jest.spyOn(manager, 'stop').mockResolvedValue({
      name: 'ipfs',
      state: 'stopped',
    });
    const startSpy = jest.spyOn(manager, 'start').mockImplementation(async () => {
      expect(manager.getRepoDir()).toBe(nextRepoDir);
      return {
        name: 'ipfs',
        state: 'running',
      };
    });

    const result = await manager.migrateRepo(nextRepoDir);

    expect(result).toEqual({
      fromDir: currentRepoDir,
      toDir: nextRepoDir,
      restarted: true,
    });
    expect(manager.getRepoDir()).toBe(nextRepoDir);
    expect(fs.existsSync(path.join(nextRepoDir, 'config'))).toBe(true);
    expect(fs.existsSync(currentRepoDir)).toBe(false);
    expect(mockSetWtbIpfsRepoDir).toHaveBeenCalledWith(nextRepoDir);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  test('moves the WTB Ygg address from Announce to AppendAnnounce', async () => {
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    const repoDir = path.join(userDataRoot, 'ipfs');
    const yggMultiaddr = '/ip6/2001:db8::1/tcp/4001';
    const preservedAnnounce = '/ip4/203.0.113.10/tcp/4001';

    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'config'),
      `${JSON.stringify(
        {
          Addresses: {
            Announce: [yggMultiaddr, preservedAnnounce],
            AppendAnnounce: [],
          },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: false,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      getYggdrasilAddress: async () => '2001:db8::1',
      logger,
    });

    await (manager as unknown as {
      updateRepoConfig: () => Promise<void>;
    }).updateRepoConfig();

    const updatedConfig = JSON.parse(
      fs.readFileSync(path.join(repoDir, 'config'), 'utf8'),
    ) as {
      Addresses?: {
        Announce?: string[];
        AppendAnnounce?: string[];
      };
    };

    expect(updatedConfig.Addresses?.Announce).toEqual([preservedAnnounce]);
    expect(updatedConfig.Addresses?.AppendAnnounce).toEqual([yggMultiaddr]);
  });

  test('keeps the source repo when cross-device copy fails during migration', async () => {
    const currentRepoDir = path.join(repoRoot, 'current-ipfs');
    const nextRepoDir = path.join(userDataRoot, 'migrated-ipfs');
    mockConfig = { ipfs: { repoDir: currentRepoDir } };

    fs.mkdirSync(path.join(currentRepoDir, 'blocks'), { recursive: true });
    fs.writeFileSync(path.join(currentRepoDir, 'config'), '{"Identity":{}}\n', 'utf8');
    fs.writeFileSync(path.join(currentRepoDir, 'blocks', 'block.data'), Buffer.from('repo-data'));

    const manager = new IpfsSidecarManager({
      app: {
        isPackaged: true,
        getPath: jest.fn((name: string) => {
          if (name === 'userData') {
            return userDataRoot;
          }
          throw new Error(`Unexpected app path request: ${name}`);
        }),
      } as unknown as Electron.App,
      getWtbDataDir: () => repoRoot,
      logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });

    jest.spyOn(manager, 'getServiceStatus').mockReturnValue({
      name: 'ipfs',
      state: 'stopped',
    });

    const originalRenameSync = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation(((oldPath: fs.PathLike, newPath: fs.PathLike) => {
      if (
        path.resolve(String(oldPath)) === path.resolve(currentRepoDir) &&
        path.resolve(String(newPath)) === path.resolve(nextRepoDir)
      ) {
        const error = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
          code: 'EXDEV',
        });
        throw error;
      }

      return originalRenameSync(oldPath, newPath);
    }) as typeof fs.renameSync);

    const originalCopyFileSync = fs.copyFileSync;
    jest.spyOn(fs, 'copyFileSync').mockImplementation(((src, dest, mode) => {
      if (
        typeof src !== 'number' &&
        path.resolve(String(src)) ===
          path.resolve(path.join(currentRepoDir, 'blocks', 'block.data'))
      ) {
        throw new Error('copy failed');
      }

      return originalCopyFileSync(src, dest, mode);
    }) as typeof fs.copyFileSync);

    await expect(manager.migrateRepo(nextRepoDir)).rejects.toThrow('copy failed');

    expect(fs.existsSync(path.join(currentRepoDir, 'blocks', 'block.data'))).toBe(true);
    expect(fs.existsSync(nextRepoDir)).toBe(false);
    expect(mockSetWtbIpfsRepoDir).not.toHaveBeenCalledWith(nextRepoDir);
  });
});
