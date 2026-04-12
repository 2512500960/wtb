/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import {
  app,
  BrowserWindow,
  session,
} from 'electron';
import log from 'electron-log';
import fs from 'fs';
import { registerAppLifecycle } from './app_lifecycle';
import { BrowserWindowCoordinator } from './browser_windows';
import { AnnouncementsCoordinator } from './announcements_coordinator';
import { EmbeddedStaticServer } from './embedded_static_server';
import { EmbeddedAppsCoordinator } from './embedded_apps';
import { IpfsSidecarManager } from './ipfs_manager';
import {
  configureMainProcessDebugging,
  createMainWindow,
} from './main_window';
import { registerAnnouncementsIpc } from './register_announcements_ipc';
import { registerBrowserIpc } from './register_browser_ipc';
import { registerChatIpc } from './register_chat_ipc';
import { registerEmbeddedAppsIpc } from './register_embedded_apps_ipc';
import { registerIpfsIpc } from './register_ipfs_ipc';
import { registerMiscIpc } from './register_misc_ipc';
import { registerRemoteResourcesIpc } from './register_remote_resources_ipc';
import { registerServiceIpc } from './register_service_ipc';
import { registerYggIpc } from './register_ygg_ipc';
import { ensureDirExists } from './fs_utils';
import {
  createManagedWebDirectory,
  deleteManagedWebEntry,
  convertLocalFileToIpfsSource,
  importManagedWebDirectory,
  importManagedWebFiles,
  listAllWebContentEntries,
  listWebContentDirectoryEntries,
  migrateWebContentToManagedIpfs,
  pasteManagedWebEntries,
  renameManagedWebEntry,
  replaceManagedWebFile,
  syncWebContentWithIpfs,
} from './web_content_sources';
import type {
  YggdrasilCtlCommand,
  YggdrasilCtlResult,
} from './yggdrasil_types';
import {
  type ServiceStatus,
} from './service_types';
import { WebServiceManager } from './web_service_manager';
import { ensureMediaDirs } from './mediaServer';
import {
  ensureDefaultWebAssets,
  inspectLegacyWebCompatibility,
} from './web_assets';
import { YggdrasilManager } from './yggdrasil_manager';
import { YggPeerCoordinator } from './ygg_peer_coordinator';
import { WEBSITE_INDEX_ED25519_PUBLIC_KEY_PEM } from './website_index_pubkey';
import { WebsiteIndexService } from './website_index_service';
import { loadBundledPublicPeers } from './public_ygg_peers';
import { startPublicNodesUpdater } from './public_nodes_updater';
import { yggdrasilBootstrapNodes } from './yggdrasil_bootstrap_nodes';
import {
  getWtbDataDir,
  getWtbConfig,
  setWtbYggdrasilAutoPeerManagerConfig,
  setWtbYggdrasilPublicPeers,
  setWtbWebAssetsDir,
} from './wtb_config';
import { YggdrasilPeerAutoManager } from './yggdrasil_peer_auto_manager';
import {
  Libp2pGroupChatService,
  type ChatMessage,
} from './libp2p_group_chat';
// import { ServiceAnnouncementsManager } from './service_announcements'; // 已切换到 HTTP pull 模式
import { ServiceSyncHttpManager } from './service_sync_http';

let mainWindow: BrowserWindow | null = null;

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

// NOTE: Do NOT force a global Chromium locale via `--lang`.
// It is process-wide and would override per-window Accept-Language settings,
// which we rely on (e.g. Element prefers English UI while the rest of the app
// prefers Chinese).

const CHINESE_ACCEPT_LANGUAGES = 'zh-CN,zh;q=0.9,en;q=0.6';

// Element: prefer English UI but keep Chinese as fallback.
const ELEMENT_ACCEPT_LANGUAGES = 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7';

const notifyTaskProgress = (payload: TaskProgressPayload): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('wtb:web:taskProgress', payload);
};

const forceAcceptLanguages = (
  s: Electron.Session,
  acceptLanguages: string,
): void => {
  try {
    s.setUserAgent(s.getUserAgent(), acceptLanguages);
  } catch {
    // ignore
  }
};

const forceChineseAcceptLanguage = (s: Electron.Session): void =>
  forceAcceptLanguages(s, CHINESE_ACCEPT_LANGUAGES);

const forceElementAcceptLanguage = (s: Electron.Session): void =>
  forceAcceptLanguages(s, ELEMENT_ACCEPT_LANGUAGES);

const cinnyStaticServer = new EmbeddedStaticServer();
const elementStaticServer = new EmbeddedStaticServer({
  fallbackConfigJson: true,
});
const yggdrasilManager = new YggdrasilManager({
  app,
  getWtbDataDir,
  getOwnerWindow: () => mainWindow,
  logger: log,
  bootstrapNodes: yggdrasilBootstrapNodes,
});
const ipfsManager = new IpfsSidecarManager({
  app,
  getWtbDataDir,
  logger: log,
  getYggdrasilAddress: async () => yggdrasilManager.getIPv6AddressOrThrow(),
});
const webServiceManager = new WebServiceManager({
  app,
  logger: log,
  getWtbDataDir,
  getYggdrasilStatus: () => yggdrasilManager.getStatus(),
  getYggdrasilAddress: async () => yggdrasilManager.getIPv6AddressOrThrow(),
  ipfsManager,
});
const browserWindows = new BrowserWindowCoordinator({
  app,
  logger: log,
  applyChineseAcceptLanguage: forceChineseAcceptLanguage,
});
const embeddedApps = new EmbeddedAppsCoordinator({
  app,
  logger: log,
  cinnyStaticServer,
  elementStaticServer,
  applyChineseAcceptLanguage: forceChineseAcceptLanguage,
  applyElementAcceptLanguage: forceElementAcceptLanguage,
});
const websiteIndexService = new WebsiteIndexService({
  sourceUrl:
    'http://[200:5948:48e2:97e3:8afb:40aa:b3ac:4d94]:5000/index.json',
  publicKeyPem: WEBSITE_INDEX_ED25519_PUBLIC_KEY_PEM,
});

// libp2p for groupchat is deprecated
// const groupChat = new Libp2pGroupChatService((msg: ChatMessage) => {
//   try {
//     if (mainWindow && !mainWindow.isDestroyed()) {
//       mainWindow.webContents.send('chat:message', msg);
//     }
//   } catch {
//     // ignore
//   }
// });

// 停用，ServiceAnnoucementsManager 所有自建服务需要用户自己去网页上登记和发现
// 服务同步管理器（HTTP pull 模式，替代原 pubsub 方案）
// const announcementsManager = new ServiceAnnouncementsManager(); // 旧 pubsub 实现
// const announcementsManager = new ServiceSyncHttpManager();
// const announcementsCoordinator = new AnnouncementsCoordinator({
//   announcementsManager,
//   groupChat,
//   getGroupChatSignPrivateKey: () =>
//     ((groupChat as any).master?.client?.signPrivateKeyDerB64 as string | undefined) ||
//     null,
//   getGroupChatNode: () => (groupChat as any).node,
//   getYggdrasilStatus: () => getYggdrasilStatus(),
//   logger: log,
// });
const yggPeerAutoManager = new YggdrasilPeerAutoManager({
  isYggdrasilRunning: () => getYggdrasilStatus().state === 'running',
  loadBundledPeers: () => loadBundledPublicPeers(yggdrasilManager.getBaseDir()),
  invokeCtl: (
    command: 'addpeer' | 'removepeer' | 'getpeersjson',
    args = [],
    options?: { timeoutMs?: number },
  ) =>
    yggdrasilManager.runCtlCommand(command, args, {
      timeoutMs: options?.timeoutMs,
      json: command === 'getpeersjson',
    }),
});
const yggPeerCoordinator = new YggPeerCoordinator({
  logger: log,
  getYggdrasilStatus: () => getYggdrasilStatus(),
  getConfig: () => getWtbConfig(),
  setManualPeers: setWtbYggdrasilPublicPeers,
  setAutoPeerConfig: setWtbYggdrasilAutoPeerManagerConfig,
  clearConfigPeersBestEffort: (reason: string) => {
    yggdrasilManager.clearConfigPeersBestEffort(reason);
  },
  loadBundledPublicPeers: () => loadBundledPublicPeers(yggdrasilManager.getBaseDir()),
  runCtlCommand: (
    command: 'addpeer' | 'removepeer' | 'getpeersjson',
    args = [],
    options?: { timeoutMs?: number; json?: boolean },
  ) => yggdrasilManager.runCtlCommand(command, args, options),
  autoPeerManager: yggPeerAutoManager,
});

const runYggdrasilCtlCommand = async (
  command: string,
  extraArgs: string[] = [],
  options?: { timeoutMs?: number; json?: boolean },
): Promise<YggdrasilCtlResult> => {
  return await yggdrasilManager.runCtlCommand(command, extraArgs, options);
};

// const scheduleAutoStartAnnouncementsIfNeeded = (reason: string): void => {
//   announcementsCoordinator.scheduleAutoStartIfNeeded(reason);
// };

// const startAnnouncementsOrThrow = async (): Promise<void> => {
//   await announcementsCoordinator.startOrThrow();
// };

// const tryAutoStartAnnouncements = async (reason: string): Promise<void> => {
//   await announcementsCoordinator.tryAutoStart(reason);
// };

const scheduleAutoStartYggPeerManagerIfNeeded = (reason: string): void => {
  yggPeerCoordinator.scheduleAutoStartIfNeeded(reason);
};

// const requireChatRunning = (): void => {
//   if (!groupChat.isRunning()) {
//     throw new Error('聊天未启动（请先启动群聊服务）');
//   }
// };

const getYggdrasilBaseDir = (): string => {
  return yggdrasilManager.getBaseDir();
};

const startYggdrasil = async (): Promise<ServiceStatus> => {
  const status = await yggdrasilManager.start();
  if (status.state === 'running') {
    await autoStartIpfsIfYggdrasilRunning('yggdrasil started');
  }
  return status;
};

const stopYggdrasil = async (): Promise<ServiceStatus> => {
  return await yggdrasilManager.stop();
};

// Attempt to stop yggdrasil without prompting the user (used on app quit).
// This will try a non-elevated Stop-Process and remove the pid file; if
// the process remains (likely because it was started elevated), we leave
// it running to avoid triggering a UAC prompt during quit.
const stopYggdrasilSilent = async (): Promise<void> => {
  await yggdrasilManager.stopSilently();
};

const getYggdrasilStatus = (): ServiceStatus => {
  return yggdrasilManager.getStatus();
};

const getAllServiceStatuses = (): ServiceStatus[] => {
  const ygg = getYggdrasilStatus();
  const webLockedDetails =
    ygg.state === 'running' ? undefined : '需要先启动 Yggdrasil 服务';
  return [
    ygg,
    ipfsManager.getServiceStatus(),
    (() => {
      const web = getWebStatus();
      if (web.state === 'running') return web;
      return {
        name: 'web',
        state: 'stopped',
        details: webLockedDetails ?? undefined,
      };
    })(),
  ];
};

const startIpfsService = async (): Promise<ServiceStatus> => {
  if (getYggdrasilStatus().state !== 'running') {
    throw new Error('Yggdrasil 未运行，无法启动 IPFS 服务。请先启动 Yggdrasil。');
  }
  return await ipfsManager.start();
};

const stopIpfsService = async (): Promise<ServiceStatus> => {
  return await ipfsManager.stop();
};

const getIpfsRepoDir = (): string => {
  return ipfsManager.getRepoDir();
};

let ipfsAutoStartAttempted = false;

const autoStartIpfsIfYggdrasilRunning = async (reason: string): Promise<void> => {
  if (getYggdrasilStatus().state !== 'running') {
    return;
  }
  if (ipfsAutoStartAttempted) return;
  ipfsAutoStartAttempted = true;

  await ipfsManager.start().catch((error) => {
    ipfsAutoStartAttempted = false;
    log.warn(`Failed to auto-start IPFS (${reason})`, error);
  });
};

const scheduleAutoStartIpfsIfNeeded = (reason: string): void => {
  void autoStartIpfsIfYggdrasilRunning(reason);
};

const runYggdrasilCtl = async (
  command: YggdrasilCtlCommand,
  timeoutMs: number = 5000,
): Promise<YggdrasilCtlResult> => {
  return await yggdrasilManager.runCtl(command, timeoutMs);
};

export async function getYggdrasilIPv6AddressOrThrow(): Promise<string> {
  return await yggdrasilManager.getIPv6AddressOrThrow();
}

function getWebStatus(): ServiceStatus {
  return webServiceManager.getStatus();
}

const getWebRootDir = (): string => {
  return webServiceManager.getRootDir();
};

const prepareWebRootDir = async (): Promise<void> => {
  const webRoot = getWebRootDir();
  ensureDirExists(webRoot);
  await ensureDefaultWebAssets(app, webRoot);
  ensureMediaDirs(webRoot);
};

const startWebService = async (): Promise<ServiceStatus> => {
  return await webServiceManager.start();
};

const stopWebService = async (): Promise<ServiceStatus> => {
  return await webServiceManager.stop();
};

registerServiceIpc({
  getAllServiceStatuses,
  scheduleAutoStartYggPeerManagerIfNeeded,
  startYggdrasil,
  stopYggdrasil,
  getYggdrasilStatus,
  startWebService,
  stopWebService,
  getWebRootDir,
  startIpfsService,
  stopIpfsService,
  getIpfsRepoDir,
  onBeforeStopYggdrasil: async () => {
    await yggPeerCoordinator.stopAutoPeerManager();
  },
  onAfterStopYggdrasil: async (status) => {
    if (status.state !== 'stopped') {
      return;
    }

    await stopIpfsService();
    ipfsAutoStartAttempted = false;
    // announcementsCoordinator.stop().catch(() => {
    //   // ignore
    // });
    // announcementsCoordinator.resetAutoStart();
  },
});

registerIpfsIpc({
  getDetailedStatus: async () => {
    return await ipfsManager.getDetailedStatus();
  },
  getStorageSummary: async () => {
    return await ipfsManager.getStorageSummary();
  },
  listSwarmPeers: async () => {
    return await ipfsManager.listSwarmPeers();
  },
  addPath: async (targetPath: string, options?: { wrapWithDirectory?: boolean }) => {
    return await ipfsManager.addPath(targetPath, options);
  },
  migrateRepo: async (
    targetDir: string,
    onProgress?: (progress: { current: number; total: number; message: string }) => void,
  ) => {
    return await ipfsManager.migrateRepo(targetDir, onProgress);
  },
  notifyTaskProgress,
});

registerRemoteResourcesIpc({
  ipfsManager,
});

registerBrowserIpc({
  browserWindows,
  logger: log,
});

registerEmbeddedAppsIpc({
  embeddedApps,
  logger: log,
});

registerMiscIpc({
  getWebRootDir,
  getWebActivity: () => webServiceManager.getActivitySnapshot(),
  getWebCompatibilityStatus: async () =>
    await inspectLegacyWebCompatibility(app, getWebRootDir()),
  setWebAssetsDir: setWtbWebAssetsDir,
  prepareWebRootDir,
  getWebStatus,
  stopWebService,
  startWebService,
  listWebEntries: (requestedPath: string) =>
    listWebContentDirectoryEntries({
      webRoot: getWebRootDir(),
      requestedPath,
    }),
  listAllWebEntries: () =>
    listAllWebContentEntries({
      webRoot: getWebRootDir(),
    }),
  convertWebFileToIpfsSource: async (
    requestedPath: string,
    options?: { removeLocalFile?: boolean },
  ) =>
    await convertLocalFileToIpfsSource({
      webRoot: getWebRootDir(),
      requestedPath,
      ipfsManager,
      removeLocalFile: options?.removeLocalFile,
    }),
  syncWebContentWithIpfs: async (options?: { thresholdBytes?: number }) =>
    await syncWebContentWithIpfs({
      webRoot: getWebRootDir(),
      ipfsManager,
      thresholdBytes: options?.thresholdBytes,
    }),
  createManagedWebDirectory: (parentPath: string, directoryName: string) =>
    createManagedWebDirectory({
      webRoot: getWebRootDir(),
      parentPath,
      directoryName,
    }),
  importManagedWebFiles: async (
    targetDirectoryPath: string,
    sourceFilePaths: string[],
    onProgress?: (progress: { current: number; total: number; message: string }) => void,
  ) =>
    await importManagedWebFiles({
      webRoot: getWebRootDir(),
      targetDirectoryPath,
      sourceFilePaths,
      ipfsManager,
      onProgress,
    }),
  importManagedWebDirectory: async (
    targetDirectoryPath: string,
    sourceDirectoryPath: string,
    onProgress?: (progress: { current: number; total: number; message: string }) => void,
  ) =>
    await importManagedWebDirectory({
      webRoot: getWebRootDir(),
      targetDirectoryPath,
      sourceDirectoryPath,
      ipfsManager,
      onProgress,
    }),
  replaceManagedWebFile: async (
    requestedPath: string,
    sourceFilePath: string,
  ) =>
    await replaceManagedWebFile({
      webRoot: getWebRootDir(),
      targetPath: requestedPath,
      sourceFilePath,
      ipfsManager,
    }),
  renameManagedWebEntry: (requestedPath: string, newName: string) =>
    renameManagedWebEntry({
      webRoot: getWebRootDir(),
      requestedPath,
      newName,
    }),
  pasteManagedWebEntries: (
    requestedPaths: string[],
    destinationDirectoryPath: string,
    operationType: 'copy' | 'move',
  ) =>
    pasteManagedWebEntries({
      webRoot: getWebRootDir(),
      requestedPaths,
      destinationDirectoryPath,
      operationType,
    }),
  migrateWebContentToManagedIpfs: async (
    onProgress?: (progress: { current: number; total: number; message: string }) => void,
  ) =>
    await migrateWebContentToManagedIpfs({
      webRoot: getWebRootDir(),
      ipfsManager,
      onProgress,
    }),
  deleteManagedWebEntry: async (requestedPath: string) =>
    await deleteManagedWebEntry({
      webRoot: getWebRootDir(),
      requestedPath,
      ipfsManager,
    }),
  notifyTaskProgress,
});

// registerChatIpc({
//   groupChat,
//   getYggdrasilStatus,
//   requireChatRunning,
// });

// registerAnnouncementsIpc({
//   getStatus: async () => await announcementsCoordinator.getStatus(),
//   getYggdrasilStatus,
//   tryAutoStartAnnouncements,
//   startAnnouncementsOrThrow,
//   stopAnnouncements: async () => {
//     await announcementsCoordinator.stop();
//   },
//   addLocalService: async (url: string, desc: string) =>
//     await announcementsCoordinator.addLocalService(url, desc),
//   removeLocalService: async (id: string) => {
//     await announcementsCoordinator.removeLocalService(id);
//   },
//   listLocalServices: async () =>
//     await announcementsCoordinator.listLocalServices(),
//   republishNow: async () => {
//     await announcementsCoordinator.republishNow();
//   },
//   listDiscoveredServices: async () =>
//     await announcementsCoordinator.listDiscoveredServices(),
// });

registerYggIpc({
  logger: log,
  getYggdrasilStatus,
  getYggdrasilIPv6AddressOrThrow,
  listPublicPeers: () => loadBundledPublicPeers(getYggdrasilBaseDir()),
  getPublicPeerSelection: () => yggPeerCoordinator.getPublicPeerSelection(),
  getAutoPeerStatus: () => yggPeerCoordinator.getAutoPeerStatus(),
  applyPublicPeerSelection: async (peers: string[]) =>
    await yggPeerCoordinator.applyPublicPeerSelection(peers),
  applyAutoPeerConfig: async (input: unknown) =>
    await yggPeerCoordinator.applyAutoPeerConfig(input),
  reconcileAutoPeerNow: async () => await yggPeerCoordinator.reconcileAutoPeerNow(),
  loadWebsiteIndex: async () => {
    const ygg = getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法加载网站索引。请先在首页启动 Yggdrasil。',
      );
    }
    return await websiteIndexService.loadIndex();
  },
  runYggdrasilCtl,
});

const initializeDefaultSession = (): void => {
  forceChineseAcceptLanguage(session.defaultSession);
};

const prepareStartup = (reason: string): void => {
  yggPeerCoordinator.prepareRuntimeConfigOnStartup(reason);
  // scheduleAutoStartAnnouncementsIfNeeded(reason);
  if (getYggdrasilStatus().state === 'running') {
    scheduleAutoStartIpfsIfNeeded(reason);
  }
};

const createAndTrackMainWindow = async (): Promise<void> => {
  const windowRef = await createMainWindow({
    app,
    onClosed: () => {
      mainWindow = null;
    },
  });
  mainWindow = windowRef;
};

const hasMainWindow = (): boolean => {
  return !!mainWindow && !mainWindow.isDestroyed();
};

configureMainProcessDebugging();

registerAppLifecycle({
  app,
  logger: log,
  initializeDefaultSession,
  prepareStartup,
  startPublicNodesUpdater,
  createAndTrackMainWindow,
  hasMainWindow,
  disposeBeforeQuit: () => {
    webServiceManager.dispose();
    cinnyStaticServer.stop();
    elementStaticServer.stop();
  },
  stopYggPeerAutoManagerOnQuit: async () => {
    await yggPeerCoordinator.stopAutoPeerManager();
  },
  stopAnnouncementsOnQuit: async () => {
    // await announcementsCoordinator.stop();
  },
  stopIpfsSilentlyOnQuit: async () => {
    await ipfsManager.stopSilently();
  },
  stopGroupChatOnQuit: async () => {
    // await groupChat.stop();
  },
  stopYggdrasilSilentlyOnQuit: async () => {
    await stopYggdrasilSilent();
  },
});
