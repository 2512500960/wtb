import { ipcMain } from 'electron';

import type { EmbeddedAppsCoordinator } from './embedded_apps';

type LoggerLike = {
  warn: (...args: unknown[]) => void;
};

export const registerEmbeddedAppsIpc = (options: {
  embeddedApps: EmbeddedAppsCoordinator;
  logger: LoggerLike;
}): void => {
  ipcMain.handle('cinny:open', async () => {
    try {
      await options.embeddedApps.openCinny();
    } catch (error) {
      options.logger.warn('cinny:open failed', error);
    }
  });

  ipcMain.handle('element:open', async () => {
    try {
      await options.embeddedApps.openElement();
    } catch (error) {
      options.logger.warn('element:open failed', error);
    }
  });
};
