import type { App } from 'electron';
import fs from 'fs';
import path from 'path';

import { ensureDirAsync, pathExists } from './fs_utils';
import { getWtbConfig } from './wtb_config';
import { log } from 'console';

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
  // 日志输出srcDir和dstDir，帮助调试 --- IGNORE ---
  log(`copyDirIfMissing: copying from ${srcDir} to ${dstDir}`);
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
    : path.join(__dirname, '../../wtb-data', 'web');
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
  try {
    const cfg = getWtbConfig();
    const override =
      cfg?.web?.assetsDir && cfg.web.assetsDir.trim()
        ? cfg.web.assetsDir.trim()
        : '';
    if (override) return;
  } catch {
    // ignore
  }

  const bundledDir = getBundledWebDir(app);
  if (!(await pathExists(path.join(bundledDir, 'index.html')))) return;

  const bundledResolved = path.resolve(bundledDir).toLowerCase();
  const webRootResolved = path.resolve(webRoot).toLowerCase();
  if (bundledResolved === webRootResolved) return;

  await copyDirContentsIfMissing(bundledDir, webRoot);
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
