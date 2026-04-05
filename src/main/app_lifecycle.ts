import type { App } from 'electron';

type LoggerLike = {
  warn: (...args: unknown[]) => void;
};

type RegisterAppLifecycleOptions = {
  app: App;
  logger: LoggerLike;
  initializeDefaultSession: () => void;
  prepareStartup: (reason: string) => void;
  startPublicNodesUpdater: () => void;
  createAndTrackMainWindow: () => Promise<void>;
  hasMainWindow: () => boolean;
  disposeBeforeQuit: () => void;
  stopYggPeerAutoManagerOnQuit: () => Promise<void>;
  stopAnnouncementsOnQuit: () => Promise<void>;
  stopIpfsSilentlyOnQuit: () => Promise<void>;
  stopGroupChatOnQuit: () => Promise<void>;
  stopYggdrasilSilentlyOnQuit: () => Promise<void>;
};

const ignoreRejected = (task: Promise<unknown>): void => {
  task.catch(() => {
    // ignore
  });
};

export const registerAppLifecycle = (
  options: RegisterAppLifecycleOptions,
): void => {
  options.app.on('before-quit', () => {
    try {
      options.disposeBeforeQuit();
    } catch {
      // ignore
    }

    ignoreRejected(options.stopYggPeerAutoManagerOnQuit());
    ignoreRejected(options.stopAnnouncementsOnQuit());
    ignoreRejected(options.stopIpfsSilentlyOnQuit());
    ignoreRejected(options.stopGroupChatOnQuit());
    ignoreRejected(options.stopYggdrasilSilentlyOnQuit());
  });

  options.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      options.app.quit();
    }
  });

  options.app
    .whenReady()
    .then(() => {
      try {
        options.initializeDefaultSession();
      } catch {
        // ignore
      }

      options.prepareStartup('app startup');

      try {
        options.startPublicNodesUpdater();
      } catch (error) {
        options.logger.warn('Failed to start public nodes updater', error);
      }

      options.createAndTrackMainWindow().catch(console.log);

      options.app.on('activate', () => {
        if (!options.hasMainWindow()) {
          options.createAndTrackMainWindow().catch(console.log);
        }
      });
    })
    .catch(console.log);
};
