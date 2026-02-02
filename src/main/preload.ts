// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type SendChannels = 'ipc-example';
export type InvokeChannels = 'services:getAll' | 'services:start' | 'services:stop';
export type Channels = SendChannels;

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: SendChannels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    invoke(channel: InvokeChannels, ...args: unknown[]) {
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
