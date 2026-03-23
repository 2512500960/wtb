type ElectronHandler = import('../main/preload').ElectronHandler;

export {};

declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    electron: ElectronHandler;
  }
}
