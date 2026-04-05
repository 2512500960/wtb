import { ipcMain } from 'electron';

import type {
  AnnouncementSystemStatus,
  LocalServiceConfig,
  ServiceAnnouncementStatus,
} from '../types/announcements';

export const registerAnnouncementsIpc = (options: {
  getStatus: () => Promise<AnnouncementSystemStatus>;
  getYggdrasilStatus: () => { state: 'running' | 'stopped'; details?: string };
  tryAutoStartAnnouncements: (reason: string) => Promise<void>;
  startAnnouncementsOrThrow: () => Promise<void>;
  stopAnnouncements: () => Promise<void>;
  addLocalService: (url: string, desc: string) => Promise<LocalServiceConfig>;
  removeLocalService: (id: string) => Promise<void>;
  listLocalServices: () => Promise<LocalServiceConfig[]>;
  republishNow: () => Promise<void>;
  listDiscoveredServices: () => Promise<ServiceAnnouncementStatus[]>;
}): void => {
  ipcMain.handle('announcements:status', async () => {
    const status = (await options.getStatus()) satisfies AnnouncementSystemStatus;
    const ygg = options.getYggdrasilStatus();
    if (!status.running && ygg.state === 'running') {
      await options.tryAutoStartAnnouncements('announcements:status requested');
      return (await options.getStatus()) satisfies AnnouncementSystemStatus;
    }
    return status;
  });

  ipcMain.handle('announcements:start', async () => {
    await options.startAnnouncementsOrThrow();
    return (await options.getStatus()) satisfies AnnouncementSystemStatus;
  });

  ipcMain.handle('announcements:stop', async () => {
    await options.stopAnnouncements();
    return (await options.getStatus()) satisfies AnnouncementSystemStatus;
  });

  ipcMain.handle(
    'announcements:local:add',
    async (_event, input: { url: string; desc: string }) => {
      const status = await options.getStatus();
      if (!status.running) {
        await options.startAnnouncementsOrThrow();
      }
      return (await options.addLocalService(
        input.url,
        input.desc,
      )) satisfies LocalServiceConfig;
    },
  );

  ipcMain.handle('announcements:local:remove', async (_event, id: string) => {
    await options.removeLocalService(id);
    return { ok: true };
  });

  ipcMain.handle('announcements:local:list', async () => {
    return (await options.listLocalServices()) satisfies LocalServiceConfig[];
  });

  ipcMain.handle('announcements:republish', async () => {
    const status = await options.getStatus();
    if (!status.running) {
      await options.startAnnouncementsOrThrow();
    }
    await options.republishNow();
    return (await options.getStatus()) satisfies AnnouncementSystemStatus;
  });

  ipcMain.handle('announcements:discovered:list', async () => {
    return (await options.listDiscoveredServices()) satisfies ServiceAnnouncementStatus[];
  });
};
