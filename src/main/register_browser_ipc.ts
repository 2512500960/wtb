import { ipcMain } from 'electron';

import type { BrowserWindowCoordinator } from './browser_windows';

type LoggerLike = {
  warn: (...args: unknown[]) => void;
};

export const registerBrowserIpc = (options: {
  browserWindows: BrowserWindowCoordinator;
  logger: LoggerLike;
}): void => {
  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      await options.browserWindows.openExternalUrl(url);
    } catch (error) {
      options.logger.warn('open-external failed', error);
    }
  });

  ipcMain.handle('open-in-app', async (_event, url: string) => {
    try {
      await options.browserWindows.openInAppUrl(url);
    } catch (error) {
      options.logger.warn('open-in-app failed', error);
    }
  });

  ipcMain.handle(
    'open-proxied-window',
    async (_event, proxyUri: string, targetUrl?: string) => {
      try {
        if (!proxyUri || typeof proxyUri !== 'string') return;
        void options.browserWindows.openProxiedWindow(
          proxyUri,
          typeof targetUrl === 'string' ? targetUrl : 'https://www.google.com',
        );
      } catch (error) {
        options.logger.warn('open-proxied-window failed', error);
      }
    },
  );

  ipcMain.handle(
    'proxied-window-command',
    async (_event, windowId: number, command: string, value?: string) => {
      return await options.browserWindows.handleProxiedWindowCommand(
        windowId,
        command,
        value,
      );
    },
  );
};
