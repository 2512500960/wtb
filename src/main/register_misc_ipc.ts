import { dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';
import path from 'path';

type TaskProgressPayload = {
  operation:
    | 'import-files'
    | 'import-directory'
    | 'migrate-web-content'
    | 'migrate-repo';
  stage: 'running' | 'completed' | 'failed';
  current: number;
  total: number;
  currentBytes?: number;
  totalBytes?: number;
  message: string;
};

export const registerMiscIpc = (options: {
  getWebRootDir: () => string;
  getWebRuntimeSettings: () => unknown;
  setWebAutoStartEnabled: (enabled: boolean) => Promise<unknown> | unknown;
  setYggSitePreheaterEnabled: (enabled: boolean) => Promise<unknown> | unknown;
  getWebActivity: () => unknown;
  getWebCompatibilityStatus: () => Promise<unknown>;
  setWebAssetsDir: (dir: string | null) => {
    web?: { assetsDir?: string | null };
  };
  prepareWebRootDir: () => Promise<void>;
  getWebStatus: () => { state: 'running' | 'stopped'; details?: string };
  stopWebService: () => Promise<unknown>;
  startWebService: () => Promise<unknown>;
  listWebEntries: (requestedPath: string) => Array<unknown>;
  listAllWebEntries: () => Array<unknown>;
  convertWebFileToIpfsSource: (
    requestedPath: string,
    options?: { removeLocalFile?: boolean },
  ) => Promise<unknown>;
  syncWebContentWithIpfs: (options?: { thresholdBytes?: number }) => Promise<unknown>;
  createManagedWebDirectory: (
    parentPath: string,
    directoryName: string,
  ) => Promise<unknown> | unknown;
  importManagedWebFiles: (
    targetDirectoryPath: string,
    sourceFilePaths: string[],
    onProgress?: (progress: Omit<TaskProgressPayload, 'operation' | 'stage'>) => void,
  ) => Promise<unknown>;
  importManagedWebDirectory: (
    targetDirectoryPath: string,
    sourceDirectoryPath: string,
    onProgress?: (progress: Omit<TaskProgressPayload, 'operation' | 'stage'>) => void,
  ) => Promise<unknown>;
  replaceManagedWebFile: (
    requestedPath: string,
    sourceFilePath: string,
  ) => Promise<unknown>;
  renameManagedWebEntry: (
    requestedPath: string,
    newName: string,
  ) => Promise<unknown> | unknown;
  pasteManagedWebEntries: (
    requestedPaths: string[],
    destinationDirectoryPath: string,
    operationType: 'copy' | 'move',
  ) => Promise<unknown> | unknown;
  migrateWebContentToManagedIpfs: (
    onProgress?: (progress: Omit<TaskProgressPayload, 'operation' | 'stage'>) => void,
  ) => Promise<unknown>;
  deleteManagedWebEntry: (requestedPath: string) => Promise<unknown> | unknown;
  notifyTaskProgress: (payload: TaskProgressPayload) => void;
}): void => {
  ipcMain.handle('wtb:web:getDir', async () => {
    try {
      return { ok: true, path: options.getWebRootDir() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:getActivity', async () => {
    try {
      return options.getWebActivity();
    } catch (error) {
      return {
        activeWindowMinutes: 10,
        activeClients: [],
        recentRequests: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:getRuntimeSettings', async () => {
    try {
      return {
        ok: true,
        data: options.getWebRuntimeSettings(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:setAutoStartEnabled', async (_event, enabled: boolean) => {
    try {
      await options.setWebAutoStartEnabled(Boolean(enabled));
      return {
        ok: true,
        data: options.getWebRuntimeSettings(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:setPreheaterEnabled', async (_event, enabled: boolean) => {
    try {
      await options.setYggSitePreheaterEnabled(Boolean(enabled));
      return {
        ok: true,
        data: options.getWebRuntimeSettings(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:getCompatibilityStatus', async () => {
    try {
      return {
        ok: true,
        status: await options.getWebCompatibilityStatus(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('wtb:web:setDir', async (_event, dir: string | null) => {
    try {
      const result = options.setWebAssetsDir(
        dir && typeof dir === 'string' ? dir : null,
      );
      await options.prepareWebRootDir();
      const webStatus = options.getWebStatus();
      if (webStatus.state === 'running') {
        await options.stopWebService();
        await options.startWebService();
      }
      return { ok: true, path: result.web?.assetsDir ?? null };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    'wtb:web:listEntries',
    async (_event, requestedPath: string = '/') => {
      try {
        return {
          ok: true,
          path: requestedPath || '/',
          entries: options.listWebEntries(requestedPath || '/'),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle('wtb:web:listAllEntries', async () => {
    try {
      return {
        ok: true,
        entries: options.listAllWebEntries(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    'wtb:web:convertFileToIpfsSource',
    async (
      _event,
      requestedPath: string,
      conversionOptions?: { removeLocalFile?: boolean },
    ) => {
      try {
        const result = await options.convertWebFileToIpfsSource(
          requestedPath,
          conversionOptions,
        );
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          await options.stopWebService();
          await options.startWebService();
        }
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:syncContentWithIpfs',
    async (_event, syncOptions?: { thresholdBytes?: number }) => {
      try {
        const result = await options.syncWebContentWithIpfs(syncOptions);
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          await options.stopWebService();
          await options.startWebService();
        }
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:createDirectory',
    async (_event, parentPath: string, directoryName: string) => {
      try {
        const result = await options.createManagedWebDirectory(
          parentPath,
          directoryName,
        );
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:pickAndImportFiles',
    async (_event, targetDirectoryPath: string) => {
      try {
        const selection = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
        });
        if (selection.canceled || !selection.filePaths.length) {
          return { ok: false, canceled: true };
        }
        options.notifyTaskProgress({
          operation: 'import-files',
          stage: 'running',
          current: 0,
          total: selection.filePaths.length,
          message: '正在准备上传文件…',
        });
        const result = await options.importManagedWebFiles(
          targetDirectoryPath,
          selection.filePaths,
          (progress) => {
            options.notifyTaskProgress({
              operation: 'import-files',
              stage: 'running',
              ...progress,
            });
          },
        );
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          options.notifyTaskProgress({
            operation: 'import-files',
            stage: 'running',
            current: selection.filePaths.length,
            total: selection.filePaths.length,
            message: '文件已导入，正在重启 Web 服务…',
          });
          await options.stopWebService();
          await options.startWebService();
        }
        options.notifyTaskProgress({
          operation: 'import-files',
          stage: 'completed',
          current: selection.filePaths.length,
          total: selection.filePaths.length,
          message: '文件上传完成。',
        });
        return { ok: true, result };
      } catch (error) {
        options.notifyTaskProgress({
          operation: 'import-files',
          stage: 'failed',
          current: 0,
          total: 0,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:pickAndImportDirectory',
    async (_event, targetDirectoryPath: string) => {
      try {
        const selection = await dialog.showOpenDialog({
          properties: ['openDirectory'],
        });
        if (selection.canceled || !selection.filePaths.length) {
          return { ok: false, canceled: true };
        }
        options.notifyTaskProgress({
          operation: 'import-directory',
          stage: 'running',
          current: 0,
          total: 0,
          message: '正在准备导入目录…',
        });
        const result = await options.importManagedWebDirectory(
          targetDirectoryPath,
          selection.filePaths[0],
          (progress) => {
            options.notifyTaskProgress({
              operation: 'import-directory',
              stage: 'running',
              ...progress,
            });
          },
        );
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          options.notifyTaskProgress({
            operation: 'import-directory',
            stage: 'running',
            current: 1,
            total: 1,
            message: '目录已导入，正在重启 Web 服务…',
          });
          await options.stopWebService();
          await options.startWebService();
        }
        options.notifyTaskProgress({
          operation: 'import-directory',
          stage: 'completed',
          current: 1,
          total: 1,
          message: '目录导入完成。',
        });
        return { ok: true, result };
      } catch (error) {
        options.notifyTaskProgress({
          operation: 'import-directory',
          stage: 'failed',
          current: 0,
          total: 0,
          message: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:replaceFile',
    async (_event, requestedPath: string) => {
      try {
        const selection = await dialog.showOpenDialog({
          properties: ['openFile'],
        });
        if (selection.canceled || !selection.filePaths.length) {
          return { ok: false, canceled: true };
        }
        const result = await options.replaceManagedWebFile(
          requestedPath,
          selection.filePaths[0],
        );
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          await options.stopWebService();
          await options.startWebService();
        }
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle('wtb:web:deleteEntry', async (_event, requestedPath: string) => {
    try {
      const result = await options.deleteManagedWebEntry(requestedPath);
      const webStatus = options.getWebStatus();
      if (webStatus.state === 'running') {
        await options.stopWebService();
        await options.startWebService();
      }
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle(
    'wtb:web:renameEntry',
    async (_event, requestedPath: string, newName: string) => {
      try {
        const result = await options.renameManagedWebEntry(requestedPath, newName);
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          await options.stopWebService();
          await options.startWebService();
        }
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle(
    'wtb:web:pasteEntries',
    async (
      _event,
      requestedPaths: string[],
      destinationDirectoryPath: string,
      operationType: 'copy' | 'move',
    ) => {
      try {
        const result = await options.pasteManagedWebEntries(
          requestedPaths,
          destinationDirectoryPath,
          operationType,
        );
        const webStatus = options.getWebStatus();
        if (webStatus.state === 'running') {
          await options.stopWebService();
          await options.startWebService();
        }
        return { ok: true, result };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );

  ipcMain.handle('wtb:web:migrateToManagedIpfs', async () => {
    try {
      options.notifyTaskProgress({
        operation: 'migrate-web-content',
        stage: 'running',
        current: 0,
        total: 0,
        message: '正在扫描本地站点内容…',
      });
      const result = await options.migrateWebContentToManagedIpfs((progress) => {
        options.notifyTaskProgress({
          operation: 'migrate-web-content',
          stage: 'running',
          ...progress,
        });
      });
      const webStatus = options.getWebStatus();
      if (webStatus.state === 'running') {
        options.notifyTaskProgress({
          operation: 'migrate-web-content',
          stage: 'running',
          current: 1,
          total: 1,
          message: '迁移完成，正在重启 Web 服务…',
        });
        await options.stopWebService();
        await options.startWebService();
      }
      options.notifyTaskProgress({
        operation: 'migrate-web-content',
        stage: 'completed',
        current: 1,
        total: 1,
        message: '站点内容迁移完成。',
      });
      return { ok: true, result };
    } catch (error) {
      options.notifyTaskProgress({
        operation: 'migrate-web-content',
        stage: 'failed',
        current: 0,
        total: 0,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('dialog:selectDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });
      if (
        result.canceled ||
        !result.filePaths ||
        result.filePaths.length === 0
      ) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('logs:getMainLogPath', async () => {
    try {
      const file = log.transports.file.getFile();
      const logPath = file && file.path ? file.path : null;
      if (!logPath) {
        return { ok: false, error: '日志文件路径不可用' };
      }
      return { ok: true, path: logPath };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('logs:openContainingFolder', async () => {
    try {
      const file = log.transports.file.getFile();
      const logPath = file && file.path ? file.path : null;
      if (!logPath) {
        return { ok: false, error: '日志文件路径不可用' };
      }

      try {
        shell.showItemInFolder(logPath);
      } catch {
        try {
          await shell.openPath(path.dirname(logPath));
        } catch {
          // ignore
        }
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
};

export default registerMiscIpc;
