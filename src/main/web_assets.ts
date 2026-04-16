import type { App } from 'electron';
import fs from 'fs';
import path from 'path';

import { ensureDirAsync, pathExists } from './fs_utils';
import { getWtbConfig } from './wtb_config';

const MANAGED_WEB_MANIFEST_NAME = '.wtb-content-sources.json';

export type LegacyWebCompatibilityStatus = {
  bundledShellAvailable: boolean;
  legacyPageReady: boolean;
  hasLegacyIndex: boolean;
  hasVendorDir: boolean;
  hasVendorPlyrCss: boolean;
  hasVendorPlyrJs: boolean;
  hasFilesDir: boolean;
  hasVideoDir: boolean;
  missing: string[];
};

export const copyDirIfMissing = async (
  srcDir: string,
  dstDir: string,
): Promise<void> => {
  if (await pathExists(dstDir)) return;
  await ensureDirAsync(path.dirname(dstDir));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cp = (fs.promises as any).cp as
    | ((src: string, dest: string, opts: unknown) => Promise<void>)
    | undefined;
  if (typeof cp === 'function') {
    await cp(srcDir, dstDir, { recursive: true });
    return;
  }
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  await ensureDirAsync(dstDir);
  await Promise.all(
    entries.map(async (entry) => {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);
      if (entry.isDirectory()) {
        await copyDirIfMissing(src, dst);
      } else {
        await fs.promises.copyFile(src, dst);
      }
    }),
  );
};

export const copyDirContentsIfMissing = async (
  srcDir: string,
  dstDir: string,
): Promise<void> => {
  if (!(await pathExists(srcDir))) return;

  await ensureDirAsync(dstDir);
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const src = path.join(srcDir, entry.name);
      const dst = path.join(dstDir, entry.name);

      if (entry.isDirectory()) {
        if (await pathExists(dst)) {
          await copyDirContentsIfMissing(src, dst);
        } else {
          await copyDirIfMissing(src, dst);
        }
        return;
      }

      if (!(await pathExists(dst))) {
        await fs.promises.copyFile(src, dst);
      }
    }),
  );
};

export const getBundledCinnyDir = (app: App): string => {
  try {
    const cfg = getWtbConfig();
    const override =
      cfg?.web?.assetsDir && cfg.web.assetsDir.trim()
        ? path.resolve(cfg.web.assetsDir)
        : '';
    if (override) return path.join(override, 'cinny');
  } catch {
    // ignore and fall back
  }

  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'cinny')
    : path.join(__dirname, '../../assets', 'cinny');
};

export const getBundledElementDir = (app: App): string => {
  try {
    const cfg = getWtbConfig();
    const override =
      cfg?.web?.assetsDir && cfg.web.assetsDir.trim()
        ? path.resolve(cfg.web.assetsDir)
        : '';
    if (override) return path.join(override, 'element');
  } catch {
    // ignore and fall back
  }

  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'element')
    : path.join(__dirname, '../../assets', 'element');
};

export const getBundledWebDir = (app: App): string => {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'web')
    : path.join(__dirname, '../../assets', 'web');
};

export const getUserCinnyDir = (app: App): string => {
  return path.join(app.getPath('userData'), 'cinny');
};

export const getUserElementDir = (app: App): string => {
  return path.join(app.getPath('userData'), 'element');
};

export const ensureDefaultWebAssets = async (
  app: App,
  webRoot: string,
): Promise<void> => {
  const bundledDir = getBundledWebDir(app);
  if (!(await pathExists(path.join(bundledDir, 'index.html')))) return;

  const bundledResolved = path.resolve(bundledDir).toLowerCase();
  const webRootResolved = path.resolve(webRoot).toLowerCase();
  if (bundledResolved === webRootResolved) return;

  await copyDirContentsIfMissing(bundledDir, webRoot);
  await ensureDirAsync(path.join(webRoot, 'files'));
  await ensureDirAsync(path.join(webRoot, 'video'));

  const manifestPath = path.join(webRoot, MANAGED_WEB_MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) {
    return;
  }

  try {
    const raw = await fs.promises.readFile(manifestPath, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
    if (parsed.entries && Object.keys(parsed.entries).length > 0) {
      return;
    }
  } catch {
    // ignore invalid manifests; static shell has already been seeded above
  }
};

export const inspectLegacyWebCompatibility = async (
  app: App,
  webRoot: string,
): Promise<LegacyWebCompatibilityStatus> => {
  const bundledDir = getBundledWebDir(app);
  const bundledShellAvailable = await pathExists(path.join(bundledDir, 'index.html'));
  const hasLegacyIndex = await pathExists(path.join(webRoot, 'index.html'));
  const hasVendorDir = await pathExists(path.join(webRoot, 'vendor'));
  const hasVendorPlyrCss = await pathExists(path.join(webRoot, 'vendor', 'plyr.css'));
  const hasVendorPlyrJs = await pathExists(path.join(webRoot, 'vendor', 'plyr.min.js'));
  const hasFilesDir = await pathExists(path.join(webRoot, 'files'));
  const hasVideoDir = await pathExists(path.join(webRoot, 'video'));

  const missing: string[] = [];
  if (!hasLegacyIndex) missing.push('index.html');
  if (!hasVendorDir) missing.push('vendor/');
  if (!hasVendorPlyrCss) missing.push('vendor/plyr.css');
  if (!hasVendorPlyrJs) missing.push('vendor/plyr.min.js');
  if (!hasFilesDir) missing.push('files/');
  if (!hasVideoDir) missing.push('video/');

  return {
    bundledShellAvailable,
    legacyPageReady: missing.length === 0,
    hasLegacyIndex,
    hasVendorDir,
    hasVendorPlyrCss,
    hasVendorPlyrJs,
    hasFilesDir,
    hasVideoDir,
    missing,
  };
};

export const ensureCinnyConfig = async (cinnyDir: string): Promise<void> => {
  try {
    const configPath = path.join(cinnyDir, 'config.json');
    if (!(await pathExists(configPath))) return;

    const raw = await fs.promises.readFile(configPath, { encoding: 'utf8' });
    const data = JSON.parse(raw) as any;
    if (!data || typeof data !== 'object') return;

    if (!data.hashRouter || typeof data.hashRouter !== 'object') {
      data.hashRouter = { enabled: true, basename: '/' };
    } else {
      data.hashRouter.enabled = true;
      if (typeof data.hashRouter.basename !== 'string') {
        data.hashRouter.basename = '/';
      }
    }

    await fs.promises.writeFile(configPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf8',
    });
  } catch {
    // ignore best-effort config patching
  }
};

export const ensureElementConfig = async (
  elementDir: string,
): Promise<void> => {
  try {
    const configPath = path.join(elementDir, 'config.json');
    if (!(await pathExists(configPath))) {
      const samplePath = path.join(elementDir, 'config.sample.json');
      if (await pathExists(samplePath)) {
        const raw = await fs.promises.readFile(samplePath, {
          encoding: 'utf8',
        });
        await fs.promises.writeFile(configPath, raw, { encoding: 'utf8' });
      } else {
        const minimal = {
          default_server_config: {
            'm.homeserver': {
              base_url: 'https://matrix.org',
              server_name: 'matrix.org',
            },
            'm.identity_server': {
              base_url: 'https://vector.im',
            },
          },
          disable_custom_urls: false,
          disable_guests: false,
        };

        await fs.promises.writeFile(
          configPath,
          `${JSON.stringify(minimal, null, 2)}\n`,
          {
            encoding: 'utf8',
          },
        );
      }
    }

    const rawCfg = await fs.promises.readFile(configPath, { encoding: 'utf8' });
    const variants = ['config.127.0.0.1.json', 'config.localhost.json'];
    await Promise.all(
      variants.map(async (name) => {
        const targetPath = path.join(elementDir, name);
        if (await pathExists(targetPath)) return;
        await fs.promises.writeFile(targetPath, rawCfg, { encoding: 'utf8' });
      }),
    );
  } catch {
    // ignore best-effort config seeding
  }
};
