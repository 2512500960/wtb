import { ipcMain, shell } from 'electron';
import log from 'electron-log';

import { ensureDirExists } from './fs_utils';
import type { ServiceName, ServiceStatus } from './service_types';

type RegisterServiceIpcOptions = {
  getAllServiceStatuses: () => ServiceStatus[] | Promise<ServiceStatus[]>;
  scheduleAutoStartYggPeerManagerIfNeeded: (reason: string) => void;
  startYggdrasil: () => Promise<ServiceStatus>;
  stopYggdrasil: () => Promise<ServiceStatus>;
  getYggdrasilStatus: () => ServiceStatus;
  startWebService: () => Promise<ServiceStatus>;
  stopWebService: () => Promise<ServiceStatus>;
  getWebRootDir: () => string;
  startIpfsService: () => Promise<ServiceStatus>;
  stopIpfsService: () => Promise<ServiceStatus>;
  getIpfsRepoDir: () => string;
  onBeforeStopYggdrasil: () => Promise<void>;
  onAfterStopYggdrasil: () => void;
};

export const registerServiceIpc = (
  options: RegisterServiceIpcOptions,
): void => {
  ipcMain.handle('services:getAll', async () => {
    const all = await options.getAllServiceStatuses();
    options.scheduleAutoStartYggPeerManagerIfNeeded(
      'yggdrasil already running (services:getAll)',
    );
    return all;
  });

  ipcMain.handle('services:start', async (_event, serviceName: ServiceName) => {
    try {
      if (serviceName === 'yggdrasil') {
        const res = await options.startYggdrasil();
        options.scheduleAutoStartYggPeerManagerIfNeeded('yggdrasil started');
        return res;
      }

      if (serviceName === 'web') {
        return await options.startWebService();
      }

      if (serviceName === 'ipfs') {
        return await options.startIpfsService();
      }

      const ygg = options.getYggdrasilStatus();
      if (ygg.state !== 'running') {
        throw new Error(`Yggdrasil 未运行，无法启动 ${serviceName} 服务。`);
      }

      throw new Error(`${serviceName} service start is not implemented yet.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to start service ${serviceName}:`, error);
      return {
        name: serviceName,
        state: 'stopped',
        details: message,
      } satisfies ServiceStatus;
    }
  });

  ipcMain.handle('services:stop', async (_event, serviceName: ServiceName) => {
    try {
      if (serviceName === 'yggdrasil') {
        await options.onBeforeStopYggdrasil();
        const res = await options.stopYggdrasil();
        options.onAfterStopYggdrasil();
        return res;
      }

      if (serviceName === 'web') {
        return await options.stopWebService();
      }

      if (serviceName === 'ipfs') {
        return await options.stopIpfsService();
      }

      const ygg = options.getYggdrasilStatus();
      if (ygg.state !== 'running') {
        throw new Error(`Yggdrasil 未运行，无法停止 ${serviceName} 服务。`);
      }
      throw new Error(`${serviceName} service stop is not implemented yet.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to stop service ${serviceName}:`, error);
      return {
        name: serviceName,
        state: 'stopped',
        details: message,
      } satisfies ServiceStatus;
    }
  });

  ipcMain.handle('services:openDir', async (_event, serviceName: ServiceName) => {
    try {
      if (serviceName === 'web') {
        const dirPath = options.getWebRootDir();
        ensureDirExists(dirPath);
        await shell.openPath(dirPath);
        return { ok: true, path: dirPath };
      }

      if (serviceName === 'ipfs') {
        const dirPath = options.getIpfsRepoDir();
        ensureDirExists(dirPath);
        await shell.openPath(dirPath);
        return { ok: true, path: dirPath };
      }

      return { ok: false, error: `openDir not supported for ${serviceName}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`services:openDir failed: ${serviceName}`, error);
      return { ok: false, error: message };
    }
  });
};
