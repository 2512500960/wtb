import fs from 'fs';
import os from 'os';
import path from 'path';

jest.mock('../main/wtb_config', () => ({
  getWtbConfig: () => ({}),
  setWtbIpfsRepoDir: jest.fn(),
}));

import { IpfsSidecarManager } from '../main/ipfs_manager';

describe('IpfsSidecarManager repo size fallback', () => {
  let repoRoot: string;
  let userDataRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-ipfs-repo-'));
    userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wtb-user-data-'));
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
});
