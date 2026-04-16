import { dialog, ipcMain } from 'electron';

import type { IpfsDetailedStatus, IpfsStorageSummary } from './ipfs_manager';

type TaskProgressPayload = {
  operation:
    | 'import-files'
    | 'import-directory'
    | 'migrate-web-content'
    | 'migrate-repo';
  stage: 'running' | 'completed' | 'failed';
  current: number;
  total: number;
  message: string;
};

type RegisterIpfsIpcOptions = {
  getDetailedStatus: () => Promise<IpfsDetailedStatus>;
  getStorageSummary: () => Promise<IpfsStorageSummary>;
  listSwarmPeers: () => Promise<unknown[]>;
  addPath: (
    targetPath: string,
    options?: { wrapWithDirectory?: boolean },
  ) => Promise<{ cid: string; path: string }>;
  migrateRepo: (
    targetDir: string,
    onProgress?: (progress: Omit<TaskProgressPayload, 'operation' | 'stage'>) => void,
  ) => Promise<unknown>;
  notifyTaskProgress: (payload: TaskProgressPayload) => void;
};

export const registerIpfsIpc = (options: RegisterIpfsIpcOptions): void => {
  ipcMain.handle('ipfs:statusDetailed', async () => {
    return await options.getDetailedStatus();
  });

  ipcMain.handle('ipfs:storageSummary', async () => {
    return await options.getStorageSummary();
  });

  ipcMain.handle('ipfs:swarmPeers', async () => {
    return await options.listSwarmPeers();
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

  ipcMain.handle('ipfs:migrateRepoDir', async (_event, targetDir: string) => {
    try {
      options.notifyTaskProgress({
        operation: 'migrate-repo',
        stage: 'running',
        current: 0,
        total: 3,
        message: '正在准备迁移 IPFS 数据目录…',
      });
      const result = await options.migrateRepo(targetDir, (progress) => {
        options.notifyTaskProgress({
          operation: 'migrate-repo',
          stage: 'running',
          ...progress,
        });
      });
      options.notifyTaskProgress({
        operation: 'migrate-repo',
        stage: 'completed',
        current: 3,
        total: 3,
        message: 'IPFS 数据目录迁移完成。',
      });
      return { ok: true, result };
    } catch (error) {
      options.notifyTaskProgress({
        operation: 'migrate-repo',
        stage: 'failed',
        current: 0,
        total: 3,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
};
