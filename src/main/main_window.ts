import path from 'path';
import { BrowserWindow, Menu, shell, type App } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';

import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    try {
      const logFilePath = log.transports.file.getFile().path;
      log.info(`electron-log file: ${logFilePath}`);
    } catch (error) {
      log.warn('Unable to determine electron-log file path', error);
    }

    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

export const configureMainProcessDebugging = (): void => {
  if (process.env.NODE_ENV === 'production') {
    const sourceMapSupport = require('source-map-support');
    sourceMapSupport.install();
  }

  if (isDebug) {
    require('electron-debug').default();
  }
};

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

export const createMainWindow = async (options: {
  app: App;
  onClosed: () => void;
}): Promise<BrowserWindow> => {
  if (isDebug) {
    await installExtensions();
  }

  const resourcesPath = options.app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(resourcesPath, ...paths);
  };

  const mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: options.app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  const revealMainWindow = (): void => {
    if (mainWindow.isDestroyed()) return;
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
      return;
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
  };

  mainWindow.once('ready-to-show', () => {
    revealMainWindow();
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
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

      Menu.buildFromTemplate(template).popup({ window: mainWindow });
    } catch {
      // ignore
    }
  });

  await mainWindow.loadURL(resolveHtmlPath('index.html'));

  // `ready-to-show` may fire before `loadURL()` resolves on fast paths, so keep
  // a post-load fallback to avoid ending up with a hidden main window.
  revealMainWindow();

  mainWindow.on('closed', () => {
    options.onClosed();
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  mainWindow.webContents.setWindowOpenHandler((eventData) => {
    shell.openExternal(eventData.url);
    return { action: 'deny' };
  });

  // eslint-disable-next-line no-new
  new AppUpdater();
  return mainWindow;
};
