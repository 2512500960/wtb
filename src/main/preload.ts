// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type SendChannels = 'ipc-example' | 'chat:message';
export type InvokeChannels =
  | 'services:getAll'
  | 'services:start'
  | 'services:stop'
  | 'services:openDir'
  | 'yggdrasilctl:run'
  | 'ygg:getIPv6'
  | 'ygg:index:load'
  | 'cinny:open'
  | 'open-in-app'
  | 'open-external'
  | 'chat:status'
  | 'chat:start'
  | 'chat:stop'
  | 'chat:dial'
  | 'chat:subscribe'
  | 'chat:publish';

// Chat app IPC (two-pane UI + msgstore)
export type ChatInvokeChannels =
  | 'chat:identity:get'
  | 'chat:identity:setDisplayName'
  | 'chat:conversations:list'
  | 'chat:conversation:load'
  | 'chat:conversation:markRead'
  | 'chat:conversation:createGroup'
  | 'chat:conversation:joinGroup'
  | 'chat:conversation:startDm'
  | 'chat:message:send';

// Service announcements IPC
export type AnnouncementInvokeChannels =
  | 'announcements:status'
  | 'announcements:start'
  | 'announcements:stop'
  | 'announcements:local:add'
  | 'announcements:local:remove'
  | 'announcements:local:list'
  | 'announcements:discovered:list';

export type AllInvokeChannels =
  | InvokeChannels
  | ChatInvokeChannels
  | AnnouncementInvokeChannels;
export type Channels = SendChannels;

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: SendChannels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    invoke(channel: AllInvokeChannels, ...args: unknown[]) {
      return ipcRenderer.invoke(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
