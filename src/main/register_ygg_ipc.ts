import { ipcMain } from 'electron';

import type {
  YggdrasilCtlCommand,
  YggdrasilCtlResult,
} from './yggdrasil_types';

type LoggerLike = {
  error: (...args: unknown[]) => void;
};

export const registerYggIpc = (options: {
  logger: LoggerLike;
  getYggdrasilStatus: () => { state: 'running' | 'stopped'; details?: string };
  getYggdrasilIPv6AddressOrThrow: () => Promise<string>;
  listPublicPeers: () => unknown;
  getPublicPeerSelection: () => string[];
  getAutoPeerStatus: () => unknown;
  applyPublicPeerSelection: (peers: string[]) => Promise<{
    publicPeers: string[];
    autoPeerStatus: unknown;
  }>;
  applyAutoPeerConfig: (input: unknown) => Promise<{
    config: unknown;
    status: unknown;
  }>;
  reconcileAutoPeerNow: () => Promise<unknown>;
  loadWebsiteIndex: () => Promise<unknown>;
  runYggdrasilCtl: (command: YggdrasilCtlCommand) => Promise<YggdrasilCtlResult>;
  getYggdrasilConfig: () => { ifMtu: number; tcpOnly: boolean; p2pEnabled: boolean; yamuxStreamWindowKb: number; quicOnly: boolean; preferIpv6: boolean };
  setYggdrasilConfig: (input: { ifMtu?: number; tcpOnly?: boolean; p2pEnabled?: boolean; yamuxStreamWindowKb?: number; quicOnly?: boolean; preferIpv6?: boolean }) => unknown;
}): void => {
  ipcMain.handle('ygg:getIPv6', async () => {
    const ygg = options.getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error('Yggdrasil 未运行，无法获取 IPv6 地址。');
    }

    return await options.getYggdrasilIPv6AddressOrThrow();
  });

  ipcMain.handle('ygg:publicPeers:list', async () => {
    return options.listPublicPeers();
  });

  ipcMain.handle('ygg:publicPeers:getSelection', async () => {
    return options.getPublicPeerSelection();
  });

  ipcMain.handle('ygg:autoPeer:getStatus', async () => {
    return options.getAutoPeerStatus();
  });

  ipcMain.handle(
    'ygg:publicPeers:setSelection',
    async (_event, peers: unknown) => {
      if (!Array.isArray(peers)) {
        throw new Error('参数无效：peers 必须是数组');
      }

      const normalized: string[] = [];
      const seen = new Set<string>();
      for (const value of peers) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        normalized.push(trimmed);
        seen.add(trimmed);
        if (normalized.length >= 10) break;
      }

      if (normalized.length > 10) {
        throw new Error('请选择 0~10 个 peer');
      }

      const result = await options.applyPublicPeerSelection(normalized);
      return {
        ok: true,
        publicPeers: result.publicPeers,
        autoPeerStatus: result.autoPeerStatus,
      };
    },
  );

  ipcMain.handle('ygg:autoPeer:updateConfig', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('参数无效：auto peer 配置必须是对象');
    }

    const result = await options.applyAutoPeerConfig(input);
    return {
      ok: true,
      config: result.config,
      status: result.status,
    };
  });

  ipcMain.handle('ygg:autoPeer:reconcileNow', async () => {
    return await options.reconcileAutoPeerNow();
  });

  ipcMain.handle('ygg:index:load', async () => {
    return await options.loadWebsiteIndex();
  });

  ipcMain.handle(
    'yggdrasilctl:run',
    async (_event, command: YggdrasilCtlCommand) => {
      try {
        const ygg = options.getYggdrasilStatus();
        if (command !== 'list' && ygg.state !== 'running') {
          throw new Error(
            'Yggdrasil 未运行，无法获取状态。请先在首页启动 Yggdrasil。',
          );
        }

        return await options.runYggdrasilCtl(command);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.error(`yggdrasilctl failed: command=${command}`, error);
        return {
          ok: false,
          command,
          exitCode: null,
          stdout: '',
          stderr: message,
          durationMs: 0,
        } satisfies YggdrasilCtlResult;
      }
    },
  );

  ipcMain.handle('ygg:config:get', async () => {
    return options.getYggdrasilConfig();
  });

  ipcMain.handle('ygg:config:set', async (_event, input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('参数无效：yggdrasil 配置必须是对象');
    }

    const { ifMtu, tcpOnly, p2pEnabled, yamuxStreamWindowKb, quicOnly, preferIpv6 } = input as Record<string, unknown>;
    const payload: { ifMtu?: number; tcpOnly?: boolean; p2pEnabled?: boolean; yamuxStreamWindowKb?: number; quicOnly?: boolean; preferIpv6?: boolean } = {};
    if (ifMtu !== undefined) payload.ifMtu = Number(ifMtu);
    if (tcpOnly !== undefined) payload.tcpOnly = Boolean(tcpOnly);
    if (p2pEnabled !== undefined) payload.p2pEnabled = Boolean(p2pEnabled);
    if (yamuxStreamWindowKb !== undefined) payload.yamuxStreamWindowKb = Number(yamuxStreamWindowKb);
    if (quicOnly !== undefined) payload.quicOnly = Boolean(quicOnly);
    if (preferIpv6 !== undefined) payload.preferIpv6 = Boolean(preferIpv6);

    return options.setYggdrasilConfig(payload);
  });
};
