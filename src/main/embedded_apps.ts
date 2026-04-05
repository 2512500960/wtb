import {
  BrowserWindow,
  Menu,
  dialog,
  shell,
  type App,
  type Session,
} from 'electron';
import fs from 'fs';
import path from 'path';

import { EmbeddedStaticServer } from './embedded_static_server';
import { pathExists } from './fs_utils';
import {
  copyDirIfMissing,
  ensureCinnyConfig,
  ensureElementConfig,
  getBundledCinnyDir,
  getBundledElementDir,
  getUserCinnyDir,
  getUserElementDir,
} from './web_assets';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

const attachSelectionContextMenu = (targetWindow: BrowserWindow): void => {
  targetWindow.webContents.on('context-menu', (_event, params) => {
    try {
      const hasSelection = (params.selectionText || '').trim().length > 0;
      const isEditable = !!params.isEditable;

      const template = isEditable
        ? [
            { role: 'cut' as const, enabled: hasSelection },
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'paste' as const },
            { type: 'separator' as const },
            { role: 'selectAll' as const },
          ]
        : [
            { role: 'copy' as const, enabled: hasSelection },
            { role: 'selectAll' as const },
          ];

      Menu.buildFromTemplate(template).popup({ window: targetWindow });
    } catch {
      // ignore
    }
  });
};

export class EmbeddedAppsCoordinator {
  constructor(
    private readonly options: {
      app: App;
      logger: LoggerLike;
      cinnyStaticServer: EmbeddedStaticServer;
      elementStaticServer: EmbeddedStaticServer;
      applyChineseAcceptLanguage: (session: Session) => void;
      applyElementAcceptLanguage: (session: Session) => void;
    },
  ) {}

  async openCinny(): Promise<void> {
    const bundledDir = getBundledCinnyDir(this.options.app);
    const userDir = getUserCinnyDir(this.options.app);
    const bundledIndex = path.join(bundledDir, 'index.html');
    const userIndex = path.join(userDir, 'index.html');

    if (!(await pathExists(bundledIndex))) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Cinny 未集成',
        message: '未找到内置 Cinny 静态文件（assets/cinny/index.html）。',
        detail:
          '请在源码目录执行：\n\n  npm run cinny:fetch\n\n或将 Cinny release 的 dist/ 内容拷贝到 assets/cinny/ 后重新打包。',
      });
      return;
    }

    let rootToServe = bundledDir;

    if (this.options.app.isPackaged) {
      await copyDirIfMissing(bundledDir, userDir);

      if (!(await pathExists(userIndex))) {
        try {
          await fs.promises.rm(userDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        await copyDirIfMissing(bundledDir, userDir);
      }

      rootToServe = (await pathExists(userIndex)) ? userDir : bundledDir;
    }

    await ensureCinnyConfig(rootToServe);
    const port = await this.options.cinnyStaticServer.start(rootToServe);
    const child = this.createCinnyWindow();

    try {
      await child.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
      });
      await child.webContents.session.clearCache();
    } catch {
      // ignore
    }

    await child.loadURL(`http://127.0.0.1:${port}/`);
  }

  async openElement(): Promise<void> {
    const bundledDir = getBundledElementDir(this.options.app);
    const userDir = getUserElementDir(this.options.app);
    const bundledIndex = path.join(bundledDir, 'index.html');
    const userIndex = path.join(userDir, 'index.html');

    if (!(await pathExists(bundledIndex))) {
      await dialog.showMessageBox({
        type: 'warning',
        title: 'Element 未集成',
        message: '未找到内置 Element 静态文件（assets/element/index.html）。',
        detail:
          '请在源码目录执行：\n\n  npm run element:fetch\n\n或将 Element Web release 的静态文件拷贝到 assets/element/ 后重新打包。',
      });
      return;
    }

    let rootToServe = bundledDir;

    if (this.options.app.isPackaged) {
      await copyDirIfMissing(bundledDir, userDir);

      if (!(await pathExists(userIndex))) {
        try {
          await fs.promises.rm(userDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
        await copyDirIfMissing(bundledDir, userDir);
      }

      rootToServe = (await pathExists(userIndex)) ? userDir : bundledDir;
    }

    await ensureElementConfig(rootToServe);

    const port = await this.options.elementStaticServer.start(rootToServe);
    const elementUrl = `http://127.0.0.1:${port}/`;
    const defaultUseExternalBrowser = true;
    const envVal =
      process.env.ELEMENT_USE_EXTERNAL_BROWSER ??
      process.env.ELEMENT_USE_LOCAL_BROWSER;
    const useExternal =
      envVal !== undefined ? envVal === 'true' : defaultUseExternalBrowser;

    if (useExternal) {
      try {
        await shell.openExternal(elementUrl);
        this.options.logger.info('element: opened in external browser', elementUrl);
      } catch (error) {
        this.options.logger.warn('element: failed to open external browser', error);
      }
      return;
    }

    const child = this.createElementWindow();
    try {
      await child.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
      });
      await child.webContents.session.clearCache();
    } catch {
      // ignore
    }

    await child.loadURL(elementUrl);
  }

  private createCinnyWindow(): BrowserWindow {
    const child = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:cinny',
      },
    });

    this.options.applyChineseAcceptLanguage(child.webContents.session);
    attachSelectionContextMenu(child);
    child.once('ready-to-show', () => child.show());

    child.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const parsed = new URL(navUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });

    child.webContents.setWindowOpenHandler((details) => {
      try {
        const parsed = new URL(details.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { action: 'deny' };
        }

        const popup = this.createCinnyWindow();
        popup.loadURL(parsed.toString()).catch(() => {
          // ignore
        });
        return { action: 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });

    return child;
  }

  private createElementWindow(): BrowserWindow {
    const child = new BrowserWindow({
      width: 1100,
      height: 760,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: 'persist:element',
      },
    });

    this.options.applyElementAcceptLanguage(child.webContents.session);
    attachSelectionContextMenu(child);
    child.once('ready-to-show', () => child.show());

    child.webContents.on('will-navigate', (event, navUrl) => {
      try {
        const parsed = new URL(navUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          event.preventDefault();
        }
      } catch {
        event.preventDefault();
      }
    });

    child.webContents.setWindowOpenHandler((details) => {
      try {
        const parsed = new URL(details.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { action: 'deny' };
        }

        const popup = this.createElementWindow();
        popup.loadURL(parsed.toString()).catch(() => {
          // ignore
        });
        return { action: 'deny' };
      } catch {
        return { action: 'deny' };
      }
    });

    return child;
  }
}
