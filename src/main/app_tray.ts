import path from 'path';
import {
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  type App,
} from 'electron';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

const resolveIconPath = (app: App): string => {
  const resourcesPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');
  return path.join(resourcesPath, process.platform === 'win32' ? 'icon.ico' : 'icon.png');
};

export class AppTrayController {
  private tray: Tray | null = null;

  constructor(
    private readonly options: {
      app: App;
      logger: LoggerLike;
      getMainWindow: () => BrowserWindow | null;
      onExitRequested: () => void;
    },
  ) {}

  initialize(): void {
    if (this.tray) return;

    try {
      const icon = nativeImage.createFromPath(resolveIconPath(this.options.app));
      this.tray = new Tray(icon);
      this.tray.setToolTip('WorldTreeBrowser');
      this.tray.on('click', () => {
        this.showMainWindow();
      });
      this.tray.on('double-click', () => {
        this.showMainWindow();
      });
      this.refreshMenu();
      this.options.logger.info('tray initialized');
    } catch (error) {
      this.options.logger.warn('failed to initialize tray', error);
      this.tray = null;
    }
  }

  hideMainWindow(): void {
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.hide();
    this.refreshMenu();
  }

  showMainWindow(): void {
    const mainWindow = this.options.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;

    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    this.refreshMenu();
  }

  dispose(): void {
    try {
      this.tray?.destroy();
    } catch {
      // ignore
    } finally {
      this.tray = null;
    }
  }

  private refreshMenu(): void {
    if (!this.tray) return;

    const mainWindow = this.options.getMainWindow();
    const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? '隐藏主窗口' : '显示主窗口',
        click: () => {
          if (visible) {
            this.hideMainWindow();
            return;
          }
          this.showMainWindow();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.options.onExitRequested();
          this.options.app.quit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }
}