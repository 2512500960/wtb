import type {
  AnnouncementSystemStatus,
  LocalServiceConfig,
  ServiceAnnouncementStatus,
} from '../types/announcements';
import type { ChatStatus } from './libp2p_group_chat';

type LoggerLike = {
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

type YggStatus = {
  state: 'running' | 'stopped';
  details?: string;
};

type AnnouncementsManagerLike = {
  getStatus: () => Promise<AnnouncementSystemStatus>;
  setIdentityKeys: (privateKeyDerB64: string, publicKeyDerB64: string) => void;
  start: (libp2pNode: unknown) => Promise<void>;
  stop: () => Promise<void>;
  addLocalService: (url: string, desc: string) => Promise<LocalServiceConfig>;
  removeLocalService: (id: string) => Promise<void>;
  listLocalServices: () => Promise<LocalServiceConfig[]>;
  republishNow: () => Promise<void>;
  listDiscoveredServices: () => Promise<ServiceAnnouncementStatus[]>;
};

type GroupChatLike = {
  isRunning: () => boolean;
  start: () => Promise<ChatStatus>;
  status: () => ChatStatus;
};

export class AnnouncementsCoordinator {
  private autoStartAttempted = false;

  constructor(
    private readonly options: {
      announcementsManager: AnnouncementsManagerLike;
      groupChat: GroupChatLike;
      getGroupChatSignPrivateKey: () => string | null;
      getGroupChatNode: () => unknown;
      getYggdrasilStatus: () => YggStatus;
      logger: LoggerLike;
    },
  ) {}

  async getStatus(): Promise<AnnouncementSystemStatus> {
    return await this.options.announcementsManager.getStatus();
  }

  scheduleAutoStartIfNeeded(reason: string): void {
    if (this.autoStartAttempted) return;
    const ygg = this.options.getYggdrasilStatus();
    if (ygg.state !== 'running') return;

    this.autoStartAttempted = true;
    setTimeout(() => {
      this.tryAutoStart(reason).catch(() => {
        // ignore
      });
    }, 0);
  }

  async startOrThrow(): Promise<void> {
    const ygg = this.options.getYggdrasilStatus();
    if (ygg.state !== 'running') {
      throw new Error(
        'Yggdrasil 未运行，无法启动服务公告。请先在首页启动 Yggdrasil。',
      );
    }

    let chatStatus: ChatStatus;
    if (!this.options.groupChat.isRunning()) {
      chatStatus = await this.options.groupChat.start();
    } else {
      chatStatus = this.options.groupChat.status();
    }

    if (chatStatus.identity) {
      this.options.announcementsManager.setIdentityKeys(
        this.options.getGroupChatSignPrivateKey() || '',
        chatStatus.identity.signPublicKeyDerB64,
      );
    }

    const libp2pNode = this.options.getGroupChatNode();
    if (!libp2pNode) {
      throw new Error('libp2p 节点未初始化');
    }

    await this.options.announcementsManager.start(libp2pNode);
  }

  async tryAutoStart(reason: string): Promise<void> {
    try {
      const status = await this.options.announcementsManager.getStatus();
      if (status.running) return;
      await this.startOrThrow();
      this.options.logger.info(`Auto-started service announcements: ${reason}`);
    } catch (error) {
      this.options.logger.debug(
        `Auto-start announcements skipped/failed: ${reason}`,
        error,
      );
    }
  }

  async stop(): Promise<void> {
    await this.options.announcementsManager.stop();
  }

  resetAutoStart(): void {
    this.autoStartAttempted = false;
  }

  async stopAndReset(): Promise<void> {
    await this.stop();
    this.resetAutoStart();
  }

  async addLocalService(url: string, desc: string): Promise<LocalServiceConfig> {
    return await this.options.announcementsManager.addLocalService(url, desc);
  }

  async removeLocalService(id: string): Promise<void> {
    await this.options.announcementsManager.removeLocalService(id);
  }

  async listLocalServices(): Promise<LocalServiceConfig[]> {
    return await this.options.announcementsManager.listLocalServices();
  }

  async republishNow(): Promise<void> {
    await this.options.announcementsManager.republishNow();
  }

  async listDiscoveredServices(): Promise<ServiceAnnouncementStatus[]> {
    return await this.options.announcementsManager.listDiscoveredServices();
  }
}
