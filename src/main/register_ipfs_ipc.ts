import { dialog, ipcMain } from 'electron';

import type { IpfsDetailedStatus } from './ipfs_manager';

type RegisterIpfsIpcOptions = {
  getDetailedStatus: () => Promise<IpfsDetailedStatus>;
  addPath: (
    targetPath: string,
    options?: { wrapWithDirectory?: boolean },
  ) => Promise<{ cid: string; path: string }>;
};

export const registerIpfsIpc = (options: RegisterIpfsIpcOptions): void => {
  ipcMain.handle('ipfs:statusDetailed', async () => {
    return await options.getDetailedStatus();
  });

  ipcMain.handle('ipfs:addPath', async (_event, targetPath: string) => {
    return await options.addPath(targetPath);
  });

  ipcMain.handle('ipfs:pickAndAddPath', async () => {
    try {
      const res = await dialog.showOpenDialog({
        properties: ['openFile', 'openDirectory'],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }

      const selectedPath = res.filePaths[0];
      const result = await options.addPath(selectedPath);
      return {
        ok: true,
        ...result,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
};
