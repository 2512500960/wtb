import { dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';
import path from 'path';

export const registerMiscIpc = (options: {
  getWebRootDir: () => string;
  getWebActivity: () => unknown;
  setWebAssetsDir: (dir: string | null) => {
    web?: { assetsDir?: string | null };
  };
  getWebStatus: () => { state: 'running' | 'stopped'; details?: string };
  stopWebService: () => Promise<unknown>;
  startWebService: () => Promise<unknown>;
  listWebEntries: (requestedPath: string) => Array<unknown>;
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
  ) => Promise<unknown>;
  importManagedWebDirectory: (
    targetDirectoryPath: string,
    sourceDirectoryPath: string,
  ) => Promise<unknown>;
  replaceManagedWebFile: (
    requestedPath: string,
    sourceFilePath: string,
  ) => Promise<unknown>;
  deleteManagedWebEntry: (requestedPath: string) => Promise<unknown> | unknown;
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

  ipcMain.handle('wtb:web:setDir', async (_event, dir: string | null) => {
    try {
      const result = options.setWebAssetsDir(
        dir && typeof dir === 'string' ? dir : null,
      );
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
        const result = await options.importManagedWebFiles(
          targetDirectoryPath,
          selection.filePaths,
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
    'wtb:web:pickAndImportDirectory',
    async (_event, targetDirectoryPath: string) => {
      try {
        const selection = await dialog.showOpenDialog({
          properties: ['openDirectory'],
        });
        if (selection.canceled || !selection.filePaths.length) {
          return { ok: false, canceled: true };
        }
        const result = await options.importManagedWebDirectory(
          targetDirectoryPath,
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
