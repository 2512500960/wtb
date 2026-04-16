import { ipcMain } from 'electron';

import type {
  ChatConversation,
  ChatMessage,
  ChatStatus,
} from './libp2p_group_chat';

type ChatStartDmInput = {
  peerId: string;
  title?: string;
  peerEncPublicKeyDerB64: string;
  peerSignPublicKeyDerB64: string;
};

type ChatGroupInput = {
  groupId: string;
  title: string;
};

type GroupChatLike = {
  status: () => ChatStatus;
  setDisplayName: (displayName: string) => void;
  start: () => Promise<ChatStatus>;
  stop: () => Promise<ChatStatus>;
  dial: (ma: string) => Promise<unknown>;
  subscribe: (topic: string) => Promise<unknown>;
  publish: (topic: string, message: string) => Promise<void>;
  listConversations: () => ChatConversation[];
  loadMessages: (convId: string, limit: number) => ChatMessage[];
  markRead: (convId: string) => void;
  createGroup: (title: string) => ChatConversation;
  joinGroup: (input: ChatGroupInput) => ChatConversation;
  startDm: (input: ChatStartDmInput) => ChatConversation;
  sendMessage: (convId: string, text: string) => Promise<void>;
};

const assertYggRunning = (
  getYggdrasilStatus: () => { state: 'running' | 'stopped'; details?: string },
  message: string,
): void => {
  if (getYggdrasilStatus().state !== 'running') {
    throw new Error(message);
  }
};

export const registerChatIpc = (options: {
  groupChat: GroupChatLike;
  getYggdrasilStatus: () => { state: 'running' | 'stopped'; details?: string };
  requireChatRunning: () => void;
}): void => {
  ipcMain.handle('chat:status', async () => {
    return options.groupChat.status() satisfies ChatStatus;
  });

  ipcMain.handle('chat:identity:get', async () => {
    return options.groupChat.status() satisfies ChatStatus;
  });

  ipcMain.handle(
    'chat:identity:setDisplayName',
    async (_event, displayName: string) => {
      options.groupChat.setDisplayName(displayName);
      return options.groupChat.status() satisfies ChatStatus;
    },
  );

  ipcMain.handle('chat:start', async () => {
    assertYggRunning(
      options.getYggdrasilStatus,
      'Yggdrasil 未运行，无法启动群聊。请先在首页启动 Yggdrasil。',
    );
    return await options.groupChat.start();
  });

  ipcMain.handle('chat:stop', async () => {
    return await options.groupChat.stop();
  });

  ipcMain.handle('chat:dial', async (_event, ma: string) => {
    assertYggRunning(
      options.getYggdrasilStatus,
      'Yggdrasil 未运行，无法连接 peer。请先在首页启动 Yggdrasil。',
    );
    return await options.groupChat.dial(ma);
  });

  ipcMain.handle('chat:subscribe', async (_event, topic: string) => {
    assertYggRunning(
      options.getYggdrasilStatus,
      'Yggdrasil 未运行，无法订阅 topic。请先在首页启动 Yggdrasil。',
    );
    return await options.groupChat.subscribe(topic);
  });

  ipcMain.handle(
    'chat:publish',
    async (_event, payload: { topic: string; message: string }) => {
      assertYggRunning(
        options.getYggdrasilStatus,
        'Yggdrasil 未运行，无法发送消息。请先在首页启动 Yggdrasil。',
      );
      await options.groupChat.publish(payload?.topic, payload?.message);
      return { ok: true };
    },
  );

  ipcMain.handle('chat:conversations:list', async () => {
    return options.groupChat.listConversations() satisfies ChatConversation[];
  });

  ipcMain.handle(
    'chat:conversation:load',
    async (_event, convId: string, limit?: number) => {
      return options.groupChat.loadMessages(
        convId,
        typeof limit === 'number' ? limit : 200,
      ) satisfies ChatMessage[];
    },
  );

  ipcMain.handle('chat:conversation:markRead', async (_event, convId: string) => {
    options.groupChat.markRead(convId);
    return { ok: true };
  });

  ipcMain.handle('chat:conversation:createGroup', async (_event, title: string) => {
    assertYggRunning(
      options.getYggdrasilStatus,
      'Yggdrasil 未运行，无法创建群组。请先在首页启动 Yggdrasil 并启动群聊。',
    );
    options.requireChatRunning();
    return options.groupChat.createGroup(title) satisfies ChatConversation;
  });

  ipcMain.handle(
    'chat:conversation:joinGroup',
    async (_event, input: ChatGroupInput) => {
      assertYggRunning(
        options.getYggdrasilStatus,
        'Yggdrasil 未运行，无法加入群组。请先在首页启动 Yggdrasil 并启动群聊。',
      );
      options.requireChatRunning();
      return options.groupChat.joinGroup(input) satisfies ChatConversation;
    },
  );

  ipcMain.handle(
    'chat:conversation:startDm',
    async (_event, input: ChatStartDmInput) => {
      assertYggRunning(
        options.getYggdrasilStatus,
        'Yggdrasil 未运行，无法创建私聊。请先在首页启动 Yggdrasil 并启动群聊。',
      );
      options.requireChatRunning();
      return options.groupChat.startDm(input) satisfies ChatConversation;
    },
  );

  ipcMain.handle(
    'chat:message:send',
    async (_event, convId: string, text: string) => {
      assertYggRunning(
        options.getYggdrasilStatus,
        'Yggdrasil 未运行，无法发送消息。请先在首页启动 Yggdrasil。',
      );
      options.requireChatRunning();
      await options.groupChat.sendMessage(convId, text);
      return { ok: true };
    },
  );
};
